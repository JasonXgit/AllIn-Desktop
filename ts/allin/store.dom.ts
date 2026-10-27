// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: what the chat list needs from AllIn's extras: recent Google Voice threads (mixed in with Signal chats),
// the Fantasy Football summary (pinned above them), and which AllIn item is open in the conversation pane.
// Kept in memory only and refreshed while the app runs.

import { useSyncExternalStore } from 'react';
import type {
  EspnLeague,
  GoogleVoiceThreadSummary,
} from './types.std.ts';
import { NavTab } from '../types/Nav.std.ts';

export type AllInPane =
  | { kind: 'googleVoice'; threadId: string }
  | { kind: 'newGoogleVoice' }
  | { kind: 'fantasy' }
  | { kind: 'settings' };

/** A Google Voice text being sent (kept here, not in the pane, so it survives switching conversations). */
export type OutboxItem = Readonly<{
  localId: string;
  threadId: string;
  recipients: ReadonlyArray<string>;
  text: string;
  photoUrl: string | undefined;
  jpeg: Uint8Array<ArrayBuffer> | undefined;
  timestamp: number;
  status: 'sending' | 'sent' | 'failed';
  serverId: string | undefined;
}>;

export type AllInState = Readonly<{
  gvSignedIn: boolean;
  gvThreads: ReadonlyArray<GoogleVoiceThreadSummary>;
  /** Signal contact names by phone number, for Google Voice threads. */
  gvNames: Readonly<Record<string, string>>;
  fantasySignedIn: boolean;
  fantasyLeague: EspnLeague | undefined;
  openPane: AllInPane | undefined;
  gvOutbox: ReadonlyArray<OutboxItem>;
}>;

const GV_REFRESH_MS = 15_000;
const FANTASY_REFRESH_MS = 60_000;
export const FANTASY_LEAGUE_KEY = 'allin.fantasy.league';

let state: AllInState = {
  gvSignedIn: false,
  gvThreads: [],
  gvNames: {},
  fantasySignedIn: false,
  fantasyLeague: undefined,
  openPane: undefined,
  gvOutbox: [],
};
const listeners = new Set<() => void>();
let started = false;

function setState(changes: Partial<AllInState>): void {
  state = { ...state, ...changes };
  listeners.forEach(listener => listener());
}

export function getAllInState(): AllInState {
  return state;
}

export function subscribeAllIn(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAllInState(): AllInState {
  return useSyncExternalStore(subscribeAllIn, getAllInState);
}

/** Opens an AllIn item in the conversation pane, closing any open Signal conversation. */
export function openAllInPane(pane: AllInPane | undefined): void {
  if (pane) {
    window.reduxActions.conversations.showConversation({
      conversationId: undefined,
    });
  }
  setState({ openPane: pane });
  void window.AllIn.api.gvSetOpenThread(
    pane?.kind === 'googleVoice' ? pane.threadId : undefined
  );
}

/** Signal knows names for the phone numbers of the user's Signal contacts (synced from their phone). */
export function signalNames(
  numbers: ReadonlyArray<string>
): Record<string, string> {
  const wanted = new Set(numbers);
  const names: Record<string, string> = {};
  for (const conversation of window.ConversationController.getAll()) {
    const e164 = conversation.get('e164');
    if (!e164 || !wanted.has(e164)) {
      continue;
    }
    if (
      conversation.get('name') ||
      conversation.get('systemGivenName') ||
      conversation.get('profileName')
    ) {
      names[e164] = conversation.getTitle();
    }
  }
  return names;
}

export function formatNumber(number: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : number;
}

export function threadName(
  summary: Pick<GoogleVoiceThreadSummary, 'googleNames' | 'phoneNumbers'>,
  names: Readonly<Record<string, string>> = state.gvNames
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

export async function refreshGoogleVoice(): Promise<void> {
  try {
    const status = await window.AllIn.api.gvStatus();
    if (!status.signedIn) {
      setState({ gvSignedIn: false, gvThreads: [] });
      return;
    }
    const threads = await window.AllIn.api.gvListThreads();
    const names = signalNames(threads.flatMap(t => t.phoneNumbers));
    void window.AllIn.api.gvSetNames(names);
    setState({ gvSignedIn: true, gvThreads: threads, gvNames: names });
  } catch {
    // Keep showing the last list; the next refresh tries again.
  }
}

export async function refreshFantasy(): Promise<void> {
  try {
    const status = await window.AllIn.api.fantasyStatus();
    if (!status.signedIn) {
      setState({ fantasySignedIn: false, fantasyLeague: undefined });
      return;
    }
    const leagues = await window.AllIn.api.fantasyLeagues();
    let savedId: number | undefined;
    try {
      const saved = localStorage.getItem(FANTASY_LEAGUE_KEY);
      savedId = saved ? Number(saved) : undefined;
    } catch {
      savedId = undefined;
    }
    const entry = leagues.find(l => l.leagueId === savedId) ?? leagues[0];
    setState({
      fantasySignedIn: true,
      fantasyLeague: entry
        ? await window.AllIn.api.fantasyLeague(entry)
        : undefined,
    });
  } catch {
    // Keep showing the last score.
  }
}

const SEND_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5_000, 15_000];

function updateOutboxItem(localId: string, changes: Partial<OutboxItem>): void {
  setState({
    gvOutbox: state.gvOutbox.map(item =>
      item.localId === localId ? { ...item, ...changes } : item
    ),
  });
}

async function deliver(item: OutboxItem): Promise<void> {
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await window.AllIn.api.gvSend(
        item.threadId,
        item.recipients,
        item.text,
        item.jpeg
      );
      updateOutboxItem(item.localId, {
        status: 'sent',
        serverId: result.messageId,
      });
      void refreshGoogleVoice();
      return;
    } catch {
      if (attempt < SEND_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => {
          setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]);
        });
      }
    }
  }
  updateOutboxItem(item.localId, { status: 'failed' });
}

/** Sends a Google Voice text into [threadId]; it shows at once and retries by itself before showing "Not sent". */
export function sendGoogleVoice(
  threadId: string,
  recipients: ReadonlyArray<string>,
  text: string,
  photo: { jpeg: Uint8Array<ArrayBuffer>; url: string } | undefined
): void {
  const item: OutboxItem = {
    localId: `local-${Date.now()}-${Math.random()}`,
    threadId,
    recipients,
    text,
    photoUrl: photo?.url,
    jpeg: photo?.jpeg,
    timestamp: Date.now(),
    status: 'sending',
    serverId: undefined,
  };
  setState({ gvOutbox: [...state.gvOutbox, item] });
  void deliver(item);
}

export function retryGoogleVoice(localId: string): void {
  const item = state.gvOutbox.find(i => i.localId === localId);
  if (!item || item.status !== 'failed') {
    return;
  }
  updateOutboxItem(localId, { status: 'sending' });
  void deliver(item);
}

/** Drops sent texts that Google now lists itself. */
export function acknowledgeGoogleVoice(
  threadId: string,
  isOnServer: (item: OutboxItem) => boolean
): void {
  const kept = state.gvOutbox.filter(
    item =>
      !(item.threadId === threadId && item.status === 'sent' && isOnServer(item))
  );
  if (kept.length !== state.gvOutbox.length) {
    setState({ gvOutbox: kept });
  }
}

/** Starts the refresh loops; safe to call more than once. */
export function startAllIn(): void {
  if (started) {
    return;
  }
  started = true;

  void refreshGoogleVoice();
  void refreshFantasy();
  setInterval(() => void refreshGoogleVoice(), GV_REFRESH_MS);
  setInterval(() => void refreshFantasy(), FANTASY_REFRESH_MS);

  window.AllIn.onEvent(event => {
    if (event.type === 'gvChanged') {
      void refreshGoogleVoice();
    } else if (event.type === 'gvOpenThread') {
      window.reduxActions.nav.changeLocation({
        tab: NavTab.Chats,
        details: { conversationId: undefined },
      });
      openAllInPane({ kind: 'googleVoice', threadId: event.threadId });
    }
  });
}

/** One line for the pinned Fantasy row, e.g. "Week 8 · Tacos 101.4 – 88.2 Bears". */
export function fantasySummary(league: EspnLeague | undefined): string {
  if (!league) {
    return 'Loading…';
  }
  const m = league.myMatchup;
  if (!m) {
    return `${league.name} · Week ${league.week}`;
  }
  const home = m.home.abbrev || m.home.name;
  if (!m.away) {
    return `Week ${league.week} · ${home} ${m.homePoints.toFixed(1)} · Bye`;
  }
  const away = m.away.abbrev || m.away.name;
  return `Week ${league.week} · ${home} ${m.homePoints.toFixed(1)} – ${m.awayPoints.toFixed(1)} ${away}`;
}
