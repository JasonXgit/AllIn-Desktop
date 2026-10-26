// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: the Google Voice tab. Conversation list on the left, the open conversation on the right with a box to
// reply (text and photos). Data comes from the main process (app/allin) through window.AllIn; nothing is stored.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import classNames from 'classnames';
import type {
  GoogleVoiceMessage,
  GoogleVoiceStatus,
  GoogleVoiceThread,
  GoogleVoiceThreadSummary,
} from './types.std.ts';

const REFRESH_MS = 15_000;
const MAX_PHOTO_DIMENSION = 1600;

type PendingMessage = {
  localId: string;
  text: string;
  photoUrl: string | undefined;
  jpeg: Uint8Array | undefined;
  timestamp: number;
  status: 'sending' | 'sent' | 'failed';
  serverId: string | undefined;
};

function api() {
  return window.AllIn.api;
}

/** Signal knows names for phone numbers of the user's Signal contacts (synced from their phone). */
function signalNames(numbers: ReadonlyArray<string>): Record<string, string> {
  const wanted = new Set(numbers);
  const names: Record<string, string> = {};
  for (const conversation of window.ConversationController.getAll()) {
    const e164 = conversation.get('e164');
    if (!e164 || !wanted.has(e164)) {
      continue;
    }
    const name =
      conversation.get('name') ||
      conversation.get('systemGivenName') ||
      conversation.get('profileName');
    if (name) {
      names[e164] = conversation.getTitle();
    }
  }
  return names;
}

function formatNumber(number: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : number;
}

function threadName(
  summary: Pick<GoogleVoiceThreadSummary, 'googleNames' | 'phoneNumbers'>,
  names: Record<string, string>
): string {
  return (
    summary.phoneNumbers
      .map(
        (number, i) =>
          names[number] || summary.googleNames[i] || formatNumber(number)
      )
      .filter(Boolean)
      .join(', ') || 'Google Voice'
  );
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
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

export function GoogleVoiceTab(): JSX.Element {
  const [status, setStatus] = useState<GoogleVoiceStatus | undefined>();
  const [threads, setThreads] = useState<
    ReadonlyArray<GoogleVoiceThreadSummary> | undefined
  >();
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const loadStatus = useCallback(async () => {
    setStatus(await api().gvStatus());
  }, []);

  const loadThreads = useCallback(async () => {
    try {
      const list = await api().gvListThreads();
      const known = signalNames(list.flatMap(t => t.phoneNumbers));
      setNames(known);
      void api().gvSetNames(known);
      setThreads(list);
      setError(undefined);
    } catch (e) {
      setError('Could not load Google Voice. Check your connection, or sign in again.');
      void loadStatus();
    }
  }, [loadStatus]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!status?.signedIn) {
      return undefined;
    }
    void loadThreads();
    const timer = setInterval(() => {
      void loadThreads();
      void loadStatus();
    }, REFRESH_MS);
    const unsubscribe = window.AllIn.onEvent(event => {
      if (event.type === 'gvChanged') {
        void loadThreads();
      } else if (event.type === 'gvOpenThread') {
        setSelectedId(event.threadId);
      }
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [status?.signedIn, loadThreads, loadStatus]);

  // Tell the main process which conversation is on screen, so it doesn't notify for it.
  useEffect(() => {
    void api().gvSetOpenThread(selectedId);
    return () => {
      void api().gvSetOpenThread(undefined);
    };
  }, [selectedId]);

  if (!status) {
    return <div className="AllInTab AllInTab--centered">Loading…</div>;
  }

  if (!status.signedIn) {
    return (
      <div className="AllInTab AllInTab--centered">
        <div className="AllInTab__intro">
          <h2>Google Voice</h2>
          <p>
            See and answer your Google Voice texts here. This works through the
            Google Voice website, so it may stop working if Google changes it.
          </p>
          <button
            type="button"
            className="AllInTab__button"
            onClick={async () => {
              await api().gvSignIn();
              await loadStatus();
            }}
          >
            Sign in to Google Voice
          </button>
        </div>
      </div>
    );
  }

  const selected = threads?.find(t => t.threadId === selectedId);

  return (
    <div className="AllInTab">
      <div className="AllInTab__list">
        <div className="AllInTab__listHeader">
          <h2>Google Voice</h2>
          <label className="AllInTab__toggle">
            <input
              type="checkbox"
              checked={status.notifications}
              onChange={async e => {
                await api().gvSetNotifications(e.target.checked);
                await loadStatus();
              }}
            />
            Notifications
          </label>
          <div className="AllInTab__status">{status.live}</div>
        </div>
        {error && <div className="AllInTab__error">{error}</div>}
        {!threads && !error && <div className="AllInTab__empty">Loading…</div>}
        {threads?.length === 0 && (
          <div className="AllInTab__empty">No recent texts</div>
        )}
        <div className="AllInTab__rows">
          {threads?.map(thread => (
            <button
              type="button"
              key={thread.threadId}
              className={classNames('AllInTab__row', {
                'AllInTab__row--selected': thread.threadId === selectedId,
                'AllInTab__row--unread': thread.unread,
              })}
              onClick={() => setSelectedId(thread.threadId)}
            >
              <div className="AllInTab__rowTop">
                <span className="AllInTab__rowName">
                  {threadName(thread, names)}
                </span>
                <span className="AllInTab__rowTime">
                  {formatTime(thread.dateMs)}
                </span>
              </div>
              <div className="AllInTab__rowSnippet">
                {thread.lastMessageOutgoing ? 'You: ' : ''}
                {thread.snippet}
              </div>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="AllInTab__signOut"
          onClick={async () => {
            await api().gvSignOut();
            setThreads(undefined);
            setSelectedId(undefined);
            await loadStatus();
          }}
        >
          Sign out of Google Voice
        </button>
      </div>
      <div className="AllInTab__detail">
        {selected ? (
          <Conversation
            key={selected.threadId}
            summary={selected}
            name={threadName(selected, names)}
            onChanged={loadThreads}
          />
        ) : (
          <div className="AllInTab__empty">Choose a conversation</div>
        )}
      </div>
    </div>
  );
}

function Conversation({
  summary,
  name,
  onChanged,
}: {
  summary: GoogleVoiceThreadSummary;
  name: string;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [thread, setThread] = useState<GoogleVoiceThread | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState<ReadonlyArray<PendingMessage>>([]);
  const [draft, setDraft] = useState('');
  const [photo, setPhoto] = useState<
    { jpeg: Uint8Array<ArrayBuffer>; url: string } | undefined
  >();
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await window.AllIn.api.gvGetThread(summary.threadId);
      if (!loaded) {
        return;
      }
      setThread(loaded);
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
        await window.AllIn.api.gvMarkRead(summary.threadId);
        void onChanged();
      }
    } catch (e) {
      setError('Could not load this conversation.');
    }
  }, [summary.threadId, onChanged]);

  // Reload when the list says this conversation changed.
  useEffect(() => {
    void load();
  }, [load, summary.dateMs, summary.unread]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [thread, pending]);

  const send = async (message: PendingMessage) => {
    try {
      const result = await window.AllIn.api.gvSend(
        summary.threadId,
        thread?.phoneNumbers ?? summary.phoneNumbers,
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
      void onChanged();
    } catch (e) {
      setPending(list =>
        list.map(p =>
          p.localId === message.localId ? { ...p, status: 'failed' } : p
        )
      );
    }
  };

  const onSend = () => {
    const text = draft.trim();
    if (!text && !photo) {
      return;
    }
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
    setDraft('');
    setPhoto(undefined);
    void send(message);
  };

  const retry = (localId: string) => {
    const message = pending.find(p => p.localId === localId);
    if (!message) {
      return;
    }
    setPending(list =>
      list.map(p => (p.localId === localId ? { ...p, status: 'sending' } : p))
    );
    void send({ ...message, status: 'sending' });
  };

  return (
    <div className="AllInConversation">
      <div className="AllInConversation__header">{name}</div>
      <div className="AllInConversation__messages">
        {error && !thread && <div className="AllInTab__error">{error}</div>}
        {!thread && !error && <div className="AllInTab__empty">Loading…</div>}
        {thread?.messages.map(message => (
          <Bubble key={message.id} message={message} />
        ))}
        {pending.map(p => (
          <div
            key={p.localId}
            className="AllInBubble AllInBubble--outgoing"
          >
            <div
              className="AllInBubble__body"
              onClick={p.status === 'failed' ? () => retry(p.localId) : undefined}
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
                  setError('Could not use that photo.');
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
                  onSend();
                }
              }}
            />
            <button
              type="button"
              className="AllInComposer__send"
              aria-label="Send"
              disabled={!draft.trim() && !photo}
              onClick={onSend}
            />
          </div>
        </div>
      )}
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
