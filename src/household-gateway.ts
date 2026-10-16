import http, { type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { ClientIpResolver, normaliseIp } from './client-ip.js';
import { DEFAULT_WS_IDLE_TIMEOUT_MS, DEFAULT_WS_UPSTREAM_IDLE_TIMEOUT_MS, type LogLevel } from './config.js';

const PUBLIC_USERS_PATH = '/users/public';
const BRANDING_CONFIGURATION_PATH = '/branding/configuration';
const QUICK_CONNECT_ENABLED_PATH = '/quickconnect/enabled';
const AUTHENTICATE_BY_NAME_PATH = '/users/authenticatebyname';
const FORGOT_PASSWORD_PATHS = new Set(['/users/forgotpassword', '/users/forgotpassword/pin']);
const MAX_TRANSFORMED_JSON_BYTES = 2 * 1024 * 1024;
const MAX_LOGIN_BODY_BYTES = 8 * 1024;
const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 20;
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 60_000;
const HOUSEHOLD_LOGIN_CSS = `
/* JellyPass household profile picker */
#loginPage .readOnlyContent,
#loginPage .btnManual,
#loginPage .btnQuick,
#loginPage .btnForgotPassword {
  display: none !important;
}
#loginPage .visualLoginForm {
  margin-inline: auto;
  max-width: 72rem;
}
#loginPage .visualLoginForm > h1 {
  color: #ffffff;
  font-weight: 600;
}
`;

export interface HouseholdGatewayOptions {
  jellyfinUrl: string;
  domain: string;
  hostPrefix: string;
  memberIds: (householdId: string) => string[] | undefined;
  isPasswordless?: (userId: string) => boolean;
  /** Close an upgraded connection after this long with no bytes in either direction; 0 disables. */
  webSocketIdleTimeoutMs?: number;
  /** Close an upgraded connection after this long with no bytes from Jellyfin, even if the client keeps talking; 0 disables. */
  webSocketUpstreamIdleTimeoutMs?: number;
  logLevel?: LogLevel;
  /** Reverse proxies trusted to report the client address in X-Forwarded-For; empty uses the TCP peer. */
  trustedProxies?: string[];
}

export class HouseholdGateway {
  readonly #target: URL;
  readonly #domain: string;
  readonly #hostPrefix: string;
  readonly #memberIds: HouseholdGatewayOptions['memberIds'];
  readonly #isPasswordless: NonNullable<HouseholdGatewayOptions['isPasswordless']>;
  readonly #loginAttempts = new Map<string, { attempts: number; resetsAt: number }>();
  readonly #webSocketIdleTimeoutMs: number;
  readonly #webSocketUpstreamIdleTimeoutMs: number;
  readonly #debug: boolean;
  readonly #clientIp: ClientIpResolver;

  public constructor(options: HouseholdGatewayOptions) {
    this.#target = new URL(options.jellyfinUrl);
    if (this.#target.protocol !== 'http:' && this.#target.protocol !== 'https:') {
      throw new Error('household gateway requires an HTTP(S) Jellyfin URL');
    }
    this.#domain = options.domain.toLowerCase();
    this.#hostPrefix = options.hostPrefix.toLowerCase();
    this.#memberIds = options.memberIds;
    this.#isPasswordless = options.isPasswordless ?? (() => false);
    this.#webSocketIdleTimeoutMs = options.webSocketIdleTimeoutMs ?? DEFAULT_WS_IDLE_TIMEOUT_MS;
    this.#webSocketUpstreamIdleTimeoutMs = options.webSocketUpstreamIdleTimeoutMs ?? DEFAULT_WS_UPSTREAM_IDLE_TIMEOUT_MS;
    this.#debug = options.logLevel === 'debug';
    this.#clientIp = new ClientIpResolver(options.trustedProxies);
  }

  public householdId(hostHeader: string | undefined): string | undefined {
    if (!hostHeader) return undefined;
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      return undefined;
    }
    const suffix = `.${this.#domain}`;
    if (!hostname.endsWith(suffix)) return undefined;
    const label = hostname.slice(0, -suffix.length);
    if (!label.startsWith(this.#hostPrefix)) return undefined;
    const householdId = label.slice(this.#hostPrefix.length);
    return /^[a-z0-9_-]{1,128}$/.test(householdId) ? householdId : undefined;
  }

  public householdUrl(householdId: string): string | undefined {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(householdId)) return undefined;
    return `https://${this.#hostPrefix}${householdId}.${this.#domain}`;
  }

  public async handle(request: IncomingMessage, response: ServerResponse, householdId: string): Promise<void> {
    const memberIds = this.#memberIds(householdId);
    if (!memberIds) {
      writeJson(response, 404, { error: 'household_not_found' });
      return;
    }
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const pathname = requestUrl.pathname.toLowerCase();
    if (request.method === 'GET' && pathname === PUBLIC_USERS_PATH) {
      await this.#proxyPublicUsers(request, response, memberIds);
      return;
    }
    if (request.method === 'GET' && pathname === BRANDING_CONFIGURATION_PATH) {
      await this.#proxyBrandingConfiguration(request, response);
      return;
    }
    if (request.method === 'GET' && pathname === QUICK_CONNECT_ENABLED_PATH) {
      writeJson(response, 200, false);
      return;
    }
    if (request.method === 'POST' && FORGOT_PASSWORD_PATHS.has(pathname)) {
      writeJson(response, 403, { error: 'household_password_recovery_disabled' });
      return;
    }
    if (request.method === 'POST' && pathname === AUTHENTICATE_BY_NAME_PATH) {
      await this.#proxyHouseholdLogin(request, response, memberIds);
      return;
    }
    const streamedItemId = protectedResourceItemId(requestUrl.pathname);
    if (streamedItemId) {
      try {
        if (!await this.#canAccessItem(request, requestUrl, streamedItemId)) {
          writeJson(response, 404, { error: 'item_not_found' });
          return;
        }
      } catch {
        writeJson(response, 502, { error: 'jellyfin_unavailable' });
        return;
      }
    }
    await this.#proxy(request, response);
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, householdId: string): void {
    const exchange = this.#exchange();
    // Node's HTTP server detaches its own socket error listener before emitting 'upgrade', so a client
    // reset (ECONNRESET/EPIPE) on an unguarded upgrade socket is an unhandled 'error' event that kills the process.
    socket.on('error', (error) => {
      exchange.error('client', 'websocket client socket', error);
      socket.destroy();
    });
    if (!this.#memberIds(householdId)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = this.#transport().request(this.#requestOptions(request));
    let upgraded = false;
    // HTTP server sockets allow half-open connections, so a client that sends FIN while the upstream upgrade is
    // pending emits 'end' but never 'close'; abort on either so the upstream request is not left dangling.
    const abortPending = () => {
      if (upgraded) return;
      exchange.clientGone();
      upstream.destroy();
      socket.destroy();
    };
    socket.once('end', abortPending);
    socket.once('close', abortPending);
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      upgraded = true;
      upstreamSocket.on('error', (error) => {
        exchange.error('upstream', 'websocket upstream socket', error);
        upstreamSocket.destroy();
      });
      if (socket.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      const status = upstreamResponse.statusCode ?? 101;
      socket.write(`HTTP/1.1 ${status} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}\r\n`);
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
        socket.write(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}\r\n`);
      }
      socket.write('\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      // A peer that vanishes without FIN/RST (sleeping TV, dropped NAT mapping) never surfaces as an error on its own:
      // TCP keepalive lets the kernel notice a dead peer, and the idle timers close connections with no traffic at all
      // or whose Jellyfin side has gone quiet while the client keeps sending KeepAlives into the void.
      enableTcpKeepAlive(socket);
      enableTcpKeepAlive(upstreamSocket);
      const closeBoth = (message: string, timeoutMs: number) => {
        this.#logDebug(message, { timeoutMs });
        socket.destroy();
        upstreamSocket.destroy();
      };
      const idleTimer = unrefTimer(this.#webSocketIdleTimeoutMs, () =>
        closeBoth('household gateway websocket idle timeout', this.#webSocketIdleTimeoutMs));
      const upstreamIdleTimer = unrefTimer(this.#webSocketUpstreamIdleTimeoutMs, () =>
        closeBoth('household gateway websocket upstream idle timeout', this.#webSocketUpstreamIdleTimeoutMs));
      socket.on('data', () => idleTimer?.refresh());
      upstreamSocket.on('data', () => {
        idleTimer?.refresh();
        upstreamIdleTimer?.refresh();
      });
      const clearTimers = () => {
        clearTimeout(idleTimer);
        clearTimeout(upstreamIdleTimer);
      };
      socket.once('close', () => {
        clearTimers();
        upstreamSocket.destroy();
      });
      upstreamSocket.once('close', () => {
        clearTimers();
        socket.destroy();
      });
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on('response', (upstreamResponse) => {
      upstreamResponse.resume();
      if (!socket.destroyed) {
        socket.end(`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
      }
    });
    upstream.on('error', (error) => {
      exchange.error('upstream', 'websocket upstream request', error);
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    upstream.end();
  }

  #exchange(): Exchange {
    return new Exchange((level, message, fields) => {
      if (level === 'debug') this.#logDebug(message, fields);
      else console.warn(JSON.stringify({ level, message, ...fields }));
    });
  }

  #logDebug(message: string, fields: Record<string, unknown>): void {
    if (this.#debug) console.debug(JSON.stringify({ level: 'debug', message, ...fields }));
  }

  #allowLoginAttempt(clientId: string): boolean {
    const now = Date.now();
    const bucket = this.#loginAttempts.get(clientId);
    if (bucket && bucket.resetsAt > now) {
      if (bucket.attempts >= MAX_LOGIN_ATTEMPTS) return false;
      bucket.attempts += 1;
    } else {
      this.#loginAttempts.set(clientId, { attempts: 1, resetsAt: now + LOGIN_ATTEMPT_WINDOW_MS });
    }
    for (const [key, entry] of this.#loginAttempts) {
      if (entry.resetsAt <= now) this.#loginAttempts.delete(key);
    }
    return true;
  }

  async #proxyHouseholdLogin(request: IncomingMessage, response: ServerResponse, memberIds: string[]): Promise<void> {
    if (!this.#allowLoginAttempt(this.#clientAddress(request))) {
      writeJson(response, 429, { error: 'too_many_login_attempts' });
      return;
    }
    let body: Buffer;
    try {
      body = await readLimitedBody(request, MAX_LOGIN_BODY_BYTES);
    } catch {
      writeJson(response, 400, { error: 'invalid_request_body' });
      return;
    }
    let username: unknown;
    try {
      username = (JSON.parse(body.toString('utf8')) as Record<string, unknown>).Username;
    } catch {
      username = undefined;
    }
    // Jellyfin's own AuthenticateByName is not scoped to a household; without this check the
    // household hostname would be a generic login proxy for every Jellyfin user, including
    // administrators, rather than just that household's visible members.
    if (typeof username !== 'string' || !(await this.#householdHasUsername(memberIds, username))) {
      writeJson(response, 401, { error: 'invalid_credentials' });
      return;
    }
    await this.#proxyBuffered(request, response, body);
  }

  async #householdHasUsername(memberIds: string[], username: string): Promise<boolean> {
    const allowed = new Set(memberIds.map((id) => id.toLowerCase()));
    const target = username.toLowerCase();
    let response: Response;
    try {
      response = await fetch(this.#targetUrl('/Users/Public'), { signal: AbortSignal.timeout(15_000) });
    } catch {
      return false;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    let users: unknown;
    try {
      users = await response.json();
    } catch {
      return false;
    }
    if (!Array.isArray(users)) return false;
    return users.some((user) => {
      if (!user || typeof user !== 'object' || Array.isArray(user)) return false;
      const record = user as Record<string, unknown>;
      return typeof record.Id === 'string' && allowed.has(record.Id.toLowerCase())
        && typeof record.Name === 'string' && record.Name.toLowerCase() === target;
    });
  }

  async #proxyBuffered(request: IncomingMessage, response: ServerResponse, body: Buffer): Promise<void> {
    await new Promise<void>((resolve) => {
      const headers: IncomingHttpHeaders = { ...request.headers, 'content-length': String(body.length) };
      const exchange = this.#exchange();
      const upstream = this.#transport().request(this.#requestOptions(request, headers), (upstreamResponse) => {
        relayResponse(upstreamResponse, response, exchange, resolve);
      });
      guardUpstream(upstream, response, exchange, resolve);
      upstream.end(body);
    });
  }

  async #proxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await new Promise<void>((resolve) => {
      const exchange = this.#exchange();
      const upstream = this.#transport().request(this.#requestOptions(request), (upstreamResponse) => {
        relayResponse(upstreamResponse, response, exchange, resolve);
      });
      guardUpstream(upstream, response, exchange, resolve);
      request.on('error', (error) => {
        exchange.error('client', 'proxy client request', error);
        upstream.destroy();
      });
      request.once('aborted', () => {
        exchange.clientGone();
        upstream.destroy();
      });
      request.pipe(upstream);
    });
  }

  async #proxyPublicUsers(request: IncomingMessage, response: ServerResponse, memberIds: string[]): Promise<void> {
    const allowed = new Set(memberIds.map((id) => id.toLowerCase()));
    await this.#proxyJson(request, response, 'invalid_jellyfin_public_users', (value) => {
      if (!Array.isArray(value)) throw new Error('public users must be an array');
      return value.filter((user): user is Record<string, unknown> =>
        Boolean(user) && typeof user === 'object' && !Array.isArray(user) &&
        typeof (user as Record<string, unknown>).Id === 'string' &&
        allowed.has(((user as Record<string, unknown>).Id as string).toLowerCase())
      ).map((user) =>
        // Jellyfin reports HasPassword=true even for empty passwords, which makes its web client
        // prompt for a password. Members marked passwordless in JellyPass sign in with one tap.
        this.#isPasswordless(user.Id as string) ? { ...user, HasPassword: false, HasConfiguredPassword: false } : user
      );
    });
  }

  async #proxyBrandingConfiguration(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await this.#proxyJson(request, response, 'invalid_jellyfin_branding_configuration', (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('branding configuration must be an object');
      }
      const branding = value as Record<string, unknown>;
      const existingCss = typeof branding.CustomCss === 'string' ? branding.CustomCss.trim() : '';
      const existingDisclaimer = typeof branding.LoginDisclaimer === 'string' ? branding.LoginDisclaimer.trim() : '';
      const styleElement = `<style id="jellypass-household-profile-picker">${HOUSEHOLD_LOGIN_CSS}</style>`;
      return {
        ...branding,
        CustomCss: existingCss ? `${existingCss}\n${HOUSEHOLD_LOGIN_CSS}` : HOUSEHOLD_LOGIN_CSS,
        LoginDisclaimer: existingDisclaimer ? `${existingDisclaimer}\n${styleElement}` : styleElement,
      };
    });
  }

  async #canAccessItem(request: IncomingMessage, requestUrl: URL, itemId: string): Promise<boolean> {
    const headers = new Headers({ Accept: 'application/json' });
    for (const name of ['authorization', 'x-emby-authorization', 'x-emby-token']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const authenticationQuery = new URLSearchParams();
    for (const [name, value] of requestUrl.searchParams) {
      if (['apikey', 'api_key', 'access_token'].includes(name.toLowerCase()) && value) {
        authenticationQuery.append(name, value);
      }
    }
    const suffix = authenticationQuery.size ? `?${authenticationQuery}` : '';
    const currentUserResponse = await fetch(this.#targetUrl(`/Users/Me${suffix}`), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!currentUserResponse.ok) {
      await currentUserResponse.body?.cancel();
      return false;
    }
    const currentUser = await currentUserResponse.json() as { Id?: unknown };
    if (typeof currentUser.Id !== 'string' || !currentUser.Id) return false;
    const itemResponse = await fetch(this.#targetUrl(
      `/Users/${encodeURIComponent(currentUser.Id)}/Items/${encodeURIComponent(itemId)}${suffix}`,
    ), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    await itemResponse.body?.cancel();
    return itemResponse.ok;
  }

  async #proxyJson(
    request: IncomingMessage,
    response: ServerResponse,
    invalidResponseCode: string,
    transform: (value: unknown) => unknown,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      const headers: IncomingHttpHeaders = { ...request.headers, 'accept-encoding': 'identity' };
      const exchange = this.#exchange();
      const upstream = this.#transport().request(this.#requestOptions(request, headers), (upstreamResponse) => {
        const chunks: Buffer[] = [];
        let size = 0;
        upstreamResponse.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_TRANSFORMED_JSON_BYTES) upstreamResponse.destroy(new Error('JSON response is too large'));
          else chunks.push(chunk);
        });
        upstreamResponse.on('error', (error) => {
          exchange.error('upstream', 'proxy upstream response', error);
          if (!response.headersSent) writeJson(response, 502, { error: 'jellyfin_unavailable' });
          resolve();
        });
        upstreamResponse.once('close', () => {
          if (upstreamResponse.complete) return;
          if (!response.headersSent) writeJson(response, 502, { error: 'jellyfin_unavailable' });
          resolve();
        });
        upstreamResponse.once('end', () => {
          if (response.headersSent) return resolve();
          const body = Buffer.concat(chunks);
          if (upstreamResponse.statusCode !== 200) {
            response.writeHead(upstreamResponse.statusCode ?? 502, sanitizedHeaders(upstreamResponse.headers, body.length));
            response.end(body);
            return resolve();
          }
          try {
            const encoded = Buffer.from(JSON.stringify(transform(JSON.parse(body.toString('utf8')) as unknown)));
            response.writeHead(200, sanitizedHeaders(upstreamResponse.headers, encoded.length));
            response.end(encoded);
          } catch {
            writeJson(response, 502, { error: invalidResponseCode });
          }
          resolve();
        });
      });
      guardUpstream(upstream, response, exchange, resolve);
      upstream.end();
    });
  }

  #requestOptions(request: IncomingMessage, headersInput?: IncomingHttpHeaders): RequestOptions {
    const headers = { ...(headersInput ?? request.headers) };
    headers.host = this.#target.host;
    if (request.headers.host) headers['x-forwarded-host'] = request.headers.host;
    // Jellyfin (with JellyPass in KnownProxies) and its logs see the household client rather than this gateway only if
    // each hop appends its own peer. Existing entries are kept: Jellyfin decides which of them it trusts.
    const peer = normaliseIp(request.socket.remoteAddress);
    if (peer) {
      const forwardedFor = joinedHeader(headers['x-forwarded-for']);
      headers['x-forwarded-for'] = forwardedFor ? `${forwardedFor}, ${peer}` : peer;
    }
    headers['x-forwarded-proto'] ??= 'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http';
    headers['x-real-ip'] ??= this.#clientAddress(request);
    return {
      protocol: this.#target.protocol,
      hostname: this.#target.hostname,
      port: this.#target.port || (this.#target.protocol === 'https:' ? 443 : 80),
      method: request.method,
      path: targetPath(this.#target, request.url ?? '/'),
      headers,
    };
  }

  #clientAddress(request: IncomingMessage): string {
    return this.#clientIp.resolve(request.socket.remoteAddress, request.headers['x-forwarded-for']);
  }

  #transport(): typeof http | typeof https {
    return this.#target.protocol === 'https:' ? https : http;
  }

  #targetUrl(pathname: string): URL {
    const url = new URL(this.#target.origin);
    const [path, query = ''] = targetPath(this.#target, pathname).split('?', 2);
    url.pathname = path as string;
    url.search = query;
    return url;
  }
}

const DISCONNECT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED']);
// TCP keepalive reports a client that vanished (sleeping TV, roaming phone) as ETIMEDOUT/EHOSTUNREACH. On the
// Jellyfin side the same codes mean the server or its network is unreachable, which is worth a warning.
const CLIENT_DISCONNECT_CODES = new Set([...DISCONNECT_CODES, 'ETIMEDOUT', 'EHOSTUNREACH']);

type ExchangeLog = (level: 'debug' | 'warn', message: string, fields: Record<string, unknown>) => void;

/**
 * Classifies stream errors for one proxied request or WebSocket. Client disconnects are routine (media seeks/skips,
 * closed tabs, sleeping TVs) and only logged with LOG_LEVEL=debug. Jellyfin-side errors log as warnings unless they are
 * the consequence of a failure already seen: our own abort after the client left ("socket hang up"/"aborted") or a
 * follow-on error from the same upstream reset.
 */
class Exchange {
  #firstFailure: 'client' | 'upstream' | undefined;

  public constructor(private readonly log: ExchangeLog) {}

  public clientGone(): void {
    this.#firstFailure ??= 'client';
  }

  public error(side: 'client' | 'upstream', context: string, error: unknown): void {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : undefined;
    const disconnect = code !== undefined && (side === 'client' ? CLIENT_DISCONNECT_CODES : DISCONNECT_CODES).has(code);
    const expected = disconnect && (side === 'client' || this.#firstFailure !== undefined);
    this.#firstFailure ??= side;
    this.log(expected ? 'debug' : 'warn', `household gateway ${context} error`, {
      code,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function unrefTimer(timeoutMs: number, callback: () => void): NodeJS.Timeout | undefined {
  if (timeoutMs <= 0) return undefined;
  const timer = setTimeout(callback, timeoutMs);
  timer.unref();
  return timer;
}

function enableTcpKeepAlive(socket: Duplex): void {
  if ('setKeepAlive' in socket && typeof socket.setKeepAlive === 'function') {
    (socket as Socket).setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
  }
}

function guardUpstream(upstream: http.ClientRequest, response: ServerResponse, exchange: Exchange, resolve: () => void): void {
  upstream.on('error', (error) => {
    exchange.error('upstream', 'proxy upstream request', error);
    if (!response.headersSent) writeJson(response, 502, { error: 'jellyfin_unavailable' });
    else response.destroy();
    resolve();
  });
  response.on('error', (error) => {
    exchange.error('client', 'proxy client response', error);
    upstream.destroy();
  });
  response.once('close', () => {
    if (!response.writableFinished) {
      exchange.clientGone();
      upstream.destroy();
    }
    resolve();
  });
}

function relayResponse(upstreamResponse: IncomingMessage, response: ServerResponse, exchange: Exchange, resolve: () => void): void {
  upstreamResponse.on('error', (error) => {
    exchange.error('upstream', 'proxy upstream response', error);
    response.destroy();
  });
  // An upstream reset mid-body aborts the response without 'end'; tear down the client side instead of hanging.
  upstreamResponse.once('close', () => {
    if (!upstreamResponse.complete) response.destroy();
  });
  response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
  upstreamResponse.pipe(response);
  upstreamResponse.once('end', resolve);
}

async function readLimitedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function protectedResourceItemId(pathname: string): string | undefined {
  const media = pathname.match(/^\/(?:videos|audio)\/([^/]+)\/(?:stream(?:\.[^/]*)?|master\.m3u8|main\.m3u8)$/i);
  if (media) return decodeURIComponent(media[1] as string);
  const download = pathname.match(/^\/items\/([^/]+)\/download$/i);
  return download ? decodeURIComponent(download[1] as string) : undefined;
}

function joinedHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value.join(', ') : value ?? '').trim();
}

function targetPath(target: URL, requestUrl: string): string {
  const base = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');
  return `${base}${requestUrl.startsWith('/') ? requestUrl : `/${requestUrl}`}`;
}

function sanitizedHeaders(headers: IncomingHttpHeaders, contentLength: number): IncomingHttpHeaders {
  const result = { ...headers };
  delete result['content-encoding'];
  delete result['transfer-encoding'];
  result['content-type'] = 'application/json; charset=utf-8';
  result['content-length'] = String(contentLength);
  result['cache-control'] = 'no-store';
  result['x-content-type-options'] = 'nosniff';
  return result;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': encoded.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(encoded);
}
