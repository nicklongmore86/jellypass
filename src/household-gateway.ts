import http, { type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';

const PUBLIC_USERS_PATH = '/users/public';
const BRANDING_CONFIGURATION_PATH = '/branding/configuration';
const QUICK_CONNECT_ENABLED_PATH = '/quickconnect/enabled';
const AUTHENTICATE_BY_NAME_PATH = '/users/authenticatebyname';
const FORGOT_PASSWORD_PATHS = new Set(['/users/forgotpassword', '/users/forgotpassword/pin']);
const MAX_TRANSFORMED_JSON_BYTES = 2 * 1024 * 1024;
const MAX_LOGIN_BODY_BYTES = 8 * 1024;
const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 20;
const HOUSEHOLD_LOGIN_CSS = `
/* JellyPass household profile picker */
#loginPage .manualLoginForm,
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
}

export class HouseholdGateway {
  readonly #target: URL;
  readonly #domain: string;
  readonly #hostPrefix: string;
  readonly #memberIds: HouseholdGatewayOptions['memberIds'];
  readonly #loginAttempts = new Map<string, { attempts: number; resetsAt: number }>();

  public constructor(options: HouseholdGatewayOptions) {
    this.#target = new URL(options.jellyfinUrl);
    if (this.#target.protocol !== 'http:' && this.#target.protocol !== 'https:') {
      throw new Error('household gateway requires an HTTP(S) Jellyfin URL');
    }
    this.#domain = options.domain.toLowerCase();
    this.#hostPrefix = options.hostPrefix.toLowerCase();
    this.#memberIds = options.memberIds;
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
    if (!this.#memberIds(householdId)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = this.#transport().request(this.#requestOptions(request));
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      const status = upstreamResponse.statusCode ?? 101;
      socket.write(`HTTP/1.1 ${status} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}\r\n`);
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
        socket.write(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}\r\n`);
      }
      socket.write('\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.once('close', () => upstreamSocket.destroy());
      upstreamSocket.once('close', () => socket.destroy());
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on('response', (upstreamResponse) => {
      socket.end(`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
    });
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
    upstream.end();
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
    if (!this.#allowLoginAttempt(request.socket.remoteAddress ?? 'unknown')) {
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
      const upstream = this.#transport().request(this.#requestOptions(request, headers), (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
        upstreamResponse.once('end', resolve);
      });
      upstream.once('error', () => {
        if (!response.headersSent) writeJson(response, 502, { error: 'jellyfin_unavailable' });
        else response.destroy();
        resolve();
      });
      upstream.end(body);
    });
  }

  async #proxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await new Promise<void>((resolve) => {
      const upstream = this.#transport().request(this.#requestOptions(request), (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
        upstreamResponse.once('end', resolve);
      });
      upstream.once('error', () => {
        if (!response.headersSent) writeJson(response, 502, { error: 'jellyfin_unavailable' });
        else response.destroy();
        resolve();
      });
      request.once('aborted', () => upstream.destroy());
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
      const upstream = this.#transport().request(this.#requestOptions(request, headers), (upstreamResponse) => {
        const chunks: Buffer[] = [];
        let size = 0;
        upstreamResponse.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_TRANSFORMED_JSON_BYTES) upstreamResponse.destroy(new Error('JSON response is too large'));
          else chunks.push(chunk);
        });
        upstreamResponse.once('error', () => {
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
      upstream.once('error', () => {
        if (!response.headersSent) writeJson(response, 502, { error: 'jellyfin_unavailable' });
        resolve();
      });
      upstream.end();
    });
  }

  #requestOptions(request: IncomingMessage, headersInput?: IncomingHttpHeaders): RequestOptions {
    const headers = { ...(headersInput ?? request.headers) };
    headers.host = this.#target.host;
    if (request.headers.host) headers['x-forwarded-host'] = request.headers.host;
    return {
      protocol: this.#target.protocol,
      hostname: this.#target.hostname,
      port: this.#target.port || (this.#target.protocol === 'https:' ? 443 : 80),
      method: request.method,
      path: targetPath(this.#target, request.url ?? '/'),
      headers,
    };
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
