// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: signs outgoing Google Voice texts the way voice.google.com does, by running Google's BotGuard ("Waa")
// script in a hidden window. Google uses the signature to tell real web clients from bots. Same approach as
// mautrix-gvoice's Electron helper (pkg/connector/electron.mjs, AGPL-3.0): a voice.google.com page that may load
// nothing but the BotGuard script, in a throwaway session without the user's cookies.

import { createHash } from 'node:crypto';
import { BrowserWindow, session } from 'electron';
import { createLogger } from '../../ts/logging/log.std.ts';
import type { Waa } from './GoogleVoiceApi.main.ts';
import { createWaa, pingWaa } from './GoogleVoiceApi.main.ts';
import { chromeUserAgent } from './WebSession.main.ts';

const log = createLogger('AllIn/WaaSigner');

const PAGE_URL = 'https://voice.google.com/about';
/** The page and where it may redirect; every other request is blocked. */
const PAGE_URLS = [
  PAGE_URL,
  'https://voice.google.com/',
  'https://voice.google.com/u/0/about',
];
const PROGRAM_LIFETIME_MS = 55 * 60 * 1000;
const TIMEOUT_MS = 20_000;

let window: BrowserWindow | undefined;
let waa: Waa | undefined;
let waaCreatedAt = 0;
let allowedScriptUrl = '';
let queue: Promise<unknown> = Promise.resolve();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64');
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out`)), TIMEOUT_MS)
    ),
  ]);
}

function getWindow(): BrowserWindow {
  if (window && !window.isDestroyed()) {
    return window;
  }

  const ses = session.fromPartition('allin-waa');
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({
      cancel: !(
        details.url === allowedScriptUrl ||
        PAGE_URLS.includes(details.url) ||
        details.url.startsWith('devtools://')
      ),
    });
  });
  // voice.google.com's CSP would block the script tag we add.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'content-security-policy') {
        delete headers[name];
      }
    }
    callback({ responseHeaders: headers });
  });

  window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setUserAgent(chromeUserAgent());
  return window;
}

async function ensureLoaded(): Promise<{ win: BrowserWindow; waa: Waa }> {
  const win = getWindow();
  if (waa && Date.now() - waaCreatedAt < PROGRAM_LIFETIME_MS) {
    return { win, waa };
  }

  const newWaa = await createWaa();
  allowedScriptUrl = newWaa.interpreterUrl;
  await win.loadURL(PAGE_URL);
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ${JSON.stringify(newWaa.interpreterUrl)};
      script.onload = resolve;
      script.onerror = () => reject(new Error('BotGuard script did not load'));
      document.head.appendChild(script);
    })
  `);
  waa = newWaa;
  waaCreatedAt = Date.now();
  log.info('BotGuard program loaded');

  // Like the web app, report a blank signature once per program.
  void run(win, newWaa, undefined)
    .then(blank => (blank ? pingWaa(blank) : undefined))
    .catch(error => log.warn('Waa ping failed', error));

  return { win, waa: newWaa };
}

async function run(
  win: BrowserWindow,
  program: Waa,
  payload: Record<string, string> | undefined
): Promise<string | undefined> {
  const result = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      try {
        window[${JSON.stringify(program.globalName)}].a(${JSON.stringify(program.program)}, sign => {
          sign(result => resolve(result == null ? null : String(result)),
            [${payload ? JSON.stringify(payload) : 'undefined'}, undefined, undefined, undefined]);
        }, true, undefined, () => {});
      } catch (error) {
        reject(error);
      }
    })
  `);
  return typeof result === 'string' && result.length > 0 ? result : undefined;
}

/**
 * Returns the signature for a text to [threadId] (whose participants are [recipients]) with [transactionId],
 * or undefined if it couldn't be made.
 */
export function sign(
  threadId: string,
  recipients: Array<string>,
  transactionId: string
): Promise<string | undefined> {
  const payload = {
    message_ids: sha256(transactionId),
    destinations: sha256(recipients.join('|')),
    thread_id: sha256(threadId),
  };

  const next = queue.then(async () => {
    try {
      const { win, waa: program } = await withTimeout(ensureLoaded(), 'Loading BotGuard');
      return await withTimeout(run(win, program, payload), 'Signing');
    } catch (error) {
      log.warn('Could not sign message', error);
      waa = undefined;
      return undefined;
    }
  });
  queue = next;
  return next;
}

/** Loads the script ahead of time, so the first send doesn't wait for it. */
export function warmUp(): void {
  queue = queue.then(() =>
    withTimeout(ensureLoaded(), 'Loading BotGuard').catch(error =>
      log.warn('Warm-up failed', error)
    )
  );
}
