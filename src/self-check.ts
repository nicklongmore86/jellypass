import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ClientIpResolver, normaliseIp } from './client-ip.js';
import type { JellyfinVersionStatus } from './jellyfin-version.js';

export interface SelfCheckResult { check: string; status: 'pass' | 'warn' | 'fail'; explanation: string }
export interface SelfCheckOptions {
  jellyfinUrl: string;
  jellyfinPublicUrls?: string[];
  seerrPublicUrl?: string;
  householdUrls: () => string[];
  trustedProxies?: string[];
  tmdbApiKey?: string;
  versionStatus?: () => SelfCheckResult;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}
/** The version check: refused household hosts fail it; they serve on an unconfirmed or unread version only in 'warn' mode (see JELLYFIN_VERSION_ENFORCEMENT). */
export function versionCheckResult(status: Pick<JellyfinVersionStatus, 'supported' | 'confirmation' | 'householdHosts'>): SelfCheckResult {
  if (status.supported) return { check: 'version', status: 'pass', explanation: 'Jellyfin is on a supported release.' };
  if (status.householdHosts !== 'serving') return { check: 'version', status: 'fail', explanation: 'Household hosts are paused by the Jellyfin version gate.' };
  const explanation = status.confirmation === 'confirmed' ? 'An administrator confirmed this untested Jellyfin version.'
    : status.confirmation === 'unconfirmed' ? 'This untested Jellyfin version is not confirmed; household hosts still serve.'
    : 'The Jellyfin version cannot be read; household hosts still serve.';
  return { check: 'version', status: 'warn', explanation };
}
export const PROXY_CHECK_PATH = '/jellypass/self-check/proxy';
const LIMIT_BYTES = 64 * 1024;

/** Configuration, never request input. Disallow credentials, queries and fragments so probes cannot disclose them. */
export function publicProbeUrls(input: string | undefined): string[] {
  const urls = [...new Set((input ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (urls.length > 64) throw new Error('Self-check supports at most 64 public URLs');
  return urls.map((value) => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Self-check URL must be a valid HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Self-check URLs must use HTTP(S), without credentials, queries or fragments');
    }
    return url.href.replace(/\/$/, '');
  });
}

/** No persisted results or tokens. A run consumes one global minute budget, including failed runs. */
export class SelfCheck {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #nextRun = 0;
  #running = false;
  readonly #pending = new Map<string, { url: URL; seen: boolean | undefined }>();
  constructor(private readonly options: SelfCheckOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  /** A random, one-run challenge only. Returns no raw headers, addresses, credentials or diagnostics to the caller. */
  public handleProxyRequest(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.method !== 'GET' || (request.url ?? '').split('?')[0] !== PROXY_CHECK_PATH) return false;
    const nonce = new URL(request.url ?? '/', 'http://localhost').searchParams.get('challenge') ?? '';
    const pending = this.#pending.get(nonce);
    if (!pending) return false;
    const forwarded = request.headers['x-forwarded-for'];
    const peer = normaliseIp(request.socket.remoteAddress);
    const resolver = new ClientIpResolver(this.options.trustedProxies);
    pending.seen = request.headers.host?.toLowerCase() === pending.url.host.toLowerCase()
      && request.headers['x-forwarded-proto'] === pending.url.protocol.slice(0, -1)
      && typeof forwarded === 'string' && forwarded.split(',').every((ip) => normaliseIp(ip) !== undefined)
      && peer !== undefined && resolver.isTrusted(peer);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end('{"status":"received"}');
    return true;
  }

  async #probe(url: string, headers: Record<string, string> = {}, signal?: AbortSignal, readBody = true): Promise<{ status: number; body?: unknown }> {
    const response = await this.#fetch(url, {
      method: 'GET', redirect: 'manual', credentials: 'omit',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 4000)]) : AbortSignal.timeout(this.options.timeoutMs ?? 4000), headers: { Accept: 'application/json', ...headers },
    });
    // Never follow any redirect, even to the same host. Bound response bodies and keep the timeout during reads.
    if (!readBody || !response.ok) { await response.body?.cancel().catch(() => {}); return { status: response.status }; }
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status };
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > LIMIT_BYTES) throw new Error('response too large');
        chunks.push(value);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Non-JSON reachability is still useful. */ }
      return { status: response.status, body };
    } finally { await reader.cancel().catch(() => {}); }
  }

  public async run(): Promise<SelfCheckResult[] | undefined> {
    if (this.#running || this.#now() < this.#nextRun) return undefined;
    this.#running = true;
    this.#nextRun = this.#now() + 60_000;
    const result = (check: string, status: SelfCheckResult['status'], explanation: string): SelfCheckResult => ({ check, status, explanation });
    const origin = async () => {
      const urls = this.options.jellyfinPublicUrls ?? [];
      if (!urls.length) return result('origin', 'warn', 'No Jellyfin public URL is configured. Direct access from outside cannot be determined here; test from a member network, including LAN and alternate proxy addresses.');
      for (const url of urls) {
        try {
          const answer = await this.#probe(`${url}/System/Info/Public`);
          if (answer.status === 200 && answer.body && typeof answer.body === 'object' && 'Version' in answer.body && 'ProductName' in answer.body) {
            return result('origin', 'fail', 'A configured Jellyfin public URL answers directly from this server. Members may bypass household checks. Restrict that origin, then verify from outside; internal reachability alone cannot prove external exposure.');
          }
        } catch { /* Report uncertainty without leaking URL or fetch errors. */ }
      }
      return result('origin', 'warn', 'Configured Jellyfin public URLs did not return server information here. This cannot prove they are blocked outside: check firewall, LAN addresses, split DNS and alternate proxy names from a member network.');
    };
    const quickConnect = async () => {
      try {
        const answer = await this.#probe(`${this.options.jellyfinUrl}/QuickConnect/Enabled`);
        if (answer.status === 200 && typeof answer.body === 'boolean') return result('quick_connect', answer.body ? 'fail' : 'pass', answer.body ? 'Quick Connect is enabled in Jellyfin. Disable it globally; household hosts already refuse it.' : 'Jellyfin reports Quick Connect disabled.');
      } catch { /* Unknown, not disabled. */ }
      return result('quick_connect', 'warn', 'Could not determine Jellyfin Quick Connect configuration.');
    };
    const proxy = async () => {
      const urls = this.options.householdUrls();
      if (!urls.length) return result('proxy', 'warn', 'No household public addresses are configured to probe.');
      let passed = 0;
      // Four workers and a shared deadline bound connections and total run duration.
      const deadline = Date.now() + (this.options.timeoutMs ?? 4000) * 2;
      const signal = AbortSignal.timeout((this.options.timeoutMs ?? 4000) * 2);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
        while (next < urls.length && Date.now() < deadline) {
          const value = urls[next++]!;
          const nonce = randomBytes(24).toString('hex');
          const url = new URL(value);
          const pending = { url, seen: undefined as boolean | undefined };
          this.#pending.set(nonce, pending);
          try {
            const answer = await this.#probe(`${value}${PROXY_CHECK_PATH}?challenge=${nonce}`, {}, signal);
            if (answer.status === 200 && pending.seen === true) passed++;
          } catch { /* Unreachable or timed out. */ }
          finally { this.#pending.delete(nonce); }
        }
      }));
      return result('proxy', passed === urls.length ? 'pass' : 'warn', `${passed} of ${urls.length} household addresses completed a self-request with preserved Host, valid X-Forwarded-For and matching X-Forwarded-Proto from a trusted proxy. This checks this server's route, not every external client path or spoofed-header sanitisation.`);
    };
    const seerr = async () => {
      if (!this.options.seerrPublicUrl) return result('seerr', 'warn', 'No Seerr public URL is configured. Check from a member network that Seerr is admin-only; member reachability cannot be determined here.');
      try {
        const answer = await this.#probe(this.options.seerrPublicUrl, {}, undefined, false);
        if (answer.status >= 100) return result('seerr', 'warn', 'The configured Seerr public URL responds (possibly with a redirect). Members may reach it directly. Seerr must be admin-only; verify access controls from a member network.');
      } catch { /* Inconclusive from inside. */ }
      return result('seerr', 'warn', 'Seerr did not respond successfully here. Verify from a member network that it is admin-only; an inside probe cannot prove this.');
    };
    const tmdb = async () => {
      const key = this.options.tmdbApiKey;
      if (!key) return result('tmdb', 'warn', 'No TMDB key is configured.');
      const v3 = /^[a-f0-9]{32}$/i.test(key);
      try {
        // The TMDB credential goes only to TMDB, never to any configured public URL.
        const answer = await this.#probe(`https://api.themoviedb.org/3/authentication${v3 ? `?api_key=${key}` : ''}`, v3 ? {} : { Authorization: `Bearer ${key}` });
        if (answer.status === 200 && answer.body && typeof answer.body === 'object' && 'success' in answer.body && answer.body.success === true) return result('tmdb', 'pass', 'TMDB accepted the configured key.');
        if ([401, 403].includes(answer.status)) return result('tmdb', 'fail', 'TMDB refused the configured key. Replace it in configuration.');
      } catch { /* Never expose fetch errors containing the key. */ }
      return result('tmdb', 'warn', 'TMDB key validity could not be determined (timeout, redirect or unexpected response).');
    };
    try {
      return await Promise.all([origin(), quickConnect(), proxy(), seerr(), Promise.resolve(this.options.versionStatus?.() ?? result('version', 'warn', 'Jellyfin version status is unavailable.')), tmdb()]);
    } finally { this.#running = false; }
  }
}
