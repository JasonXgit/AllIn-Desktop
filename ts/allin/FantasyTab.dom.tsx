// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: the Fantasy Football tab. This week's matchup with live scores, the league's other matchups, and the
// standings, from ESPN through the main process (app/allin/EspnApi.main.ts).

import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import type {
  EspnLeague,
  EspnLeagueEntry,
  EspnMatchup,
  FantasyStatus,
} from './types.std.ts';

const REFRESH_MS = 60_000;
const LEAGUE_KEY = 'allin.fantasy.league';

function api() {
  return window.AllIn.api;
}

function points(value: number): string {
  return value.toFixed(1);
}

export function FantasyTab(): JSX.Element {
  const [status, setStatus] = useState<FantasyStatus | undefined>();
  const [leagues, setLeagues] = useState<
    ReadonlyArray<EspnLeagueEntry> | undefined
  >();
  const [leagueId, setLeagueId] = useState<number | undefined>(() => {
    try {
      const saved = localStorage.getItem(LEAGUE_KEY);
      return saved ? Number(saved) : undefined;
    } catch {
      return undefined;
    }
  });
  const [league, setLeague] = useState<EspnLeague | undefined>();
  const [error, setError] = useState<string | undefined>();

  const loadStatus = useCallback(async () => {
    setStatus(await api().fantasyStatus());
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!status?.signedIn) {
      return;
    }
    api()
      .fantasyLeagues()
      .then(list => {
        setLeagues(list);
        setError(list.length ? undefined : 'No fantasy football leagues found on this ESPN account.');
      })
      .catch(() => setError('Could not reach ESPN. Try signing in again.'));
  }, [status?.signedIn]);

  const entry =
    leagues?.find(l => l.leagueId === leagueId) ?? leagues?.[0];

  const loadLeague = useCallback(async () => {
    if (!entry) {
      return;
    }
    try {
      setLeague(await api().fantasyLeague(entry));
      setError(undefined);
    } catch {
      setError('Could not load this league.');
    }
  }, [entry]);

  useEffect(() => {
    void loadLeague();
    const timer = setInterval(() => void loadLeague(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadLeague]);

  if (!status) {
    return <div className="AllInTab AllInTab--centered">Loading…</div>;
  }

  if (!status.signedIn) {
    return (
      <div className="AllInTab AllInTab--centered">
        <div className="AllInTab__intro">
          <h2>Fantasy Football</h2>
          <p>
            Follow your ESPN fantasy football matchup, the rest of your league
            and the standings. Sign in on ESPN&apos;s page with its own Log In
            button.
          </p>
          <button
            type="button"
            className="AllInTab__button"
            onClick={async () => {
              await api().fantasySignIn();
              await loadStatus();
            }}
          >
            Sign in to ESPN
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="AllInTab AllInTab--scroll">
      <div className="AllInFantasy">
        <div className="AllInFantasy__header">
          <h2>{league?.name ?? 'Fantasy Football'}</h2>
          {leagues && leagues.length > 1 && (
            <select
              value={entry?.leagueId}
              onChange={e => {
                const id = Number(e.target.value);
                setLeagueId(id);
                setLeague(undefined);
                try {
                  localStorage.setItem(LEAGUE_KEY, String(id));
                } catch {
                  // Remembering the league is only a convenience.
                }
              }}
            >
              {leagues.map(l => (
                <option key={l.leagueId} value={l.leagueId}>
                  {l.leagueName}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="AllInTab__signOut AllInTab__signOut--inline"
            onClick={async () => {
              await api().fantasySignOut();
              setLeagues(undefined);
              setLeague(undefined);
              await loadStatus();
            }}
          >
            Sign out of ESPN
          </button>
        </div>

        {error && <div className="AllInTab__error">{error}</div>}
        {!league && !error && <div className="AllInTab__empty">Loading…</div>}

        {league && (
          <>
            <h3>Week {league.week}</h3>
            {league.myMatchup ? (
              <Matchup matchup={league.myMatchup} large myTeamId={league.entry.teamId} />
            ) : (
              <div className="AllInTab__empty">No matchup this week</div>
            )}

            {league.otherMatchups.length > 0 && (
              <>
                <h3>Around the league</h3>
                {league.otherMatchups.map(m => (
                  <Matchup key={m.home.id} matchup={m} myTeamId={league.entry.teamId} />
                ))}
              </>
            )}

            <h3>Standings</h3>
            <table className="AllInFantasy__standings">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Team</th>
                  <th>Record</th>
                  <th>Points</th>
                </tr>
              </thead>
              <tbody>
                {league.standings.map((team, i) => (
                  <tr
                    key={team.id}
                    className={team.id === league.entry.teamId ? 'AllInFantasy__mine' : undefined}
                  >
                    <td>{team.playoffSeed || i + 1}</td>
                    <td>{team.name}</td>
                    <td>{team.record}</td>
                    <td>{points(team.pointsFor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function Matchup({
  matchup,
  large,
  myTeamId,
}: {
  matchup: EspnMatchup;
  large?: boolean;
  myTeamId: number;
}): JSX.Element {
  const side = (name: string, record: string, score: number, mine: boolean, winning: boolean) => (
    <div className={`AllInMatchup__side${mine ? ' AllInMatchup__side--mine' : ''}`}>
      <div className="AllInMatchup__team">
        <div className="AllInMatchup__name">{name}</div>
        <div className="AllInMatchup__record">{record}</div>
      </div>
      <div className={`AllInMatchup__score${winning ? ' AllInMatchup__score--winning' : ''}`}>
        {points(score)}
      </div>
    </div>
  );

  return (
    <div className={`AllInMatchup${large ? ' AllInMatchup--large' : ''}`}>
      {side(
        matchup.home.name,
        matchup.home.record,
        matchup.homePoints,
        matchup.home.id === myTeamId,
        matchup.homePoints > matchup.awayPoints
      )}
      {matchup.away
        ? side(
            matchup.away.name,
            matchup.away.record,
            matchup.awayPoints,
            matchup.away.id === myTeamId,
            matchup.awayPoints > matchup.homePoints
          )
        : <div className="AllInMatchup__bye">Bye week</div>}
    </div>
  );
}
