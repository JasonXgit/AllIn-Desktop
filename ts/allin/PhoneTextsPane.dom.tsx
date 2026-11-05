// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: a phone-text conversation (SMS, MMS or RCS) in the Chats tab's conversation pane, and the "new text"
// screen. Everything goes through AllIn on the user's phone (see phoneTexts.dom.ts).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import classNames from 'classnames';
import {
  Composer,
  PaneHeader,
  formatTime,
  toE164,
} from './GoogleVoicePane.dom.tsx';
import type { PhoneAttachment, PhoneText } from './phoneTexts.dom.ts';
import {
  loadPhoneConversation,
  markPhoneConversationRead,
  requestPhonePhoto,
  retryPhoneText,
  sendPhoneText,
  setOpenPhoneConversation,
  usePhoneTexts,
} from './phoneTexts.dom.ts';
import { openAllInPane } from './store.dom.ts';

function PhonePhoto({ attachment }: { attachment: PhoneAttachment }): JSX.Element {
  const { photos } = usePhoneTexts();
  const url = photos[attachment.mediaId];
  useEffect(() => {
    if (!url) {
      requestPhonePhoto(attachment);
    }
    // Ask once per picture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.mediaId]);
  return url ? (
    <img className="AllInBubble__photo" src={url} alt="" />
  ) : (
    <div className="AllInBubble__text">Loading picture…</div>
  );
}

function TextBubble({ message }: { message: PhoneText }): JSX.Element {
  let footer = formatTime(message.ts);
  if (message.failed) {
    footer = 'Not sent';
  } else if (message.sending) {
    footer = 'Sending…';
  }
  return (
    <div
      className={classNames('AllInBubble', {
        'AllInBubble--outgoing': message.out,
      })}
    >
      <div className="AllInBubble__body">
        {message.sender && (
          <div className="AllInBubble__footer">{message.sender}</div>
        )}
        {message.att
          .filter(a => a.image)
          .map(a => (
            <PhonePhoto key={a.mediaId} attachment={a} />
          ))}
        {message.att
          .filter(a => !a.image)
          .map(a => (
            <div key={a.mediaId} className="AllInBubble__text">
              Attachment: {a.name || a.mime} (open it on your phone)
            </div>
          ))}
        {message.text && (
          <div className="AllInBubble__text">{message.text}</div>
        )}
        <div
          className={classNames('AllInBubble__footer', {
            'AllInBubble__footer--error': message.failed,
          })}
        >
          {footer}
        </div>
      </div>
    </div>
  );
}

export function PhoneTextConversationPane({
  conversationId,
}: {
  conversationId: string;
}): JSX.Element {
  const { threads, messages, pending, available, status } = usePhoneTexts();
  const thread = threads.find(t => t.id === conversationId);
  const texts = messages[conversationId];
  const mine = pending.filter(p => p.conversationId === conversationId);
  const bottom = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setOpenPhoneConversation(conversationId);
    loadPhoneConversation(conversationId);
    return () => setOpenPhoneConversation(undefined);
  }, [conversationId]);

  useEffect(() => {
    markPhoneConversationRead(conversationId);
  }, [conversationId, thread?.unread]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [texts, mine.length]);

  const kind = thread?.rcs ? 'RCS' : 'SMS/MMS';
  return (
    <div className="AllInConversation">
      <PaneHeader
        title={thread?.name ?? 'Text message'}
        subtitle={`${kind} through your phone · not end-to-end encrypted`}
      />
      <div className="AllInConversation__messages">
        {error && <div className="AllInTab__error">{error}</div>}
        {!texts && (
          <div className="AllInTab__empty">
            {available ? 'Loading from your phone…' : status}
          </div>
        )}
        {texts?.map(message => (
          <TextBubble key={message.id} message={message} />
        ))}
        {mine.map(p => (
          <div key={p.localId} className="AllInBubble AllInBubble--outgoing">
            <div
              className="AllInBubble__body"
              onClick={
                p.status === 'failed' ? () => retryPhoneText(p.localId) : undefined
              }
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
                {p.status === 'sending' && 'Sending through your phone…'}
                {p.status === 'sent' && `${formatTime(p.timestamp)} · Sent`}
                {p.status === 'failed' &&
                  'Not sent (is your phone online?). Click to retry.'}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <Composer
        placeholder={thread?.rcs ? 'RCS message' : 'Text message'}
        onError={setError}
        onSend={(text, photo) => {
          sendPhoneText(conversationId, [], text, photo);
        }}
      />
    </div>
  );
}

export function NewPhoneTextPane(): JSX.Element {
  const [to, setTo] = useState('');
  const [localId, setLocalId] = useState<string | undefined>();
  const { pending, started } = usePhoneTexts();
  const contacts = useMemo(() => {
    const result: Array<{ name: string; number: string }> = [];
    for (const conversation of window.ConversationController.getAll()) {
      const e164 = conversation.get('e164');
      if (conversation.get('type') === 'private' && e164) {
        result.push({ name: conversation.getTitle(), number: e164 });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  const conversationId = localId ? started[localId] : undefined;
  useEffect(() => {
    if (conversationId) {
      openAllInPane({ kind: 'phoneText', conversationId });
    }
  }, [conversationId]);

  const item = pending.find(p => p.localId === localId);
  const query = to.trim().toLowerCase();
  const match = query
    ? contacts.find(c => c.name.toLowerCase() === query)
    : undefined;
  const number = toE164(to) ?? match?.number;
  const suggestions = query
    ? contacts.filter(c => c.name.toLowerCase().includes(query)).slice(0, 6)
    : [];

  return (
    <div className="AllInConversation">
      <PaneHeader
        title="New text message"
        subtitle="Sent from your phone's number through AllIn on your phone"
      />
      <div className="AllInNewText__to">
        <span>To:</span>
        <input
          className="AllInNewText__input"
          value={to}
          placeholder="Name or phone number"
          onChange={e => setTo(e.target.value)}
        />
      </div>
      <div className="AllInConversation__messages">
        {suggestions.map(s => (
          <button
            key={s.number}
            type="button"
            className="AllInNewText__suggestion"
            onClick={() => setTo(s.number)}
          >
            {s.name} · {s.number}
          </button>
        ))}
        {item?.status === 'sending' && (
          <div className="AllInTab__empty">Sending through your phone…</div>
        )}
        {item?.status === 'failed' && (
          <div className="AllInTab__error">
            Not sent. Is AllIn running on your phone?
          </div>
        )}
      </div>
      <Composer
        placeholder={number ? 'Text message' : 'Enter a phone number first'}
        onError={() => undefined}
        onSend={(text, photo) => {
          if (number) {
            setLocalId(sendPhoneText(undefined, [number], text, photo));
          }
        }}
      />
    </div>
  );
}
