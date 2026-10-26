// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: the "AllIn" nav tab: sign in and out of Google Voice and ESPN, and Google Voice notifications. The
// conversations and the Fantasy Football summary themselves show in the Chats tab.

import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { FantasyStatus, GoogleVoiceStatus } from './types.std.ts';
import { refreshFantasy, refreshGoogleVoice } from './store.dom.ts';

export function AllInSettingsTab(): JSX.Element {
  const [gv, setGv] = useState<GoogleVoiceStatus | undefined>();
  const [espn, setEspn] = useState<FantasyStatus | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setGv(await window.AllIn.api.gvStatus());
    setEspn(await window.AllIn.api.fantasyStatus());
  }, []);

  useEffect(() => {
    void load();
    // The live connection takes a few seconds to come up; keep its status current.
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      await load();
      void refreshGoogleVoice();
      void refreshFantasy();
      setBusy(false);
    }
  };

  return (
    <div className="AllInTab AllInTab--scroll">
      <div className="AllInSettings">
        <h2>AllIn</h2>
        <p className="AllInSettings__intro">
          Google Voice texts and your Fantasy Football score show in Chats.
          These work through the Google Voice and ESPN websites, so they may
          stop working if those sites change.
        </p>

        <h3>Google Voice</h3>
        {gv?.signedIn ? (
          <>
            <label className="AllInTab__toggle">
              <input
                type="checkbox"
                checked={gv.notifications}
                onChange={e =>
                  run(() => window.AllIn.api.gvSetNotifications(e.target.checked))
                }
              />
              Notifications for new texts
            </label>
            <div className="AllInTab__status">{gv.live}</div>
            <button
              type="button"
              className="AllInSettings__link"
              disabled={busy}
              onClick={() => run(() => window.AllIn.api.gvSignOut())}
            >
              Sign out of Google Voice
            </button>
          </>
        ) : (
          <button
            type="button"
            className="AllInTab__button"
            disabled={busy || !gv}
            onClick={() => run(() => window.AllIn.api.gvSignIn())}
          >
            Sign in to Google Voice
          </button>
        )}

        <h3>Fantasy Football (ESPN)</h3>
        {espn?.signedIn ? (
          <button
            type="button"
            className="AllInSettings__link"
            disabled={busy}
            onClick={() => run(() => window.AllIn.api.fantasySignOut())}
          >
            Sign out of ESPN
          </button>
        ) : (
          <>
            <p className="AllInSettings__intro">
              Sign in on ESPN&apos;s page with its own Log In button.
            </p>
            <button
              type="button"
              className="AllInTab__button"
              disabled={busy || !espn}
              onClick={() => run(() => window.AllIn.api.fantasySignIn())}
            >
              Sign in to ESPN
            </button>
          </>
        )}
      </div>
    </div>
  );
}
