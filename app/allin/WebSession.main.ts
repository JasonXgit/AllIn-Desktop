// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: web sign-ins for AllIn's extra features (Google Voice, ESPN). Each service gets its own persistent Electron
// session, so its cookies never mix with Signal's and signing out of one doesn't touch the other.

import { BrowserWindow, session } from 'electron';
import type { Session } from 'electron';
import { createLogger } from '../../ts/logging/log.std.ts';

const log = createLogger('AllIn/WebSession');

/**
 * Google refuses to sign in "embedded" browsers that identify as Electron or Chrome, but accepts a Firefox user agent.
 * Only the sign-in window uses it; API calls look like Chrome (see chromeUserAgent).
 */
const SIGN_IN_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';

export function getSession(partition: string): Session {
  return session.fromPartition(partition);
}

/** This Electron's own user agent without the Electron and app markers, i.e. the matching Chrome's. */
export function chromeUserAgent(): string {
  return session.defaultSession
    .getUserAgent()
    .replace(/ Electron\/\S+/, '')
    .replace(/ AllIn\/\S+/, '')
    .replace(/ allin-desktop\/\S+/, '');
}

export async function getCookie(
  partition: string,
  url: string,
  name: string
): Promise<string | undefined> {
  const cookies = await getSession(partition).cookies.get({ url, name });
  return cookies[0]?.value;
}

/** The Cookie header a browser would send to [url]. */
export async function cookieHeader(
  partition: string,
  url: string
): Promise<string> {
  const cookies = await getSession(partition).cookies.get({ url });
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

export async function clearSession(partition: string): Promise<void> {
  await getSession(partition).clearStorageData();
}

/**
 * Opens [startUrl] in a sign-in window and resolves true once [isSignedIn] says so (the window then closes),
 * or false if the user closes the window first.
 */
export function signIn({
  partition,
  startUrl,
  title,
  parent,
  isSignedIn,
}: {
  partition: string;
  startUrl: string;
  title: string;
  parent: BrowserWindow | undefined;
  isSignedIn: (url: string) => Promise<boolean>;
}): Promise<boolean> {
  return new Promise(resolve => {
    const window = new BrowserWindow({
      width: 520,
      height: 760,
      title,
      parent,
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.webContents.setUserAgent(SIGN_IN_USER_AGENT);
    // Links that open new windows (help pages, etc.) stay inside the sign-in window.
    window.webContents.setWindowOpenHandler(({ url }) => {
      void window.loadURL(url);
      return { action: 'deny' };
    });

    let done = false;
    const check = async (url: string) => {
      if (done) {
        return;
      }
      try {
        if (await isSignedIn(url)) {
          done = true;
          log.info(`${title}: signed in`);
          resolve(true);
          window.close();
        }
      } catch (error) {
        log.warn(`${title}: sign-in check failed`, error);
      }
    };

    window.webContents.on('did-navigate', (_event, url) => void check(url));
    window.webContents.on('did-navigate-in-page', (_event, url) => void check(url));
    window.webContents.on('did-finish-load', () => void check(window.webContents.getURL()));
    window.on('closed', () => {
      if (!done) {
        done = true;
        resolve(false);
      }
    });

    void window.loadURL(startUrl);
  });
}
