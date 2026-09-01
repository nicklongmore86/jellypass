import http, { type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';

const PUBLIC_USERS_PATH = '/users/public';
const BRANDING_CONFIGURATION_PATH = '/branding/configuration';
const MAX_TRANSFORMED_JSON_BYTES = 2 * 1024 * 1024;
const HOUSEHOLD_LOGIN_CSS = `
/* JellyPass household profile picker */
#loginPage .manualLoginForm,
#loginPage .readOnlyContent {
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
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname.toLowerCase();
    if (request.method === 'GET' && pathname === PUBLIC_USERS_PATH) {
      await this.#proxyPublicUsers(request, response, memberIds);
      return;
    }
    if (request.method === 'GET' && pathname === BRANDING_CONFIGURATION_PATH) {
      await this.#proxyBrandingConfiguration(request, response);
      return;
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
