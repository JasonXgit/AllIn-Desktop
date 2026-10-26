// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: main-process side of AllIn's extra tabs (Google Voice, Fantasy Football). Registers one ipcMain handler
// per AllInApi method (channel `allin:<name>`) and forwards events to the window on `allin:event`.

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { createLogger } from '../../ts/logging/log.std.ts';
import type {
  AllInApi,
  AllInEvent,
  EspnLeagueEntry,
} from '../../ts/allin/types.std.ts';
import {
  GV_PARTITION,
  GV_SIGN_IN_URL,
  downloadAttachment,
  getThread,
  hasGoogleVoiceSession,
  listThreads,
  markRead,
  newTransactionId,
  sendSms,
} from './GoogleVoiceApi.main.ts';
import {
  getLiveStatus,
  requestCheck,
  setKnownNames,
  setOpenThread,
  toSummary,
  toThread,
  updateMonitor,
} from './GoogleVoice.main.ts';
import {
  ESPN_PARTITION,
  ESPN_SIGN_IN_URL,
  hasEspnSession,
  league,
  myLeagues,
} from './EspnApi.main.ts';
import { sign, warmUp } from './WaaSigner.main.ts';
import { getSettings, updateSettings } from './settings.main.ts';
import { clearSession, getCookie, signIn } from './WebSession.main.ts';

const log = createLogger('AllIn');

type Handlers = {
  [K in keyof AllInApi]: (
    ...args: Parameters<AllInApi[K]>
  ) => ReturnType<AllInApi[K]>;
} & {
  gvSetNames(names: Record<string, string>): Promise<void>;
};

export function initAllIn({
  getMainWindow,
  showWindow,
}: {
  getMainWindow: () => BrowserWindow | undefined;
  showWindow: () => void;
}): void {
  const send = (event: AllInEvent) => {
    getMainWindow()?.webContents.send('allin:event', event);
  };

  const monitorCallbacks = {
    onChanged: () => send({ type: 'gvChanged' }),
    onNotificationClick: (threadId: string) => {
      showWindow();
      send({ type: 'gvOpenThread', threadId });
    },
  };

  const handlers: Handlers = {
    async gvStatus() {
      return {
        signedIn: await hasGoogleVoiceSession(),
        notifications: getSettings().gvNotifications,
        live: getLiveStatus(),
      };
    },
    async gvSignIn() {
      const ok = await signIn({
        partition: GV_PARTITION,
        startUrl: GV_SIGN_IN_URL,
        title: 'Sign in to Google Voice',
        parent: getMainWindow(),
        isSignedIn: async url =>
          new URL(url).host === 'voice.google.com' &&
          (await getCookie(GV_PARTITION, 'https://voice.google.com', 'SAPISID')) != null,
      });
      await updateMonitor(monitorCallbacks);
      return ok;
    },
    async gvSignOut() {
      await clearSession(GV_PARTITION);
      await updateMonitor(monitorCallbacks);
    },
    async gvSetNotifications(enabled) {
      updateSettings({ gvNotifications: enabled });
    },
    async gvListThreads() {
      return (await listThreads())
        .filter(thread => thread.isText)
        .map(toSummary)
        .filter(summary => summary !== undefined)
        .sort((a, b) => b.dateMs - a.dateMs);
    },
    async gvGetThread(threadId) {
      warmUp();
      const thread = await getThread(threadId);
      return thread ? toThread(thread) : undefined;
    },
    async gvMarkRead(threadId) {
      await markRead(threadId);
      requestCheck();
    },
    async gvSend(threadId, recipients, text, jpeg) {
      const transactionId = newTransactionId();
      const signature = await sign(threadId, [...recipients], String(transactionId));
      if (!signature) {
        log.warn('Sending without a signature');
      }
      // Without a signature, send anyway with the web app's placeholder: Google may still accept it.
      const response = await sendSms(
        threadId,
        text,
        transactionId,
        signature ?? '!',
        jpeg
      );
      requestCheck();
      return {
        messageId: response.threadItemID || undefined,
        signed: signature != null,
      };
    },
    async gvSendNew(recipients, text, jpeg) {
      const transactionId = newTransactionId();
      const signature = await sign('', [...recipients], String(transactionId));
      const response = await sendSms(
        '',
        text,
        transactionId,
        signature ?? '!',
        jpeg,
        recipients
      );
      requestCheck();
      return { threadId: response.threadID || undefined };
    },
    async gvAttachment(attachmentId) {
      const { bytes, mimeType } = await downloadAttachment(attachmentId);
      return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
    },
    async gvSetOpenThread(threadId) {
      setOpenThread(threadId);
    },
    async gvSetNames(names) {
      setKnownNames(names);
    },
    async fantasyStatus() {
      return { signedIn: await hasEspnSession() };
    },
    async fantasySignIn() {
      return signIn({
        partition: ESPN_PARTITION,
        startUrl: ESPN_SIGN_IN_URL,
        title: 'Sign in to ESPN',
        parent: getMainWindow(),
        isSignedIn: async () =>
          (await getCookie(ESPN_PARTITION, 'https://fantasy.espn.com', 'espn_s2')) != null,
      });
    },
    async fantasySignOut() {
      await clearSession(ESPN_PARTITION);
    },
    async fantasyLeagues() {
      return myLeagues();
    },
    async fantasyLeague(entry: EspnLeagueEntry) {
      return league(entry);
    },
  };

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`allin:${name}`, (_event, ...args: Array<unknown>) =>
      (handler as (...a: Array<unknown>) => Promise<unknown>)(...args)
    );
  }

  void updateMonitor(monitorCallbacks);
  log.info('AllIn features ready');
}
