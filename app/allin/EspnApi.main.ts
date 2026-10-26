// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: reads ESPN fantasy football leagues with the cookies from the ESPN sign-in window. Port of the Android
// app's EspnApi.kt. ESPN's fantasy API is undocumented but stable; it is what fantasy.espn.com itself calls.
// Private leagues need the espn_s2 and SWID cookies. Parsing is lenient so a renamed field degrades one value
// instead of the whole screen.

import { createLogger } from '../../ts/logging/log.std.ts';
import { chromeUserAgent, getCookie } from './WebSession.main.ts';
import type {
  EspnLeague,
  EspnLeagueEntry,
  EspnMatchup,
  EspnTeam,
} from '../../ts/allin/types.std.ts';

const log = createLogger('AllIn/Espn');

export const ESPN_PARTITION = 'persist:allin-espn';
export const ESPN_SIGN_IN_URL = 'https://www.espn.com/';

const COOKIE_URL = 'https://fantasy.espn.com';
const FAN_API = 'https://fan.api.espn.com/apis/v2/fans';
const LEAGUE_API =
  'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';

/** ESPN's game ID for fantasy football, as used in a fan profile's entries. */
const FOOTBALL_GAME_ID = 1;

export class EspnNotSignedInError extends Error {
  constructor() {
    super('Not signed in to ESPN');
  }
}

export async function hasEspnSession(): Promise<boolean> {
  return (await getCookie(ESPN_PARTITION, COOKIE_URL, 'espn_s2')) != null;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function arr(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function get(url: string): Promise<Json> {
  const espnS2 = await getCookie(ESPN_PARTITION, COOKIE_URL, 'espn_s2');
  const swid = await getCookie(ESPN_PARTITION, COOKIE_URL, 'SWID');
  if (!espnS2 || !swid) {
    throw new EspnNotSignedInError();
  }

  const response = await fetch(url, {
    headers: {
      Cookie: `espn_s2=${espnS2}; SWID=${swid}`,
      'User-Agent': chromeUserAgent(),
      Accept: 'application/json',
    },
  });
  if (response.status === 401 || response.status === 403) {
    throw new EspnNotSignedInError();
  }
  if (!response.ok) {
    throw new Error(`${new URL(url).pathname} returned ${response.status}`);
  }
  return obj(await response.json()) ?? {};
}

/** The user's fantasy football teams, one per league, for the newest season they have. */
export async function myLeagues(): Promise<Array<EspnLeagueEntry>> {
  const swid = await getCookie(ESPN_PARTITION, COOKIE_URL, 'SWID');
  if (!swid) {
    throw new EspnNotSignedInError();
  }
  const url = new URL(`${FAN_API}/${encodeURIComponent(swid)}`);
  url.searchParams.set('displayHiddenPrefs', 'true');
  url.searchParams.set('context', 'fantasy');
  url.searchParams.set('source', 'espncom-fantasy');
  url.searchParams.set('lang', 'en');
  url.searchParams.set('region', 'us');

  const preferences = arr((await get(url.toString())).preferences);
  const entries: Array<EspnLeagueEntry> = [];
  for (const preference of preferences) {
    const entry = obj(obj(obj(preference)?.metaData)?.entry);
    if (!entry || num(entry.gameId) !== FOOTBALL_GAME_ID) {
      continue;
    }
    for (const group of arr(entry.groups)) {
      const g = obj(group);
      const leagueId = num(g?.groupId);
      const season = num(entry.seasonId);
      // A league can appear under more than one fan preference.
      if (
        leagueId === 0 ||
        entries.some(e => e.leagueId === leagueId && e.season === season)
      ) {
        continue;
      }
      entries.push({
        leagueId,
        leagueName: str(g?.groupName),
        season,
        teamId: num(entry.entryId),
      });
    }
  }

  const newestSeason = Math.max(0, ...entries.map(e => e.season));
  const result = entries.filter(e => e.season === newestSeason);
  log.info(
    `Found ${preferences.length} fan preferences, ${result.length} football leagues for ${newestSeason}`
  );
  return result;
}

/** Live points while games are on, final points otherwise. */
function points(side: Json): number {
  return 'totalPointsLive' in side
    ? num(side.totalPointsLive)
    : num(side.totalPoints);
}

/** Teams, this week's matchups and standings for one league. */
export async function league(entry: EspnLeagueEntry): Promise<EspnLeague> {
  const url = new URL(
    `${LEAGUE_API}/${entry.season}/segments/0/leagues/${entry.leagueId}`
  );
  for (const view of ['mTeam', 'mMatchupScore', 'mScoreboard', 'mSettings']) {
    url.searchParams.append('view', view);
  }

  const json = await get(url.toString());
  const currentPeriod = num(obj(json.status)?.currentMatchupPeriod);
  const week = currentPeriod > 0 ? currentPeriod : num(json.scoringPeriodId, 1);

  const teams: Array<EspnTeam> = arr(json.teams).map(value => {
    const team = obj(value) ?? {};
    const overall = obj(obj(team.record)?.overall) ?? {};
    const name =
      str(team.name) ||
      `${str(team.location)} ${str(team.nickname)}`.trim() ||
      str(team.abbrev);
    const wins = num(overall.wins);
    const losses = num(overall.losses);
    const ties = num(overall.ties);
    return {
      id: num(team.id),
      name,
      abbrev: str(team.abbrev),
      wins,
      losses,
      ties,
      record: ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`,
      pointsFor: num(overall.pointsFor),
      playoffSeed: num(team.playoffSeed),
    };
  });
  const teamsById = new Map(teams.map(team => [team.id, team]));

  const matchups: Array<EspnMatchup> = [];
  for (const value of arr(json.schedule)) {
    const matchup = obj(value);
    if (!matchup || num(matchup.matchupPeriodId) !== week) {
      continue;
    }
    const home = obj(matchup.home);
    const homeTeam = home && teamsById.get(num(home.teamId));
    if (!home || !homeTeam) {
      continue;
    }
    const away = obj(matchup.away);
    matchups.push({
      home: homeTeam,
      homePoints: points(home),
      away: away ? teamsById.get(num(away.teamId)) : undefined,
      awayPoints: away ? points(away) : 0,
    });
  }

  const standings = [...teams].sort(
    (a, b) =>
      (a.playoffSeed > 0 ? a.playoffSeed : Number.MAX_SAFE_INTEGER) -
        (b.playoffSeed > 0 ? b.playoffSeed : Number.MAX_SAFE_INTEGER) ||
      b.wins - a.wins ||
      b.pointsFor - a.pointsFor
  );

  const isMine = (m: EspnMatchup) =>
    m.home.id === entry.teamId || m.away?.id === entry.teamId;
  log.info(
    `League loaded: ${teams.length} teams, week ${week}, ${matchups.length} matchups`
  );
  return {
    entry,
    name: str(obj(json.settings)?.name) || entry.leagueName,
    week,
    myMatchup: matchups.find(isMine),
    otherMatchups: matchups.filter(m => !isMine(m)),
    standings,
  };
}
