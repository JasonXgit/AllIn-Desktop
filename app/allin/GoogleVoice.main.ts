// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: Google Voice in the main process: keeps the voice.google.com realtime channel open while signed in,
// tells the window when conversations change, and shows notifications for new incoming texts. Port of the
// Android app's GoogleVoiceMonitor / GoogleVoiceNotifications.

import { Notification } from 'electron';
import { createLogger } from '../../ts/logging/log.std.ts';
import type {
  GoogleVoiceThread,
  GoogleVoiceThreadSummary,
} from '../../ts/allin/types.std.ts';
import type { Message, Thread } from './GoogleVoiceApi.main.ts';
import {
  GoogleVoiceNotSignedInError,
  SMS_IN,
  SMS_OUT,
  chooseRealtimeServer,
  createRealtimeChannel,
  hasGoogleVoiceSession,
  listThreads,
  pollRealtimeChannel,
} from './GoogleVoiceApi.main.ts';
import { getSettings, updateSettings } from './settings.main.ts';

const log = createLogger('AllIn/GoogleVoice');

const LIVE_CHECK_MS = 5 * 60 * 1000;
const FALLBACK_CHECK_MS = 60 * 1000;
const RESUBSCRIBE_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

type Callbacks = {
  onChanged: () => void;
  onNotificationClick: (threadId: string) => void;
};

let callbacks: Callbacks | undefined;
let running = false;
let generation = 0;
let live = false;
let status = 'Not running';
let wakeCheck: (() => void) | undefined;
let lastFingerprint = '';
let openThreadId: string | undefined;
/** Names the window knows from Signal contacts, by phone number; used for notification titles. */
let knownNames: Record<string, string> = {};
const shownNotifications = new Map<string, Notification>();

export function getLiveStatus(): string {
  return status;
}

export function setOpenThread(threadId: string | undefined): void {
  openThreadId = threadId;
  if (threadId) {
    shownNotifications.get(threadId)?.close();
    shownNotifications.delete(threadId);
  }
}

export function setKnownNames(names: Record<string, string>): void {
  knownNames = { ...knownNames, ...names };
}

/** Asks for a check of the thread list soon, e.g. after a send or a realtime event. */
export function requestCheck(): void {
  wakeCheck?.();
}

const delay = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });

/** Starts or stops watching to match the sign-in state. Safe to call any time. */
export async function updateMonitor(cb?: Callbacks): Promise<void> {
  if (cb) {
    callbacks = cb;
  }
  const signedIn = await hasGoogleVoiceSession();
  if (signedIn && !running) {
    log.info('Starting');
    running = true;
    generation += 1;
    void checkLoop(generation);
    void realtimeLoop(generation);
  } else if (!signedIn && running) {
    log.info('Stopping');
    running = false;
    generation += 1;
    live = false;
    status = 'Not running';
    wakeCheck?.();
  }
}

async function checkLoop(gen: number): Promise<void> {
  while (gen === generation) {
    try {
      onThreads(await listThreads());
    } catch (error) {
      log.warn('Check failed', error);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>(resolve => {
      const timer = setTimeout(
        resolve,
        live ? LIVE_CHECK_MS : FALLBACK_CHECK_MS
      );
      wakeCheck = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

async function realtimeLoop(gen: number): Promise<void> {
  let failures = 0;
  while (gen === generation) {
    try {
      const gSessionId = await chooseRealtimeServer();
      const channelId = await createRealtimeChannel(gSessionId);
      const subscribedAt = Date.now();
      let ackId = 0;
      let reconnect = false;
      log.info('Realtime channel open');

      while (
        gen === generation &&
        !reconnect &&
        Date.now() - subscribedAt < RESUBSCRIBE_MS
      ) {
        // eslint-disable-next-line no-await-in-loop
        await pollRealtimeChannel(gSessionId, channelId, ackId, chunk => {
          for (const event of parseChunk(chunk)) {
            ackId = Math.max(ackId, event.arrayId);
            if (event.reconnect) {
              reconnect = true;
            } else if (!event.noop) {
              requestCheck();
            }
          }
        });
        if (!live) {
          log.info('Realtime channel connected');
        }
        live = true;
        failures = 0;
        status = 'Live: new texts arrive right away';
      }
    } catch (error) {
      live = false;
      if (error instanceof GoogleVoiceNotSignedInError) {
        log.warn('Signed out');
        status = 'Signed out by Google. Sign in again.';
        // eslint-disable-next-line no-await-in-loop
        await delay(MAX_BACKOFF_MS);
      } else {
        failures += 1;
        log.warn(`Realtime channel failed (${failures} in a row)`, error);
        status = 'Live updates unavailable, checking every minute';
        // eslint-disable-next-line no-await-in-loop
        await delay(Math.min(failures * 15_000, MAX_BACKOFF_MS));
      }
    }
  }
}

type ChannelEvent = { arrayId: number; noop: boolean; reconnect: boolean };

/**
 * A chunk is a JSON array of events, each `[arrayId, payload]`. Keep-alives are `[n, ["noop"]]`; a payload of
 * `[[data, [true]]]` asks the client to reconnect; anything else is a change worth checking for.
 */
function parseChunk(chunk: string): Array<ChannelEvent> {
  try {
    const entries = JSON.parse(chunk) as Array<unknown>;
    return entries.filter(Array.isArray).map(entry => {
      const payload = Array.isArray(entry[1]) ? entry[1] : undefined;
      const first = Array.isArray(payload?.[0]) ? payload[0] : undefined;
      const alt = Array.isArray(first?.[1]) ? first[1] : undefined;
      return {
        arrayId: typeof entry[0] === 'number' ? entry[0] : 0,
        noop: payload?.[0] === 'noop',
        reconnect: payload?.length === 1 && alt?.[0] === true,
      };
    });
  } catch (error) {
    log.warn('Could not parse realtime chunk', error);
    return [{ arrayId: 0, noop: false, reconnect: false }];
  }
}

export function snippet(message: Message): string {
  if (message.text) {
    return message.text;
  }
  if (message.MMS?.text) {
    return message.MMS.text;
  }
  return message.MMS?.attachments?.length ? 'Photo' : '';
}

const time = (message: Message) => Number(message.timestamp ?? 0);

export function toSummary(thread: Thread): GoogleVoiceThreadSummary | undefined {
  const latest = [...thread.messages].sort((a, b) => time(b) - time(a))[0];
  if (!latest) {
    return undefined;
  }
  return {
    threadId: thread.ID ?? '',
    googleNames: thread.contacts.map(contact => contact.name ?? ''),
    phoneNumbers: thread.phoneNumbers.length
      ? [...thread.phoneNumbers]
      : thread.contacts.map(contact => contact.phoneNumber ?? ''),
    snippet: snippet(latest),
    dateMs: time(latest),
    unread: !thread.read,
    lastMessageOutgoing: latest.type === SMS_OUT,
  };
}

export function toThread(thread: Thread): GoogleVoiceThread {
  return {
    threadId: thread.ID ?? '',
    read: Boolean(thread.read),
    phoneNumbers: [...thread.phoneNumbers],
    messages: thread.messages
      .filter(m => m.type === SMS_IN || m.type === SMS_OUT)
      .sort((a, b) => time(a) - time(b))
      .map(m => ({
        id: m.ID ?? '',
        text: m.text || m.MMS?.text || '',
        timestamp: time(m),
        outgoing: m.type === SMS_OUT,
        attachmentIds: (m.MMS?.attachments ?? [])
          .map(a => a.ID ?? '')
          .filter(id => id.length > 0),
      })),
  };
}

function displayName(thread: Thread): string {
  const names = (thread.phoneNumbers.length
    ? thread.phoneNumbers
    : thread.contacts.map(c => c.phoneNumber ?? '')
  ).map(number => {
    const google = thread.contacts.find(c => c.phoneNumber === number)?.name;
    return knownNames[number] || google || number;
  });
  return names.filter(Boolean).join(', ') || 'Google Voice';
}

/** Tells the window about changes, notifies for new incoming texts and closes notifications for read threads. */
function onThreads(threads: ReadonlyArray<Thread>): void {
  const texts = threads.filter(thread => thread.isText);

  const fingerprint = texts
    .map(t => `${t.ID}:${t.read}:${Math.max(0, ...t.messages.map(time))}`)
    .join('|');
  if (fingerprint !== lastFingerprint) {
    lastFingerprint = fingerprint;
    callbacks?.onChanged();
  }

  const settings = getSettings();
  const notifiedUpTo = settings.gvNotifiedUpTo;
  if (!notifiedUpTo) {
    // First run: don't notify for texts that arrived before notifications were set up.
    updateSettings({
      gvNotifiedUpTo: Math.max(
        Date.now(),
        ...threads.flatMap(t => t.messages.map(time))
      ),
    });
    return;
  }

  let newest = notifiedUpTo;
  for (const thread of texts) {
    const threadId = thread.ID ?? '';
    if (thread.read) {
      shownNotifications.get(threadId)?.close();
      shownNotifications.delete(threadId);
      continue;
    }
    const incoming = thread.messages
      .filter(m => m.type === SMS_IN && time(m) > notifiedUpTo)
      .sort((a, b) => time(a) - time(b));
    if (!incoming.length) {
      continue;
    }
    newest = Math.max(newest, ...incoming.map(time));
    if (threadId !== openThreadId && settings.gvNotifications) {
      show(threadId, displayName(thread), incoming.map(snippet));
    }
  }
  if (newest !== notifiedUpTo) {
    updateSettings({ gvNotifiedUpTo: newest });
  }
}

function show(threadId: string, title: string, lines: Array<string>): void {
  if (!Notification.isSupported()) {
    return;
  }
  shownNotifications.get(threadId)?.close();
  const notification = new Notification({
    title,
    subtitle: 'Google Voice',
    body: lines.filter(Boolean).join('\n') || 'New message',
  });
  notification.on('click', () => callbacks?.onNotificationClick(threadId));
  notification.show();
  shownNotifications.set(threadId, notification);
}
