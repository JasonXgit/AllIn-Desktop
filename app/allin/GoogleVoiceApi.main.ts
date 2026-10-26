// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: client for the private web API that voice.google.com uses, authenticated with the cookies from the
// Google sign-in window. Port of the Android app's GoogleVoiceApi.kt; protocol from mautrix-gvoice (AGPL-3.0).
//
// Request bodies are "pblite" (a protobuf message written as a JSON array, where index i holds field i + 1) and
// responses are binary protobuf (protos/AllInGoogleVoice.proto). The protocol is reverse-engineered, so Google can
// change it at any time.

import { createHash, randomInt } from 'node:crypto';
import { createLogger } from '../../ts/logging/log.std.ts';
import { AllInGoogleVoice as Proto } from '../../ts/protobuf/index.std.ts';
import { chromeUserAgent, cookieHeader, getCookie } from './WebSession.main.ts';

const log = createLogger('AllIn/GoogleVoiceApi');

export const GV_PARTITION = 'persist:allin-google';
/** "grandcentral" is Google Voice's service name in Google's account system. */
export const GV_SIGN_IN_URL =
  'https://accounts.google.com/ServiceLogin?service=grandcentral&continue=https%3A%2F%2Fvoice.google.com%2Fu%2F0%2Fmessages';

const ORIGIN = 'https://voice.google.com';
const API_BASE = 'https://clients6.google.com/voice/v1/voiceclient';
const API_KEY = 'AIzaSyDTYc1N4xiODyrQYK0Kl6g_y279LjYkrBg';
/** The voice.google.com web client build the protocol was captured from. */
const CLIENT_VERSION = '665865172';

const WAA_BASE =
  'https://waa-pa.clients6.google.com/$rpc/google.internal.waa.v1.Waa';
const WAA_API_KEY = 'AIzaSyBGb5fGAyC-pRcRU6MUHb__b_vKha71HRE';
const WAA_REQUEST_KEY = '/JR8jsAkqotcKsEKhXic';

const REALTIME_BASE = 'https://signaler-pa.clients6.google.com';
const REALTIME_CHOOSE_SERVER =
  '[[null,null,null,[7,5],null,[null,[null,1],[[["3"]]]]]]';
/** The event sources the web app subscribes to, each with its kind (from mautrix-gvoice's channel.go). */
const REALTIME_SOURCES: ReadonlyArray<[string, string]> = [
  ['1', '2'],
  ['2', '3'],
  ['3', '3'],
  ['4', '1'],
  ['5', '1'],
  ['6', '1'],
  ['9', '1'],
];

const CONTENT_TYPE_PBLITE = 'application/json+protobuf';
/** ReqSendSMS.Media.Type.JPEG */
const MEDIA_TYPE_JPEG = 1;

/** Message.Type values for texts. */
export const SMS_IN = 10;
export const SMS_OUT = 11;

export class GoogleVoiceNotSignedInError extends Error {
  constructor() {
    super('Not signed in to Google Voice');
  }
}

export class GoogleVoiceRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number = 0,
    public readonly body: string = ''
  ) {
    super(message);
  }
}

export type Thread = Proto.Thread;
export type Message = Proto.Message;

export async function hasGoogleVoiceSession(): Promise<boolean> {
  return (await getCookie(GV_PARTITION, ORIGIN, 'SAPISID')) != null;
}

// pblite: JSON arrays where index i holds field i + 1. `Raw` embeds already-encoded JSON.
class Raw {
  constructor(public readonly json: string) {}
}
type PbField =
  | null
  | undefined
  | string
  | number
  | boolean
  | Uint8Array
  | Raw;

function pblite(...fields: Array<PbField>): Raw {
  return new Raw(
    `[${fields
      .map(field => {
        if (field == null) {
          return 'null';
        }
        if (field instanceof Raw) {
          return field.json;
        }
        if (field instanceof Uint8Array) {
          return JSON.stringify(Buffer.from(field).toString('base64'));
        }
        return JSON.stringify(field);
      })
      .join(',')}]`
  );
}

/** The Authorization header google.com web apps send: SHA-1 of "timestamp SAPISID origin". */
function sapisidHash(sapisid: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHash('sha1')
    .update(`${timestamp} ${sapisid} ${ORIGIN}`)
    .digest('hex');
  return `SAPISIDHASH ${timestamp}_${digest}`;
}

async function signedInHeaders(): Promise<Record<string, string>> {
  const sapisid = await getCookie(GV_PARTITION, API_BASE, 'SAPISID');
  if (!sapisid) {
    throw new GoogleVoiceNotSignedInError();
  }
  return {
    Cookie: await cookieHeader(GV_PARTITION, API_BASE),
    Authorization: sapisidHash(sapisid),
    'User-Agent': chromeUserAgent(),
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    'X-Goog-AuthUser': '0',
    // Google refuses cookie-authenticated requests that don't look like a browser's cross-site fetch.
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
}

async function call(
  endpoint: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  signal?: AbortSignal
): Promise<Response> {
  const headers = { ...(await signedInHeaders()), ...init.headers };
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? (init.body != null ? 'POST' : 'GET'),
      headers,
      body: init.body,
      signal,
    });
  } catch (error) {
    throw new GoogleVoiceRequestError(`${endpoint} failed: ${String(error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    log.warn(`[${endpoint}] Rejected with ${response.status}, session expired.`);
    throw new GoogleVoiceNotSignedInError();
  }
  if (!response.ok) {
    // Google's error body names the bad field; it holds no account data.
    const body = (await response.text()).slice(0, 500);
    log.warn(`[${endpoint}] ${response.status}: ${body}`);
    throw new GoogleVoiceRequestError(
      `${endpoint} returned ${response.status}`,
      response.status,
      body
    );
  }
  return response;
}

/** POSTs a pblite body to the voice API and returns the protobuf response bytes. */
async function post(
  endpoint: string,
  body: Raw
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await call(
    endpoint,
    `${API_BASE}/${endpoint}?alt=proto&key=${API_KEY}`,
    {
      body: body.json,
      headers: {
        'Content-Type': CONTENT_TYPE_PBLITE,
        'X-Requested-With': 'XMLHttpRequest',
        'X-Client-Version': CLIENT_VERSION,
        'X-JavaScript-User-Agent': 'google-api-javascript-client/1.1.0',
        // Google only returns protobuf to cookie-authenticated requests base64-wrapped.
        'X-Goog-Encode-Response-If-Executable': 'base64',
      },
    }
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const safetyType = response.headers.get('X-Goog-Safety-Content-Type');
  if (
    safetyType?.startsWith('application/x-protobuf') &&
    response.headers.get('Content-Type')?.startsWith('text/plain')
  ) {
    return new Uint8Array(
      Buffer.from(Buffer.from(bytes).toString('latin1'), 'base64')
    );
  }
  return bytes;
}

/** Conversations (texts, calls and voicemail), newest first, each with its most recent messages. */
export async function listThreads(): Promise<Array<Thread>> {
  // The text-only folder isn't accepted by this endpoint, so list everything (folder 1) and filter on isText.
  const body = pblite(1, 20, 15, null, null, pblite(null, 1, 1));
  return Proto.RespListThreads.decode(await post('api2thread/list', body))
    .threads;
}

export async function getThread(
  threadId: string,
  messageCount = 100
): Promise<Thread | undefined> {
  const body = pblite(threadId, messageCount, null, pblite(null, 1, 1));
  return (
    Proto.RespGetThread.decode(await post('api2thread/get', body)).thread ??
    undefined
  );
}

/** A random ID like the web app's, small enough to survive a round trip through JavaScript numbers. */
export function newTransactionId(): number {
  return randomInt(1, 2 ** 47);
}

/** Sends a text, optionally with a JPEG photo, into an existing conversation. */
export async function sendSms(
  threadId: string,
  text: string,
  transactionId: number,
  trackingData: string,
  jpeg: Uint8Array | undefined
): Promise<Proto.RespSendSMS> {
  const media = jpeg ? pblite(MEDIA_TYPE_JPEG, jpeg) : null;
  const body = pblite(
    null,
    null,
    null,
    null,
    text,
    threadId,
    null,
    null,
    pblite(transactionId),
    media,
    pblite(trackingData)
  );
  return Proto.RespSendSMS.decode(await post('api2thread/sendsms', body));
}

/** Marks a conversation as read, here and in Google's own apps. */
export async function markRead(threadId: string): Promise<void> {
  // ReqUpdateAttributes: the thread's new attributes, then which attributes to change ("read"), then 1.
  await post(
    'thread/updateattributes',
    pblite(pblite(threadId, null, null, true), pblite(null, null, null, true), 1)
  );
}

/** Downloads a picture from an MMS message at full size. */
export async function downloadAttachment(
  attachmentId: string
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const response = await call(
    'attachment',
    `${ORIGIN}/u/0/a/i/${encodeURIComponent(attachmentId)}?s=1`,
    { headers: { 'Sec-Fetch-Site': 'same-origin' } }
  );
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get('Content-Type') ?? 'image/jpeg',
  };
}

export type Waa = Readonly<{
  interpreterUrl: string;
  program: string;
  globalName: string;
}>;

async function postWaa(method: string, body: Raw): Promise<string> {
  const response = await call(`waa/${method}`, `${WAA_BASE}/${method}`, {
    body: body.json,
    headers: {
      'Content-Type': CONTENT_TYPE_PBLITE,
      'X-Goog-Api-Key': WAA_API_KEY,
      'X-User-Agent': 'grpc-web-javascript/0.1',
    },
  });
  return response.text();
}

/** Asks Google for a fresh BotGuard program and the script that runs it. Programs are good for about an hour. */
export async function createWaa(): Promise<Waa> {
  const json = await postWaa('Create', pblite(WAA_REQUEST_KEY));
  // pblite: [[respID, null, [null, null, null, url], hash, program, globalName, ...]]
  const waa = (JSON.parse(json) as Array<Array<unknown>>)[0] ?? [];
  const url = String((waa[2] as Array<unknown> | undefined)?.[3]);
  return {
    interpreterUrl: url.startsWith('//') ? `https:${url}` : url,
    program: String(waa[4]),
    globalName: String(waa[5]),
  };
}

/** The web app reports one blank signature after loading a program; mirrors that so ours looks the same. */
export async function pingWaa(signature: string): Promise<void> {
  await postWaa(
    'Ping',
    pblite(WAA_REQUEST_KEY, signature, 72, randomInt(2_000_000_000))
  );
}

// Realtime channel ("WebChannel" long polling), used by GoogleVoice.main.ts to hear about new messages right away.

/** Asks Google which realtime server to use; returns its session ID ("gsessionid"). */
export async function chooseRealtimeServer(): Promise<string> {
  const response = await call(
    'realtime/chooseServer',
    `${REALTIME_BASE}/punctual/v1/chooseServer?key=${API_KEY}`,
    {
      body: REALTIME_CHOOSE_SERVER,
      headers: { 'Content-Type': CONTENT_TYPE_PBLITE },
    }
  );
  return String((JSON.parse(await response.text()) as Array<unknown>)[0]);
}

/** Opens a realtime channel subscribed to the web app's event sources; returns the channel's ID ("SID"). */
export async function createRealtimeChannel(
  gSessionId: string
): Promise<string> {
  const form = new URLSearchParams();
  form.set('count', String(REALTIME_SOURCES.length));
  form.set('ofs', '0');
  REALTIME_SOURCES.forEach(([source, kind], i) => {
    form.set(
      `req${i}___data__`,
      `[[["${source}",[null,null,null,[7,5],null,[null,[null,1],[[["${kind}"]]]],null,1,2],null,3]]]`
    );
  });
  const response = await call(
    'realtime/create',
    `${REALTIME_BASE}/punctual/multi-watch/channel?VER=8&gsessionid=${gSessionId}&RID=${randomInt(100_000)}&CVER=22&t=1&key=${API_KEY}`,
    {
      body: form.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-WebChannel-Content-Type': CONTENT_TYPE_PBLITE,
      },
    }
  );
  // "<length>\n[[0,["c","<SID>","",8,12,30000]]]"
  const text = await response.text();
  const json = JSON.parse(text.slice(text.indexOf('\n') + 1)) as Array<
    [number, Array<unknown>] | undefined
  >;
  const sessionId = json[0]?.[1]?.[1];
  if (typeof sessionId !== 'string') {
    throw new GoogleVoiceRequestError('Unexpected channel response');
  }
  return sessionId;
}

/**
 * Long-polls the channel. Google holds the request open and streams length-prefixed JSON chunks as events happen;
 * [onChunk] gets each one. Resolves when Google ends the response (normally every few minutes).
 */
export async function pollRealtimeChannel(
  gSessionId: string,
  channelId: string,
  ackId: number,
  onChunk: (chunk: string) => void
): Promise<void> {
  const abort = new AbortController();
  // Google sends a keep-alive about every 30 seconds; silence for longer means the connection is dead.
  let idleTimer = setTimeout(() => abort.abort(), 90_000);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort.abort(), 90_000);
  };

  try {
    const response = await call(
      'realtime/poll',
      `${REALTIME_BASE}/punctual/multi-watch/channel?VER=8&gsessionid=${gSessionId}&RID=rpc&SID=${channelId}&AID=${ackId}&CI=0&TYPE=xmlhttp&t=1&key=${API_KEY}`,
      {},
      abort.signal
    );
    if (!response.body) {
      return;
    }

    // Lengths count UTF-16 code units, which is what a JavaScript string's length counts.
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of response.body) {
      resetIdle();
      buffer += decoder.decode(bytes, { stream: true });
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          break;
        }
        const length = Number(buffer.slice(0, newline).trim());
        if (!Number.isFinite(length)) {
          throw new GoogleVoiceRequestError('Bad realtime chunk');
        }
        if (buffer.length < newline + 1 + length) {
          break;
        }
        onChunk(buffer.slice(newline + 1, newline + 1 + length));
        buffer = buffer.slice(newline + 1 + length);
      }
    }
  } catch (error) {
    if (abort.signal.aborted) {
      throw new GoogleVoiceRequestError('Realtime channel went quiet');
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
  }
}
