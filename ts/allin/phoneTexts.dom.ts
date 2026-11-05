// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: the user's phone texts (SMS, MMS, RCS), relayed from AllIn on their phone, which is paired with Google
// Messages. The two talk with Signal sync messages to the user's own devices (SyncMessage.allinRelay, JSON), so the
// texts are end-to-end encrypted between them. Nothing is stored here; it lives in memory while the app runs.

import { useSyncExternalStore } from 'react';
import { ContentHint } from '@signalapp/libsignal-client';
import * as Bytes from '../Bytes.std.ts';
import { SignalService as Proto } from '../protobuf/index.std.ts';
import { MessageSender } from '../textsecure/SendMessage.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { singleProtoJobQueue } from '../jobs/singleProtoJobQueue.preload.ts';
import { setAllInRelayHandler } from './relay.std.ts';

export type PhoneThread = Readonly<{
  id: string;
  name: string;
  snippet: string;
  dateMs: number;
  unread: boolean;
  outgoing: boolean;
  rcs: boolean;
}>;

export type PhoneAttachment = Readonly<{
  mediaId: string;
  key: string;
  mime: string;
  name: string;
  image: boolean;
}>;

export type PhoneText = Readonly<{
  id: string;
  conversationId: string;
  text: string;
  ts: number;
  out: boolean;
  failed: boolean;
  sending: boolean;
  sender: string | null;
  att: ReadonlyArray<PhoneAttachment>;
}>;

export type PhonePending = Readonly<{
  localId: string;
  conversationId: string | undefined;
  numbers: ReadonlyArray<string>;
  text: string;
  photoUrl: string | undefined;
  jpeg: Uint8Array<ArrayBuffer> | undefined;
  timestamp: number;
  status: 'sending' | 'sent' | 'failed';
}>;

export type PhoneTextsState = Readonly<{
  /** False until the phone has answered once. */
  available: boolean;
  /** The phone's description of its connection, or why it's off. */
  status: string;
  threads: ReadonlyArray<PhoneThread>;
  messages: Readonly<Record<string, ReadonlyArray<PhoneText>>>;
  pending: ReadonlyArray<PhonePending>;
  photos: Readonly<Record<string, string>>;
  /** Conversation the "new text" screen is waiting for, keyed by localId. */
  started: Readonly<Record<string, string>>;
}>;

/** Say hello again this often so the phone keeps sending changes (it stops after 8 hours of silence). */
const HELLO_INTERVAL_MS = 3 * 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 90_000;

let state: PhoneTextsState = {
  available: false,
  status: 'Waiting for your phone…',
  threads: [],
  messages: {},
  pending: [],
  photos: {},
  started: {},
};
const listeners = new Set<() => void>();
let started = false;
let openConversation: string | undefined;

function setState(changes: Partial<PhoneTextsState>): void {
  state = { ...state, ...changes };
  listeners.forEach(listener => listener());
}

export function getPhoneTexts(): PhoneTextsState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePhoneTexts(): PhoneTextsState {
  return useSyncExternalStore(subscribe, getPhoneTexts);
}

function sendToPhone(message: Record<string, unknown>): void {
  const syncMessage = MessageSender.padSyncMessage({
    allinRelay: Bytes.fromString(JSON.stringify(message)),
  });
  void singleProtoJobQueue.add({
    contentHint: ContentHint.Implicit,
    serviceId: itemStorage.user.getCheckedAci(),
    isSyncMessage: true,
    protoBase64: Bytes.toBase64(
      Proto.Content.encode({
        content: { syncMessage },
        pniSignatureMessage: null,
        senderKeyDistributionMessage: null,
      })
    ),
    type: 'allinRelay',
    urgent: false,
  });
}

function notify(text: PhoneText): void {
  if (text.out || document.hasFocus() || openConversation === text.conversationId) {
    return;
  }
  const thread = state.threads.find(t => t.id === text.conversationId);
  const title = thread?.name ?? 'Text message';
  try {
    const notification = new Notification(title, {
      body: text.text || (text.att.length ? 'Photo' : 'New message'),
      tag: `allin-phone-${text.conversationId}`,
      silent: false,
    });
    notification.onclick = () => {
      window.focus();
      phoneTextsOpenHandler?.(text.conversationId);
    };
  } catch {
    // Notifications may be unavailable; the row still shows the text.
  }
}

/** Set by store.dom.ts so a notification click can open the conversation. */
let phoneTextsOpenHandler: ((id: string) => void) | undefined;
export function setPhoneTextsOpenHandler(handler: (id: string) => void): void {
  phoneTextsOpenHandler = handler;
}

function onRelay(bytes: Uint8Array): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return;
  }
  switch (message.t) {
    case 'threads':
      setState({
        available: true,
        status: String(message.status ?? ''),
        threads: (message.threads as Array<PhoneThread>) ?? [],
      });
      break;
    case 'messages': {
      const id = String(message.id);
      const texts = (message.messages as Array<PhoneText>) ?? [];
      setState({
        available: true,
        messages: { ...state.messages, [id]: texts },
        pending: dropDelivered(id, texts),
      });
      break;
    }
    case 'message': {
      const text = message.message as PhoneText;
      const existing = state.messages[text.conversationId];
      if (existing) {
        const merged = [...existing.filter(m => m.id !== text.id), text].sort(
          (a, b) => a.ts - b.ts
        );
        setState({
          messages: { ...state.messages, [text.conversationId]: merged },
          pending: dropDelivered(text.conversationId, merged),
        });
      }
      notify(text);
      break;
    }
    case 'sent': {
      const localId = String(message.localId);
      const conversationId =
        typeof message.id === 'string' ? message.id : undefined;
      setState({
        pending: state.pending.map(p =>
          p.localId === localId
            ? {
                ...p,
                status: message.ok ? 'sent' : 'failed',
                conversationId: p.conversationId ?? conversationId,
              }
            : p
        ),
        started:
          conversationId && message.ok
            ? { ...state.started, [localId]: conversationId }
            : state.started,
      });
      if (message.ok && conversationId) {
        sendToPhone({ t: 'thread', id: conversationId });
      }
      break;
    }
    case 'media':
      if (typeof message.data === 'string') {
        setState({
          photos: {
            ...state.photos,
            [String(message.mediaId)]: `data:image/jpeg;base64,${message.data}`,
          },
        });
      }
      break;
    case 'off':
      setState({
        available: false,
        threads: [],
        status: String(message.reason ?? 'Phone texts are off on your phone.'),
      });
      break;
    default:
      break;
  }
}

/** Sent texts the phone now lists itself. */
function dropDelivered(
  conversationId: string,
  texts: ReadonlyArray<PhoneText>
): ReadonlyArray<PhonePending> {
  return state.pending.filter(
    p =>
      !(
        p.conversationId === conversationId &&
        p.status !== 'failed' &&
        texts.some(
          t => t.out && t.text === p.text && t.ts >= p.timestamp - 120_000
        )
      )
  );
}

export function loadPhoneConversation(id: string): void {
  sendToPhone({ t: 'thread', id });
}

export function markPhoneConversationRead(id: string): void {
  const thread = state.threads.find(t => t.id === id);
  if (thread?.unread) {
    setState({
      threads: state.threads.map(t => (t.id === id ? { ...t, unread: false } : t)),
    });
    sendToPhone({ t: 'read', id });
  }
}

export function setOpenPhoneConversation(id: string | undefined): void {
  openConversation = id;
}

export function requestPhonePhoto(attachment: PhoneAttachment): void {
  sendToPhone({
    t: 'media',
    mediaId: attachment.mediaId,
    key: attachment.key,
    mime: attachment.mime,
  });
}

function deliver(item: PhonePending): void {
  sendToPhone({
    t: item.conversationId ? 'send' : 'new',
    id: item.conversationId,
    numbers: item.numbers,
    localId: item.localId,
    text: item.text,
    jpeg: item.jpeg ? Bytes.toBase64(item.jpeg) : undefined,
  });
  setTimeout(() => {
    const current = state.pending.find(p => p.localId === item.localId);
    if (current?.status === 'sending') {
      setState({
        pending: state.pending.map(p =>
          p.localId === item.localId ? { ...p, status: 'failed' } : p
        ),
      });
    }
  }, SEND_TIMEOUT_MS);
}

/** Sends a text through the phone, into [conversationId] or (when undefined) to [numbers]. Returns its localId. */
export function sendPhoneText(
  conversationId: string | undefined,
  numbers: ReadonlyArray<string>,
  text: string,
  photo: { jpeg: Uint8Array<ArrayBuffer>; url: string } | undefined
): string {
  const item: PhonePending = {
    localId: `local-${Date.now()}-${Math.random()}`,
    conversationId,
    numbers,
    text,
    photoUrl: photo?.url,
    jpeg: photo?.jpeg,
    timestamp: Date.now(),
    status: 'sending',
  };
  setState({ pending: [...state.pending, item] });
  deliver(item);
  return item.localId;
}

export function retryPhoneText(localId: string): void {
  const item = state.pending.find(p => p.localId === localId);
  if (!item || item.status !== 'failed') {
    return;
  }
  setState({
    pending: state.pending.map(p =>
      p.localId === localId ? { ...p, status: 'sending' } : p
    ),
  });
  deliver(item);
}

/** Asks the phone for the conversation list; safe to call more than once. */
export function startPhoneTexts(): void {
  if (started) {
    return;
  }
  started = true;
  setAllInRelayHandler(onRelay);
  const hello = () => {
    try {
      sendToPhone({ t: 'hello' });
    } catch {
      // Not registered yet; the next hello tries again.
    }
  };
  setTimeout(hello, 5_000);
  setInterval(hello, HELLO_INTERVAL_MS);
}
