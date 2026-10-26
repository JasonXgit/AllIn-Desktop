// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: Google Voice in the conversation pane of the Chats tab: an open Google Voice conversation (opened from
// its row in the chat list) and the "new Google Voice text" screen. Replies can be text and photos. Data comes
// from the main process (app/allin) through window.AllIn; nothing is stored.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import classNames from 'classnames';
import type { GoogleVoiceMessage, GoogleVoiceThread } from './types.std.ts';
import {
  formatNumber,
  openAllInPane,
  refreshGoogleVoice,
  threadName,
  useAllInState,
} from './store.dom.ts';

const MAX_PHOTO_DIMENSION = 1600;

type PendingMessage = {
  localId: string;
  text: string;
  photoUrl: string | undefined;
  jpeg: Uint8Array<ArrayBuffer> | undefined;
  timestamp: number;
  status: 'sending' | 'sent' | 'failed';
  serverId: string | undefined;
};

type Photo = { jpeg: Uint8Array<ArrayBuffer>; url: string };

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Shrinks a picked image to MMS size and re-encodes it as JPEG. */
async function prepareJpeg(file: File): Promise<Uint8Array<ArrayBuffer>> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
  });
  const scale = Math.min(
    1,
    MAX_PHOTO_DIMENSION / Math.max(bitmap.width, bitmap.height)
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.85, 0.7, 0.55]) {
    // eslint-disable-next-line no-await-in-loop
    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', quality)
    );
    if (blob && (blob.size <= 900 * 1024 || quality === 0.55)) {
      return new Uint8Array(await blob.arrayBuffer());
    }
  }
  throw new Error('Could not encode photo');
}

/** "+15551234567" from what the user typed, or undefined if it isn't a phone number. */
function toE164(input: string): string | undefined {
  const digits = input.replace(/[^\d+]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) {
    return digits;
  }
  const plain = digits.replace(/\+/g, '');
  if (plain.length === 10) {
    return `+1${plain}`;
  }
  if (plain.length === 11 && plain.startsWith('1')) {
    return `+${plain}`;
  }
  return undefined;
}

/** The box at the bottom: photo button, text field and send button. */
function Composer({
  onSend,
  onError,
}: {
  onSend: (text: string, photo: Photo | undefined) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [photo, setPhoto] = useState<Photo | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);

  const send = () => {
    const text = draft.trim();
    if (!text && !photo) {
      return;
    }
    onSend(text, photo);
    setDraft('');
    setPhoto(undefined);
  };

  return (
    <div className="AllInComposer">
      {photo && (
        <div className="AllInComposer__preview">
          <img src={photo.url} alt="Photo to send" />
          <button
            type="button"
            aria-label="Remove photo"
            onClick={() => setPhoto(undefined)}
          >
            ×
          </button>
        </div>
      )}
      <div className="AllInComposer__row">
        <button
          type="button"
          className="AllInComposer__attach"
          aria-label="Attach a photo"
          title="Attach a photo"
          onClick={() => fileInput.current?.click()}
        />
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={async e => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) {
              return;
            }
            try {
              const jpeg = await prepareJpeg(file);
              const url = URL.createObjectURL(
                new Blob([jpeg], { type: 'image/jpeg' })
              );
              setPhoto({ jpeg, url });
            } catch {
              onError('Could not use that photo.');
            }
          }}
        />
        <textarea
          className="AllInComposer__input"
          placeholder="Google Voice message"
          value={draft}
          rows={1}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className="AllInComposer__send"
          aria-label="Send"
          disabled={!draft.trim() && !photo}
          onClick={send}
        />
      </div>
    </div>
  );
}

function PaneHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="AllInConversation__header">
      <div>{title}</div>
      <div className="AllInConversation__subtitle">
        {subtitle ?? 'Google Voice · not end-to-end encrypted'}
      </div>
    </div>
  );
}

export function GoogleVoiceConversationPane({
  threadId,
}: {
  threadId: string;
}): JSX.Element {
  const { gvThreads, gvNames } = useAllInState();
  const summary = gvThreads.find(t => t.threadId === threadId);
  const [thread, setThread] = useState<GoogleVoiceThread | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState<ReadonlyArray<PendingMessage>>([]);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await window.AllIn.api.gvGetThread(threadId);
      if (!loaded) {
        return;
      }
      setThread(loaded);
      setError(undefined);
      // Once Google lists a message we sent, show Google's copy instead of ours.
      setPending(list =>
        list.filter(
          p =>
            !(
              p.status === 'sent' &&
              loaded.messages.some(
                m =>
                  m.id === p.serverId ||
                  (m.outgoing &&
                    m.text === p.text &&
                    m.timestamp >= p.timestamp - 120_000)
              )
            )
        )
      );
      if (!loaded.read) {
        await window.AllIn.api.gvMarkRead(threadId);
        void refreshGoogleVoice();
      }
    } catch {
      setError('Could not load this conversation.');
    }
  }, [threadId]);

  // Reload whenever the chat list sees this conversation change.
  useEffect(() => {
    void load();
  }, [load, summary?.dateMs, summary?.unread]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [thread, pending]);

  const recipients = thread?.phoneNumbers ?? summary?.phoneNumbers ?? [];
  const name = summary
    ? threadName(summary, gvNames)
    : recipients.map(n => gvNames[n] || formatNumber(n)).join(', ');

  const send = async (message: PendingMessage) => {
    try {
      const result = await window.AllIn.api.gvSend(
        threadId,
        recipients,
        message.text,
        message.jpeg
      );
      setPending(list =>
        list.map(p =>
          p.localId === message.localId
            ? { ...p, status: 'sent', serverId: result.messageId }
            : p
        )
      );
      await load();
      void refreshGoogleVoice();
    } catch {
      setPending(list =>
        list.map(p =>
          p.localId === message.localId ? { ...p, status: 'failed' } : p
        )
      );
    }
  };

  const retry = (message: PendingMessage) => {
    setPending(list =>
      list.map(p =>
        p.localId === message.localId ? { ...p, status: 'sending' } : p
      )
    );
    void send({ ...message, status: 'sending' });
  };

  return (
    <div className="AllInConversation">
      <PaneHeader title={name || 'Google Voice'} />
      <div className="AllInConversation__messages">
        {error && !thread && <div className="AllInTab__error">{error}</div>}
        {!thread && !error && <div className="AllInTab__empty">Loading…</div>}
        {thread?.messages.map(message => (
          <Bubble key={message.id} message={message} />
        ))}
        {pending.map(p => (
          <div key={p.localId} className="AllInBubble AllInBubble--outgoing">
            <div
              className="AllInBubble__body"
              onClick={p.status === 'failed' ? () => retry(p) : undefined}
              role={p.status === 'failed' ? 'button' : undefined}
            >
              {p.photoUrl && (
                <img className="AllInBubble__photo" src={p.photoUrl} alt="" />
              )}
              {p.text && <div className="AllInBubble__text">{p.text}</div>}
              <div
                className={classNames('AllInBubble__footer', {
                  'AllInBubble__footer--error': p.status === 'failed',
                })}
              >
                {p.status === 'sending' && 'Sending…'}
                {p.status === 'sent' && `${formatTime(p.timestamp)} · Sent`}
                {p.status === 'failed' && 'Not sent. Click to retry.'}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {thread && (
        <Composer
          onError={setError}
          onSend={(text, photo) => {
            const message: PendingMessage = {
              localId: `local-${Date.now()}-${Math.random()}`,
              text,
              photoUrl: photo?.url,
              jpeg: photo?.jpeg,
              timestamp: Date.now(),
              status: 'sending',
              serverId: undefined,
            };
            setPending(list => [...list, message]);
            void send(message);
          }}
        />
      )}
    </div>
  );
}

type Suggestion = { name: string; number: string };

/** Signal contacts with a phone number, for the To field's suggestions. */
function contactSuggestions(): Array<Suggestion> {
  const result: Array<Suggestion> = [];
  for (const conversation of window.ConversationController.getAll()) {
    const e164 = conversation.get('e164');
    if (conversation.get('type') === 'private' && e164) {
      result.push({ name: conversation.getTitle(), number: e164 });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function NewGoogleVoicePane(): JSX.Element {
  const [to, setTo] = useState('');
  const [recipients, setRecipients] = useState<ReadonlyArray<Suggestion>>([]);
  const [status, setStatus] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const allContacts = useMemo(contactSuggestions, []);

  const query = to.trim().toLowerCase();
  const matches = query
    ? allContacts
        .filter(
          c =>
            c.name.toLowerCase().includes(query) ||
            c.number.includes(query.replace(/[^\d]/g, '') || '\u0000')
        )
        .slice(0, 6)
    : [];
  const typedNumber = toE164(to);

  const add = (suggestion: Suggestion) => {
    if (!recipients.some(r => r.number === suggestion.number)) {
      setRecipients([...recipients, suggestion]);
    }
    setTo('');
  };

  return (
    <div className="AllInConversation">
      <PaneHeader
        title="New Google Voice text"
        subtitle="Sent from your Google Voice number · not end-to-end encrypted"
      />
      <div className="AllInNewText__to">
        <span>To:</span>
        {recipients.map(r => (
          <button
            type="button"
            key={r.number}
            className="AllInNewText__chip"
            title="Remove"
            onClick={() =>
              setRecipients(recipients.filter(x => x.number !== r.number))
            }
          >
            {r.name} ×
          </button>
        ))}
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={to}
          placeholder="Name or phone number"
          onChange={e => setTo(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (typedNumber) {
                add({ name: formatNumber(typedNumber), number: typedNumber });
              } else if (matches[0]) {
                add(matches[0]);
              }
            }
          }}
        />
      </div>
      <div className="AllInConversation__messages">
        {typedNumber && (
          <button
            type="button"
            className="AllInNewText__suggestion"
            onClick={() =>
              add({ name: formatNumber(typedNumber), number: typedNumber })
            }
          >
            Text {formatNumber(typedNumber)}
          </button>
        )}
        {matches.map(m => (
          <button
            type="button"
            key={m.number}
            className="AllInNewText__suggestion"
            onClick={() => add(m)}
          >
            {m.name} <span>{formatNumber(m.number)}</span>
          </button>
        ))}
        {status && <div className="AllInTab__error">{status}</div>}
        {sending && <div className="AllInTab__empty">Sending…</div>}
      </div>
      <Composer
        onError={setStatus}
        onSend={async (text, photo) => {
          const numbers = recipients.map(r => r.number);
          if (typedNumber && !numbers.includes(typedNumber)) {
            numbers.push(typedNumber);
          }
          if (!numbers.length) {
            setStatus('Add who to text first.');
            return;
          }
          setSending(true);
          setStatus(undefined);
          try {
            const { threadId } = await window.AllIn.api.gvSendNew(
              numbers,
              text,
              photo?.jpeg
            );
            await refreshGoogleVoice();
            if (threadId) {
              openAllInPane({ kind: 'googleVoice', threadId });
            } else {
              setStatus('Sent.');
            }
          } catch {
            setStatus('Not sent. Check the number and try again.');
          } finally {
            setSending(false);
          }
        }}
      />
    </div>
  );
}

function Bubble({ message }: { message: GoogleVoiceMessage }): JSX.Element {
  return (
    <div
      className={classNames('AllInBubble', {
        'AllInBubble--outgoing': message.outgoing,
      })}
    >
      <div className="AllInBubble__body">
        {message.attachmentIds.map(id => (
          <AttachmentPhoto key={id} attachmentId={id} />
        ))}
        {message.text && <div className="AllInBubble__text">{message.text}</div>}
        <div className="AllInBubble__footer">{formatTime(message.timestamp)}</div>
      </div>
    </div>
  );
}

const photoCache = new Map<string, string>();

function AttachmentPhoto({ attachmentId }: { attachmentId: string }): JSX.Element {
  const [url, setUrl] = useState(photoCache.get(attachmentId));
  useEffect(() => {
    if (url) {
      return;
    }
    void window.AllIn.api.gvAttachment(attachmentId).then(dataUrl => {
      if (dataUrl) {
        photoCache.set(attachmentId, dataUrl);
        setUrl(dataUrl);
      }
    });
  }, [attachmentId, url]);

  return url ? (
    <img className="AllInBubble__photo" src={url} alt="" />
  ) : (
    <div className="AllInBubble__photoPlaceholder">Loading photo…</div>
  );
}
