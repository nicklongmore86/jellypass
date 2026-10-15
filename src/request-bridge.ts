import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tokenAuthorizationHeader } from './jellyfin.js';
import type { CallerMediaClaim, MediaAccessStatus } from './types.js';

const BRIDGE_PREFIX = '/jellyquest-bridge';
const BODY_LIMIT = 64 * 1024;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const PROFILE_ID_PATTERN = /^[a-fA-F0-9-]{1,64}$/;
const PROBE_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_PROBE_ATTEMPTS = 30;
const IDENTITY_RECHECK_MS = 5 * 60 * 1000;
const JELLYFIN_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,256}$/;
// Keys are compared as lower-case words split on camel case and `_`/`-`, so `UserId`, `USER_ID`
// and `user_id` all read as `user_id` (so does all-caps `USERID`; run-together `userid` stays
// `userid`). Whole words matter: `hobbyId`, `lobbyId` and `sortBy` are not identities.
// Fixed key sets below are compared with `_` removed too, so `userid` and `user_id` both match.
// Keys that hold a user, user ID, or list of users. Unknown keys of this shape fail closed.
const IDENTITY_KEY_PATTERN = new RegExp([
  '(?:^|_)users?(?:_?ids?)?$',
  '(?:^|_)(?:requested|modified|created|updated)_?by(?:_?ids?)?$',
  '[a-z0-9]_by_ids?$',
].join('|'));
// TMDB credits (a show's `createdBy` creators) are public media data, not Jellyseerr users.
const TMDB_CREDIT_FIELDS = ['creditId', 'credit_id', 'profilePath', 'profile_path'];
const TV_DETAILS_PATH = /^\/api\/v1\/tv\/\d+(?:\?|$)/;
// Staff actions on a request are never relayed, even on the caller's own request.
const ALWAYS_STRIPPED_KEY_PATTERN = /^(?:modified|updated)_?by(?:_?id)?$/;
// Keys that make an array entry (request, watchlist entry, issue, comment) belong to that user.
const OWNER_KEYS = new Set(['requestedby', 'requestedbyid', 'createdby', 'createdbyid', 'user', 'userid']);
// Activity timing is only relayed on records the caller owns.
const TIMESTAMP_KEYS = new Set(['createdat', 'updatedat', 'mediaaddedat', 'lastseasonchange']);
const ITEM_ID_KEYS = new Set(['jellyfinmediaid', 'jellyfinmediaid4k']);
// Any one of these marks an object as a Jellyseerr user record.
const USER_FIELDS = [
  'email', 'username', 'jellyfinUserId', 'jellyfinUsername', 'plexUsername', 'plexId', 'displayName',
  'avatar', 'userType', 'permissions', 'requestCount', 'movieQuotaLimit', 'tvQuotaLimit',
];

interface BridgeSession {
  cookie: string;
  expires: number;
  userId: string;
  jellyfinToken: string;
  verifiedAt: number;
  seerrUserId: number;
}

interface ScrubContext {
  session: BridgeSession;
  canAccessItem(itemId: string): boolean;
  /** True for `GET /api/v1/tv/:id`, the only response whose top-level `createdBy` lists TMDB creators. */
  tvDetails: boolean;
}

interface JellyfinIdentity {
  id: string;
  name: string;
}

type IdentityResult = JellyfinIdentity | 'invalid' | 'unavailable';

interface CallerIdentity extends JellyfinIdentity {
  jellyfinToken: string;
}

interface CallerRejection {
  status: number;
  error: string;
}

export interface RequestBridgeAccess {
  hasJellyseerrUser(jellyfinUserId: string): Promise<boolean>;
  getMediaAccess(userId: string, mediaType: 'movie' | 'tv', tmdbId: number, jellyfinItemId?: string): MediaAccessStatus;
  listMediaClaims(userId: string): CallerMediaClaim[];
  canAccessItem(userId: string, jellyfinItemId: string): boolean;
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
  private readonly jellyfinUrl: string;
  private readonly access: RequestBridgeAccess | undefined;
  private readonly sessions = new Map<string, BridgeSession>();
  private readonly probeAttempts = new Map<string, { attempts: number; resetsAt: number }>();

  constructor(seerrUrl: string, jellyfinUrl: string, access?: RequestBridgeAccess) {
    this.seerrUrl = new URL(`${seerrUrl.replace(/\/+$/, '')}/`);
    this.jellyfinUrl = jellyfinUrl.replace(/\/+$/, '');
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
    if (request.method === 'POST' && url.pathname === `${BRIDGE_PREFIX}/eligibility`) {
      if (!this.allowProbeAttempt(clientId(request))) {
        return json(response, 429, { error: 'Too many requests.' });
      }
      const input = recordBody(await readJson(request));
      // Eligibility is only answered for the token's own profile, so it cannot be used to
      // learn whether another household member has a Jellyseerr account.
      const identity = await this.callerIdentity(request, input);
      if (!('id' in identity)) return json(response, identity.status, { error: identity.error });
      if (!this.access) return json(response, 503, { error: 'Jellyseerr user lookup is not configured.' });
      return json(response, 200, { eligible: await this.access.hasJellyseerrUser(identity.id) });
    }
    if (request.method === 'POST' && url.pathname === `${BRIDGE_PREFIX}/session`) {
      if (!this.allowProbeAttempt(clientId(request))) {
        return json(response, 429, { error: 'Too many requests.' });
      }
      const input = recordBody(await readJson(request));
      const identity = await this.callerIdentity(request, input);
      if (!('id' in identity)) return json(response, identity.status, { error: identity.error });
      const { jellyfinToken } = identity;
      const auth = await this.seerr('/api/v1/auth/jellyfin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: identity.name, password: '', email: identity.name }),
      });
      if (!auth.response.ok || !sameId(String(auth.data.jellyfinUserId ?? ''), identity.id) || !auth.cookie) {
        return json(response, 401, { error: 'Jellyseerr rejected this Jellyfin profile.' });
      }
      const seerrUserId = typeof auth.data.id === 'number' ? auth.data.id : await this.seerrUserId(auth.cookie, identity.id);
      if (seerrUserId === undefined) return json(response, 502, { error: 'Jellyseerr did not identify this profile.' });
      const token = randomBytes(32).toString('hex');
      const now = Date.now();
      this.sessions.set(token, {
        cookie: auth.cookie,
        expires: now + SESSION_LIFETIME_MS,
        userId: identity.id,
        jellyfinToken,
        verifiedAt: now,
        seerrUserId,
      });
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
      if (session.verifiedAt + IDENTITY_RECHECK_MS < Date.now()) {
        const identity = await this.verifyJellyfinToken(session.jellyfinToken);
        if (identity === 'unavailable') return json(response, 502, { error: 'Jellyfin is unavailable.' });
        if (identity === 'invalid' || !sameId(identity.id, session.userId)) {
          this.sessions.delete(token);
          return json(response, 401, { error: 'Request bridge session expired.' });
        }
        session.verifiedAt = Date.now();
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
      const result = await this.seerr(callerScopedPath(input.path, options, session), options, session.cookie);
      session.cookie = result.cookie;
      session.expires = Date.now() + SESSION_LIFETIME_MS;
      if (!result.response.ok || result.response.status === 202) {
        // Jellyseerr messages can describe other users' requests, so only the status is relayed.
        const status = result.response.status >= 400 ? result.response.status : 409;
        return json(response, status, { error: seerrErrorMessage(status, result.data.message) });
      }
      const access = this.access;
      return json(response, 200, {
        data: scrubPayload(result.data, {
          session,
          canAccessItem: (itemId) => access?.canAccessItem(session.userId, itemId) === true,
          tvDetails: TV_DETAILS_PATH.test(input.path),
        }),
      });
    }
    return json(response, 404, { error: 'Not found.' });
  }

  private async handleAccess(pathname: string, options: RelayOptions, session: BridgeSession): Promise<unknown> {
    const url = new URL(pathname, 'http://jellyquest.local');
    const method = (options.method ?? 'GET').toUpperCase();
    if (url.pathname === '/jellyquest/access/claims' && method === 'GET') {
      return { claims: this.access!.listMediaClaims(session.userId).map(callerClaim) };
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
    return accessStatus(method === 'POST'
      ? await this.access!.claimMediaAccess(session.userId, mediaType, tmdbId, jellyfinItemId)
      : this.access!.getMediaAccess(session.userId, mediaType, tmdbId, jellyfinItemId));
  }

  /**
   * Resolves the caller from their Jellyfin access token via `/Users/Me`. Client-supplied
   * user fields are never trusted; an `id`, if sent, must match the verified profile.
   */
  private async callerIdentity(request: IncomingMessage, input: Record<string, unknown>): Promise<CallerIdentity | CallerRejection> {
    const jellyfinToken = jellyfinAccessToken(request, input);
    if (!jellyfinToken) return { status: 401, error: 'A Jellyfin access token is required.' };
    const identity = await this.verifyJellyfinToken(jellyfinToken);
    if (identity === 'unavailable') return { status: 502, error: 'Jellyfin is unavailable.' };
    if (identity === 'invalid') return { status: 401, error: 'Jellyfin rejected this access token.' };
    if (input.id !== undefined && (typeof input.id !== 'string' || !sameId(input.id, identity.id))) {
      return { status: 401, error: 'The Jellyfin access token belongs to a different profile.' };
    }
    return { ...identity, jellyfinToken };
  }

  private async verifyJellyfinToken(jellyfinToken: string): Promise<IdentityResult> {
    let response: Response;
    try {
      response = await fetch(`${this.jellyfinUrl}/Users/Me`, {
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/json',
          Authorization: tokenAuthorizationHeader(jellyfinToken),
        },
      });
    } catch {
      return 'unavailable';
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return 'invalid';
    }
    if (!response.ok) {
      await response.body?.cancel();
      return 'unavailable';
    }
    let user: Record<string, unknown>;
    try {
      user = recordBody(await response.json() as unknown);
    } catch {
      return 'unavailable';
    }
    const policy = user.Policy && typeof user.Policy === 'object' ? user.Policy as Record<string, unknown> : {};
    if (typeof user.Id !== 'string' || !PROFILE_ID_PATTERN.test(user.Id)
        || typeof user.Name !== 'string' || user.Name.length < 1 || user.Name.length > 128
        || policy.IsDisabled === true) {
      return 'invalid';
    }
    return { id: user.Id, name: user.Name };
  }

  private async seerrUserId(cookie: string, jellyfinUserId: string): Promise<number | undefined> {
    const me = await this.seerr('/api/v1/auth/me', {}, cookie);
    if (!me.response.ok || typeof me.data.id !== 'number') return undefined;
    if (me.data.jellyfinUserId !== undefined && !sameId(String(me.data.jellyfinUserId), jellyfinUserId)) return undefined;
    return me.data.id;
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

  private allowProbeAttempt(clientId: string): boolean {
    const now = Date.now();
    const bucket = this.probeAttempts.get(clientId);
    if (bucket && bucket.resetsAt > now) {
      if (bucket.attempts >= MAX_PROBE_ATTEMPTS) return false;
      bucket.attempts += 1;
    } else {
      this.probeAttempts.set(clientId, { attempts: 1, resetsAt: now + PROBE_ATTEMPT_WINDOW_MS });
    }
    for (const [key, entry] of this.probeAttempts) {
      if (entry.resetsAt <= now) this.probeAttempts.delete(key);
    }
    return true;
  }
}

function accessStatus(status: MediaAccessStatus): MediaAccessStatus {
  return {
    mediaType: status.mediaType,
    tmdbId: status.tmdbId,
    claimed: status.claimed,
    managed: status.managed,
    owned: status.owned,
    public: status.public,
    ...(status.jellyfinItemId ? { jellyfinItemId: status.jellyfinItemId } : {}),
  };
}

function callerClaim(claim: CallerMediaClaim): CallerMediaClaim {
  return { ...accessStatus(claim), ...(claim.claimedAt ? { claimedAt: claim.claimedAt } : {}) };
}

/** Limits request listings to the caller's own requests so Jellyseerr's paging stays accurate. */
function callerScopedPath(pathname: string, options: RelayOptions, session: BridgeSession): string {
  if ((options.method ?? 'GET').toUpperCase() !== 'GET' || !/^\/api\/v1\/request(?:\?|$)/.test(pathname)) return pathname;
  const url = new URL(pathname, 'http://jellyseerr.local');
  url.searchParams.set('requestedBy', String(session.seerrUserId));
  return `${url.pathname}${url.search}`;
}

// Known Jellyseerr messages that only describe the caller, mapped to fixed wording.
const SAFE_SEERR_MESSAGES: Array<[RegExp, string]> = [
  [/quota exceeded/i, 'You have reached your request limit for now.'],
  [/no seasons (?:left|available) to request/i, 'Every season of this show has already been requested.'],
];

function seerrErrorMessage(status: number, upstreamMessage: unknown): string {
  if (typeof upstreamMessage === 'string') {
    const safe = SAFE_SEERR_MESSAGES.find(([pattern]) => pattern.test(upstreamMessage));
    if (safe) return safe[1];
  }
  if (status === 400 || status === 422) return 'Jellyseerr could not accept that request.';
  if (status === 401 || status === 403) return 'Jellyseerr does not allow that operation for this profile.';
  if (status === 404) return 'Jellyseerr could not find that title.';
  if (status === 409) return 'That title has already been requested.';
  if (status === 429) return 'Jellyseerr is busy. Try again shortly.';
  if (status >= 500) return 'Jellyseerr is unavailable.';
  return 'Jellyseerr could not complete that operation.';
}

/**
 * Removes other Jellyseerr users from a relayed payload. Entries owned by someone else
 * (requests, watchlist entries, issues, comments) are dropped; any other user reference,
 * activity timestamp, or inaccessible Jellyfin item ID is omitted.
 */
function scrubPayload(value: unknown, context: ScrubContext): unknown {
  return isOtherUser(value, context.session) ? {} : scrubValue(value, context, true);
}

function scrubValue(value: unknown, context: ScrubContext, root = false): unknown {
  const { session } = context;
  if (Array.isArray(value)) {
    return value
      .filter((entry) => !isOtherUser(entry, session) && !ownedByOtherUser(entry, session))
      .map((entry) => scrubValue(entry, context));
  }
  if (!isRecord(value)) return value;
  const ownRecord = ownedByCaller(value, session) || (isUserRecord(value) && isCallerRef(value, session));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const words = keyWords(key);
    const compact = compactKey(key);
    if (ALWAYS_STRIPPED_KEY_PATTERN.test(words)) continue;
    if (TIMESTAMP_KEYS.has(compact) && !ownRecord) continue;
    if (ITEM_ID_KEYS.has(compact) && entry !== null && entry !== undefined
        && (typeof entry !== 'string' || !context.canAccessItem(entry))) continue;
    if (root && context.tvDetails && key === 'createdBy' && Array.isArray(entry)) {
      // A TV show's creators: keep TMDB credits only, never anything that looks like a user.
      result[key] = entry.filter(isTmdbCredit).map((item) => scrubValue(item, context));
      continue;
    }
    if (IDENTITY_KEY_PATTERN.test(words) && entry !== null && entry !== undefined) {
      if (Array.isArray(entry)) {
        result[key] = entry
          .filter((item) => isCallerValue(item, session))
          .map((item) => scrubValue(item, context));
        continue;
      }
      if (!isCallerValue(entry, session)) continue;
    } else if (isOtherUser(entry, session)) {
      continue;
    }
    result[key] = scrubValue(entry, context);
  }
  if (Array.isArray(value.results) && Array.isArray(result.results) && result.results.length < value.results.length) {
    // Rows were withheld, so upstream totals would count other users' records.
    const visible = result.results.length;
    if (isRecord(result.pageInfo)) result.pageInfo = { ...result.pageInfo, page: 1, pages: 1, results: visible };
    if ('page' in result) result.page = 1;
    if ('totalResults' in result) result.totalResults = visible;
    if ('totalPages' in result) result.totalPages = 1;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Normalizes a key to lower-case words joined by `_`: `RequestedById` and `REQUESTED_BY_ID` become `requested_by_id`. */
function keyWords(key: string): string {
  return key
    .replace(/ID([sS]?)(?=$|[A-Z_-])/g, (_match, plural: string) => `Id${plural.toLowerCase()}`)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .join('_');
}

/** `keyWords` without separators, for fixed key sets: `USER_ID`, `userId` and `userid` all become `userid`. */
function compactKey(key: string): string {
  return keyWords(key).replace(/_/g, '');
}

function ownerValues(record: Record<string, unknown>): unknown[] {
  // An owner is a single user reference; lists such as TMDB `createdBy` creators do not own the record.
  return Object.entries(record)
    .filter(([key, owner]) => OWNER_KEYS.has(compactKey(key)) && owner !== null && owner !== undefined && !Array.isArray(owner))
    .map(([, owner]) => owner);
}

function isTmdbCredit(value: unknown): boolean {
  return isRecord(value) && !isUserRecord(value) && TMDB_CREDIT_FIELDS.some((field) => field in value);
}

function ownedByCaller(record: Record<string, unknown>, session: BridgeSession): boolean {
  const owners = ownerValues(record);
  return owners.length > 0 && owners.every((owner) => isCallerValue(owner, session));
}

function ownedByOtherUser(entry: unknown, session: BridgeSession): boolean {
  return isRecord(entry) && ownerValues(entry).some((owner) => !isCallerValue(owner, session));
}

function isOtherUser(value: unknown, session: BridgeSession): boolean {
  return isUserRecord(value) && !isCallerRef(value, session);
}

function isUserRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && USER_FIELDS.some((field) => field in value);
}

function isCallerValue(value: unknown, session: BridgeSession): boolean {
  if (typeof value === 'number') return value === session.seerrUserId;
  if (typeof value === 'string') return sameId(value, session.userId) || value === String(session.seerrUserId);
  return isCallerRef(value, session);
}

function isCallerRef(value: unknown, session: BridgeSession): boolean {
  if (!isUserRecord(value)) return false;
  if (typeof value.jellyfinUserId === 'string') return sameId(value.jellyfinUserId, session.userId);
  return value.id === session.seerrUserId;
}

function clientId(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown';
}

function sameId(left: string, right: string): boolean {
  return left.replace(/-/g, '').toLowerCase() === right.replace(/-/g, '').toLowerCase();
}

function jellyfinAccessToken(request: IncomingMessage, input: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [request.headers['x-emby-token'], request.headers['x-mediabrowser-token']];
  for (const name of ['authorization', 'x-emby-authorization']) {
    const value = request.headers[name];
    if (typeof value === 'string' && /^(?:MediaBrowser|Emby)\s/i.test(value)) {
      candidates.push(value.match(/(?:\s|,)Token="([^"]*)"/i)?.[1]);
    }
  }
  candidates.push(input.accessToken);
  // Only the first supplied token is considered: a malformed one is rejected
  // rather than falling back to another source, so ambiguous input fails closed.
  const token = candidates.find((value) => typeof value === 'string' && value.length > 0);
  return typeof token === 'string' && JELLYFIN_TOKEN_PATTERN.test(token) ? token : undefined;
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
  // `/api/v1/media` is not relayed: its filters and sorts expose other households' activity.
  const allowedPath = /^\/api\/v1\/(?:request(?:\?|$)|search\?|movie\/\d+(?:\?|$)|tv\/\d+(?:\?|$)|discover\/)/.test(pathname);
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
    'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors file: tizen-app:",
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
  function checkEligibility() {
    return fetch('/jellyquest-bridge/eligibility', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Emby-Token': params.token || '' },
      body: JSON.stringify({ id: params.id })
    }).then(function (response) { return response.json().then(function (data) {
      if (!response.ok) throw new Error(data.error || 'Request eligibility check failed.');
      reply({ type: 'eligibility', eligible: data.eligible === true });
    }); });
  }
  function createSession() {
    return fetch('/jellyquest-bridge/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Emby-Token': params.token || '' },
      body: JSON.stringify({ id: params.id })
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
  (params.mode === 'eligibility' ? checkEligibility() : createSession())
    .catch(function (error) { reply({ type: 'error', error: error.message }); });
})();
</script></body></html>`;
