import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MediaAccessStatus, MediaClaim } from './types.js';

const BRIDGE_PREFIX = '/jellyquest-bridge';
const BODY_LIMIT = 64 * 1024;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const PROFILE_ID_PATTERN = /^[a-fA-F0-9-]{1,64}$/;

interface BridgeSession {
  cookie: string;
  expires: number;
  userId: string;
}

export interface RequestBridgeAccess {
  getMediaAccess(userId: string, mediaType: 'movie' | 'tv', tmdbId: number, jellyfinItemId?: string): MediaAccessStatus;
  listMediaClaims(userId: string): MediaClaim[];
  claimMediaAccess(userId: string, mediaType: 'movie' | 'tv', tmdbId: number, jellyfinItemId?: string): Promise<MediaAccessStatus>;
}

interface RelayOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface SeerrResult {
  response: Response;
  data: Record<string, unknown>;
  cookie: string;
}

export class RequestBridge {
  private readonly seerrUrl: URL;
  private readonly access: RequestBridgeAccess | undefined;
  private readonly sessions = new Map<string, BridgeSession>();

  constructor(seerrUrl: string, access?: RequestBridgeAccess) {
    this.seerrUrl = new URL(`${seerrUrl.replace(/\/+$/, '')}/`);
    this.access = access;
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith(`${BRIDGE_PREFIX}/`)) return false;

    if (request.method === 'GET' && url.pathname === `${BRIDGE_PREFIX}/bridge.html`) {
      return asset(response, BRIDGE_HTML);
    }
    if (request.method === 'GET' && url.pathname === `${BRIDGE_PREFIX}/health`) {
      return json(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === `${BRIDGE_PREFIX}/session`) {
      const input = recordBody(await readJson(request));
      if (typeof input.user !== 'string' || input.user.length < 1 || input.user.length > 128
          || typeof input.id !== 'string' || !PROFILE_ID_PATTERN.test(input.id)) {
        return json(response, 400, { error: 'Invalid Jellyfin profile.' });
      }
      const auth = await this.seerr('/api/v1/auth/jellyfin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: input.user, password: '', email: input.user }),
      });
      if (!auth.response.ok || String(auth.data.jellyfinUserId ?? '').toLowerCase() !== input.id.toLowerCase() || !auth.cookie) {
        return json(response, 401, { error: 'Jellyseerr rejected this Jellyfin profile.' });
      }
      const token = randomBytes(32).toString('hex');
      this.sessions.set(token, { cookie: auth.cookie, expires: Date.now() + SESSION_LIFETIME_MS, userId: input.id });
      this.pruneSessions();
      return json(response, 200, { token });
    }
    if (request.method === 'POST' && url.pathname === `${BRIDGE_PREFIX}/proxy`) {
      const token = bearer(request);
      const session = token ? this.sessions.get(token) : undefined;
      if (!token || !session || session.expires < Date.now()) {
        if (token) this.sessions.delete(token);
        return json(response, 401, { error: 'Request bridge session expired.' });
      }
      const input = recordBody(await readJson(request));
      const options = relayOptions(input.options);
      if (typeof input.path !== 'string' || !allowedRequest(input.path, options)) {
        return json(response, 403, { error: 'That Jellyseerr operation is not allowed.' });
      }
      if (input.path.startsWith('/jellyquest/access')) {
        if (!this.access) return json(response, 503, { error: 'JellyPass access claims are not configured.' });
        const data = await this.handleAccess(input.path, options, session);
        session.expires = Date.now() + SESSION_LIFETIME_MS;
        return json(response, 200, { data });
      }
      const result = await this.seerr(input.path, options, session.cookie);
      session.cookie = result.cookie;
      session.expires = Date.now() + SESSION_LIFETIME_MS;
      if (!result.response.ok || result.response.status === 202) {
        return json(response, result.response.status >= 400 ? result.response.status : 409, {
          error: typeof result.data.message === 'string'
            ? result.data.message
            : `Jellyseerr returned ${result.response.status}.`,
        });
      }
      return json(response, 200, { data: result.data });
    }
    return json(response, 404, { error: 'Not found.' });
  }

  private async handleAccess(pathname: string, options: RelayOptions, session: BridgeSession): Promise<unknown> {
    const url = new URL(pathname, 'http://jellyquest.local');
    const method = (options.method ?? 'GET').toUpperCase();
    if (url.pathname === '/jellyquest/access/claims' && method === 'GET') {
      return { claims: this.access!.listMediaClaims(session.userId) };
    }
    if (url.pathname !== '/jellyquest/access' || (method !== 'GET' && method !== 'POST')) {
      throw new Error('That JellyPass access operation is not allowed.');
    }
    const input = method === 'POST' ? recordBody(JSON.parse(options.body ?? '{}') as unknown) : Object.fromEntries(url.searchParams);
    const mediaType = input.mediaType;
    const tmdbId = Number(input.tmdbId);
    if ((mediaType !== 'movie' && mediaType !== 'tv') || !Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
      throw new Error('A valid movie or TV TMDB ID is required.');
    }
    const details = await this.seerr(`/api/v1/${mediaType}/${tmdbId}`, {}, session.cookie);
    if (!details.response.ok) throw new Error(`Jellyseerr could not resolve ${mediaType} ${tmdbId}.`);
    session.cookie = details.cookie;
    const mediaInfo = details.data.mediaInfo && typeof details.data.mediaInfo === 'object' && !Array.isArray(details.data.mediaInfo)
      ? details.data.mediaInfo as Record<string, unknown>
      : undefined;
    const jellyfinItemId = typeof mediaInfo?.jellyfinMediaId === 'string' && PROFILE_ID_PATTERN.test(mediaInfo.jellyfinMediaId)
      ? mediaInfo.jellyfinMediaId
      : undefined;
    return method === 'POST'
      ? this.access!.claimMediaAccess(session.userId, mediaType, tmdbId, jellyfinItemId)
      : this.access!.getMediaAccess(session.userId, mediaType, tmdbId, jellyfinItemId);
  }

  private async seerr(pathname: string, options: RelayOptions = {}, cookie = ''): Promise<SeerrResult> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.headers?.['Content-Type']) headers['Content-Type'] = options.headers['Content-Type'];
    if (cookie) headers.Cookie = cookie;
    const request: RequestInit = { method: options.method ?? 'GET', headers };
    if (options.body !== undefined) request.body = options.body;
    const response = await fetch(new URL(pathname, this.seerrUrl), request);
    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = text ? recordBody(JSON.parse(text) as unknown) : {};
    } catch {
      data = { error: text || `Jellyseerr returned ${response.status}.` };
    }
    return { response, data, cookie: responseCookie(response) || cookie };
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expires < now) this.sessions.delete(token);
    }
  }
}

function relayOptions(value: unknown): RelayOptions {
  if (value === undefined) return {};
  const input = recordBody(value);
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET';
  const body = typeof input.body === 'string' ? input.body : undefined;
  const contentType = input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)
    ? (input.headers as Record<string, unknown>)['Content-Type']
    : undefined;
  return {
    method,
    ...(body !== undefined ? { body } : {}),
    ...(typeof contentType === 'string' ? { headers: { 'Content-Type': contentType } } : {}),
  };
}

function allowedRequest(pathname: string, options: RelayOptions): boolean {
  const method = (options.method ?? 'GET').toUpperCase();
  if (/^\/jellyquest\/access(?:\/claims)?(?:\?|$)/.test(pathname)) {
    return method === 'GET' || (method === 'POST' && pathname === '/jellyquest/access');
  }
  const allowedPath = /^\/api\/v1\/(?:media(?:\?|$)|request(?:\?|$)|search\?|movie\/\d+(?:\?|$)|tv\/\d+(?:\?|$)|discover\/)/.test(pathname);
  return allowedPath && (method === 'GET' || (method === 'POST' && pathname === '/api/v1/request'));
}

function bearer(request: IncomingMessage): string | undefined {
  return request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object.');
  return value as Record<string, unknown>;
}

function responseCookie(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
}

function json(response: ServerResponse, status: number, value: unknown): true {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
  return true;
}

function asset(response: ServerResponse, body: string): true {
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors *",
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
  return true;
}

const BRIDGE_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>JellyQuest request bridge</title></head>
<body><script>
(function () {
  'use strict';
  var params = {}, sessionToken = '';
  window.location.hash.slice(1).split('&').forEach(function (part) {
    var separator = part.indexOf('=');
    if (separator > 0) params[decodeURIComponent(part.slice(0, separator))] = decodeURIComponent(part.slice(separator + 1));
  });
  window.history.replaceState(null, '', window.location.pathname);
  function reply(message) {
    message.source = 'jellyquest-bridge'; message.nonce = params.nonce; window.parent.postMessage(message, '*');
  }
  function createSession() {
    return fetch('/jellyquest-bridge/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: params.user, id: params.id })
    }).then(function (response) { return response.json().then(function (data) {
      if (!response.ok) throw new Error(data.error || 'Request bridge authentication failed.');
      sessionToken = data.token; reply({ type: 'ready' });
    }); });
  }
  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (event.source !== window.parent || data.source !== 'jellyquest-app' || data.nonce !== params.nonce
        || data.type !== 'request' || !sessionToken) return;
    fetch('/jellyquest-bridge/proxy', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: data.path, options: data.options || {} })
    }).then(function (response) { return response.json().then(function (result) {
      reply({ type: 'response', id: data.id, ok: response.ok, data: result.data, error: result.error });
    }); }).catch(function (error) { reply({ type: 'response', id: data.id, ok: false, error: error.message }); });
  });
  createSession().catch(function (error) { reply({ type: 'error', error: error.message }); });
})();
</script></body></html>`;
