import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { JellyfinClient } from './jellyfin.js';

const SESSION_SECONDS = 12 * 60 * 60;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 8;

interface Session {
  username: string;
  expiresAt: number;
}

interface FailureBucket {
  attempts: number;
  resetsAt: number;
}

export class WebAuth {
  readonly #jellyfin: JellyfinClient;
  readonly #sessions = new Map<string, Session>();
  readonly #failures = new Map<string, FailureBucket>();

  public constructor(jellyfin: JellyfinClient) {
    this.#jellyfin = jellyfin;
  }

  public async login(username: string, password: string, clientId: string): Promise<{ token: string; username: string } | null> {
    const now = Date.now();
    const bucket = this.#failures.get(clientId);
    if (bucket && bucket.resetsAt > now && bucket.attempts >= MAX_FAILURES) {
      throw new Error('too_many_login_attempts');
    }
    const user = await this.#jellyfin.authenticateAdministrator(username, password);
    if (!user) {
      const current = bucket && bucket.resetsAt > now ? bucket : { attempts: 0, resetsAt: now + FAILURE_WINDOW_MS };
      current.attempts += 1;
      this.#failures.set(clientId, current);
      return null;
    }
    this.#failures.delete(clientId);
    this.#purgeExpired();
    const token = randomBytes(32).toString('base64url');
    this.#sessions.set(sessionKey(token), { username: user.Name, expiresAt: now + SESSION_SECONDS * 1000 });
    return { token, username: user.Name };
  }

  public session(request: IncomingMessage): Session | undefined {
    this.#purgeExpired();
    const token = cookieValue(request, 'jellypass_session');
    if (!token) return undefined;
    return this.#sessions.get(sessionKey(token));
  }

  public logout(request: IncomingMessage): void {
    const token = cookieValue(request, 'jellypass_session');
    if (token) this.#sessions.delete(sessionKey(token));
  }

  #purgeExpired(): void {
    const now = Date.now();
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(key);
    }
    for (const [key, bucket] of this.#failures) {
      if (bucket.resetsAt <= now) this.#failures.delete(key);
    }
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return `jellypass_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}

export function expiredSessionCookie(secure: boolean): string {
  return `jellypass_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

function sessionKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const pair of request.headers.cookie?.split(';') ?? []) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return undefined;
}
