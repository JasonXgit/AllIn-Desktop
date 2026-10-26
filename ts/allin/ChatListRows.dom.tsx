// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: rows AllIn adds to the Chats list: Google Voice conversations (mixed in with Signal chats by date, marked
// with a green bar) and the Fantasy Football score pinned at the top.

import type { JSX } from 'react';
import classNames from 'classnames';
import type { GoogleVoiceThreadSummary } from './types.std.ts';
import {
  fantasySummary,
  openAllInPane,
  threadName,
  useAllInState,
} from './store.dom.ts';

function formatListTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function initials(name: string): string {
  const letters = name
    .split(/[\s,]+/)
    .filter(word => /^[A-Za-z]/.test(word))
    .slice(0, 2)
    .map(word => word[0]?.toUpperCase());
  return letters.join('') || '#';
}

export function GoogleVoiceListRow({
  thread,
}: {
  thread: GoogleVoiceThreadSummary;
}): JSX.Element {
  const { gvNames, openPane } = useAllInState();
  const name = threadName(thread, gvNames);
  const selected =
    openPane?.kind === 'googleVoice' && openPane.threadId === thread.threadId;

  return (
    <button
      type="button"
      className={classNames('AllInListRow', 'AllInListRow--googleVoice', {
        'AllInListRow--selected': selected,
        'AllInListRow--unread': thread.unread,
      })}
      onClick={() =>
        openAllInPane({ kind: 'googleVoice', threadId: thread.threadId })
      }
    >
      <div className="AllInListRow__avatar">{initials(name)}</div>
      <div className="AllInListRow__content">
        <div className="AllInListRow__top">
          <span className="AllInListRow__name">{name}</span>
          <span className="AllInListRow__time">
            {formatListTime(thread.dateMs)}
          </span>
        </div>
        <div className="AllInListRow__bottom">
          <span className="AllInListRow__snippet">
            {thread.lastMessageOutgoing ? 'You: ' : ''}
            {thread.snippet}
          </span>
          <span className="AllInListRow__badge">Voice</span>
          {thread.unread && <span className="AllInListRow__unread" />}
        </div>
      </div>
    </button>
  );
}

export function FantasyListRow(): JSX.Element {
  const { fantasyLeague, openPane } = useAllInState();
  return (
    <button
      type="button"
      className={classNames('AllInListRow', 'AllInListRow--fantasy', {
        'AllInListRow--selected': openPane?.kind === 'fantasy',
      })}
      onClick={() => openAllInPane({ kind: 'fantasy' })}
    >
      <div className="AllInListRow__avatar AllInListRow__avatar--fantasy" />
      <div className="AllInListRow__content">
        <div className="AllInListRow__top">
          <span className="AllInListRow__name">Fantasy Football</span>
        </div>
        <div className="AllInListRow__bottom">
          <span className="AllInListRow__snippet">
            {fantasySummary(fantasyLeague)}
          </span>
        </div>
      </div>
    </button>
  );
}

/** The "New Google Voice text" choice at the top of Signal's new-message list. */
export function NewGoogleVoiceRow(): JSX.Element {
  return (
    <button
      type="button"
      className="AllInListRow AllInListRow--googleVoice"
      onClick={() => {
        window.reduxActions.conversations.showInbox();
        openAllInPane({ kind: 'newGoogleVoice' });
      }}
    >
      <div className="AllInListRow__avatar">#</div>
      <div className="AllInListRow__content">
        <div className="AllInListRow__top">
          <span className="AllInListRow__name">New Google Voice text</span>
        </div>
        <div className="AllInListRow__bottom">
          <span className="AllInListRow__snippet">
            Send an SMS from your Google Voice number
          </span>
        </div>
      </div>
    </button>
  );
}
