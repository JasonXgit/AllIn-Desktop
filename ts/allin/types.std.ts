// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: data shared between the main process (app/allin) and the AllIn tabs in the window (ts/allin).

export type GoogleVoiceStatus = Readonly<{
  signedIn: boolean;
  notifications: boolean;
  /** Short description of the live connection, e.g. "Live: new texts arrive right away". */
  live: string;
}>;

export type GoogleVoiceThreadSummary = Readonly<{
  threadId: string;
  /** Names from Google Contacts; the window swaps in Signal contact names where it knows the number. */
  googleNames: ReadonlyArray<string>;
  phoneNumbers: ReadonlyArray<string>;
  snippet: string;
  dateMs: number;
  unread: boolean;
  lastMessageOutgoing: boolean;
}>;

export type GoogleVoiceMessage = Readonly<{
  id: string;
  text: string;
  timestamp: number;
  outgoing: boolean;
  attachmentIds: ReadonlyArray<string>;
}>;

export type GoogleVoiceThread = Readonly<{
  threadId: string;
  read: boolean;
  phoneNumbers: ReadonlyArray<string>;
  messages: ReadonlyArray<GoogleVoiceMessage>;
}>;

export type GoogleVoiceSendResult = Readonly<{
  messageId: string | undefined;
  signed: boolean;
}>;

export type EspnLeagueEntry = Readonly<{
  leagueId: number;
  leagueName: string;
  season: number;
  teamId: number;
}>;

export type EspnTeam = Readonly<{
  id: number;
  name: string;
  abbrev: string;
  wins: number;
  losses: number;
  ties: number;
  record: string;
  pointsFor: number;
  playoffSeed: number;
}>;

/** [away] is undefined during a bye week. */
export type EspnMatchup = Readonly<{
  home: EspnTeam;
  homePoints: number;
  away: EspnTeam | undefined;
  awayPoints: number;
}>;

export type EspnLeague = Readonly<{
  entry: EspnLeagueEntry;
  name: string;
  week: number;
  myMatchup: EspnMatchup | undefined;
  otherMatchups: ReadonlyArray<EspnMatchup>;
  standings: ReadonlyArray<EspnTeam>;
}>;

export type FantasyStatus = Readonly<{
  signedIn: boolean;
}>;

/** Every call the window can make to the main process; each is an ipcMain.handle channel named `allin:<name>`. */
export type AllInApi = {
  gvStatus(): Promise<GoogleVoiceStatus>;
  gvSignIn(): Promise<boolean>;
  gvSignOut(): Promise<void>;
  gvSetNotifications(enabled: boolean): Promise<void>;
  gvListThreads(): Promise<Array<GoogleVoiceThreadSummary>>;
  gvGetThread(threadId: string): Promise<GoogleVoiceThread | undefined>;
  gvMarkRead(threadId: string): Promise<void>;
  gvSend(
    threadId: string,
    recipients: ReadonlyArray<string>,
    text: string,
    jpeg: Uint8Array | undefined
  ): Promise<GoogleVoiceSendResult>;
  /** A data: URL for a picture in a message. */
  gvAttachment(attachmentId: string): Promise<string | undefined>;
  gvSetOpenThread(threadId: string | undefined): Promise<void>;
  fantasyStatus(): Promise<FantasyStatus>;
  fantasySignIn(): Promise<boolean>;
  fantasySignOut(): Promise<void>;
  fantasyLeagues(): Promise<Array<EspnLeagueEntry>>;
  fantasyLeague(entry: EspnLeagueEntry): Promise<EspnLeague>;
};

/** Events the main process sends to the window: `allin:event` with one of these. */
export type AllInEvent =
  | { type: 'gvChanged' }
  | { type: 'gvOpenThread'; threadId: string };
