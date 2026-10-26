// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: self-updates from this fork's GitHub Releases. Signal's own updater is off (config/production.json:
// updatesEnabled false) because it would install real Signal over AllIn.
//
// Every release is tagged v<signal version>-allin.<build>, and the build that made this copy is stamped into
// config/production.json as "allinBuild" by .github/workflows/allin-release.yml. When GitHub has a higher build,
// the installer is downloaded, checked against GitHub's SHA-256, and installed on the user's say-so.

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import config from '../config.main.ts';
import { createLogger } from '../../ts/logging/log.std.ts';

const log = createLogger('AllIn/Updater');

const LATEST_RELEASE =
  'https://api.github.com/repos/JasonXgit/AllIn-Desktop/releases/latest';
const FIRST_CHECK_MS = 2 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type Release = {
  tag_name?: string;
  assets?: Array<{
    name?: string;
    browser_download_url?: string;
    digest?: string;
  }>;
};

let busy = false;
let declinedBuild = 0;

function currentBuild(): number {
  return config.has('allinBuild') ? Number(config.get('allinBuild')) : 0;
}

function buildOf(tag: string | undefined): number {
  const match = /-allin\.(\d+)$/.exec(tag ?? '');
  return match ? Number(match[1]) : 0;
}

async function check(getMainWindow: () => BrowserWindow | undefined) {
  const installed = currentBuild();
  if (busy || installed === 0 || !app.isPackaged) {
    return;
  }
  busy = true;
  try {
    const response = await fetch(LATEST_RELEASE, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      log.warn(`GitHub answered ${response.status}`);
      return;
    }
    const release = (await response.json()) as Release;
    const latest = buildOf(release.tag_name);
    if (latest <= installed || latest === declinedBuild) {
      return;
    }
    const asset = release.assets?.find(a => a.name?.endsWith('.exe'));
    if (!asset?.browser_download_url) {
      return;
    }

    log.info(`Build ${latest} is available (installed: ${installed}); downloading`);
    const download = await fetch(asset.browser_download_url);
    if (!download.ok) {
      log.warn(`Download failed: ${download.status}`);
      return;
    }
    const bytes = Buffer.from(await download.arrayBuffer());
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (asset.digest && asset.digest !== `sha256:${sha256}`) {
      log.warn('Downloaded installer does not match GitHub, ignoring it');
      return;
    }
    const installer = join(tmpdir(), `AllIn-update-${latest}.exe`);
    await writeFile(installer, bytes);

    const window = getMainWindow();
    const options = {
      type: 'info' as const,
      title: 'AllIn update',
      message: 'A new version of AllIn is ready.',
      detail: `Build ${latest} is downloaded. AllIn will close, update and open again.`,
      buttons: ['Install and restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    };
    const { response: choice } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (choice !== 0) {
      declinedBuild = latest;
      return;
    }

    log.info(`Installing build ${latest}`);
    // NSIS: /S installs silently over the current copy; --force-run starts AllIn again afterwards.
    spawn(installer, ['/S', '--force-run'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    app.quit();
  } catch (error) {
    log.warn('Update check failed', error);
  } finally {
    busy = false;
  }
}

export function startUpdater(
  getMainWindow: () => BrowserWindow | undefined
): void {
  log.info(`AllIn build ${currentBuild() || 'unknown'}`);
  setTimeout(() => void check(getMainWindow), FIRST_CHECK_MS);
  setInterval(() => void check(getMainWindow), CHECK_EVERY_MS);
}
