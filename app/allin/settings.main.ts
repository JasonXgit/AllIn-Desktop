// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: small settings file for AllIn's extra features, kept next to Signal's own config in the data folder.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { createLogger } from '../../ts/logging/log.std.ts';

const log = createLogger('AllIn/settings');

export type AllInSettings = {
  gvNotifications: boolean;
  /** Timestamp of the newest incoming text already notified (or skipped); 0 until the first check. */
  gvNotifiedUpTo: number;
};

const DEFAULTS: AllInSettings = {
  gvNotifications: true,
  gvNotifiedUpTo: 0,
};

let cached: AllInSettings | undefined;

function path(): string {
  return join(app.getPath('userData'), 'allin.json');
}

export function getSettings(): AllInSettings {
  if (!cached) {
    try {
      cached = { ...DEFAULTS, ...JSON.parse(readFileSync(path(), 'utf8')) };
    } catch {
      cached = { ...DEFAULTS };
    }
  }
  return cached as AllInSettings;
}

export function updateSettings(changes: Partial<AllInSettings>): void {
  cached = { ...getSettings(), ...changes };
  try {
    writeFileSync(path(), JSON.stringify(cached, null, 2));
  } catch (error) {
    log.warn('Could not save settings', error);
  }
}
