import { normalizeJellyfinUserId, type SeerrClient, type SeerrUserClient, type SeerrUserId } from './seerr.js';

/** How long a Jellyfin user's Seerr user is remembered once found. */
export const SEERR_USER_TTL_MS = 5 * 60_000;
/** How long "Seerr has no user for this Jellyfin user" is remembered, so a new import is picked up soon. */
export const SEERR_USER_MISSING_TTL_MS = 60_000;
/** Most Jellyfin users remembered at once; the least recently used is forgotten first. */
export const SEERR_USER_CACHE_MAX = 1_000;

interface CacheEntry {
  expiresAt: number;
  user: SeerrUserId | undefined;
}

/**
 * Maps Jellyfin users to the Seerr users that act for them, with Seerr's GET /api/v1/user/jellyfin/:id (made with the
 * admin key). A Jellyfin user Seerr has no user for is unmapped: {@link SeerrUserMap.clientFor} then answers undefined,
 * and the caller must treat the title as unavailable. Nothing falls back to the admin client or imports the user;
 * Seerr users are created where they are today, by importing a Jellyfin user from the admin API.
 *
 * Found and missing users are cached (for {@link SEERR_USER_TTL_MS} and {@link SEERR_USER_MISSING_TTL_MS}), up to
 * {@link SEERR_USER_CACHE_MAX} entries. Failed lookups are not cached, and concurrent lookups for one user share a call.
 */
export class SeerrUserMap {
  readonly #seerr: SeerrClient;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #missingTtlMs: number;
  readonly #maxEntries: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #pending = new Map<string, Promise<SeerrUserId | undefined>>();

  public constructor(seerr: SeerrClient, options: { now?: () => number; ttlMs?: number; missingTtlMs?: number; maxEntries?: number } = {}) {
    this.#seerr = seerr;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? SEERR_USER_TTL_MS;
    this.#missingTtlMs = options.missingTtlMs ?? SEERR_USER_MISSING_TTL_MS;
    this.#maxEntries = Math.max(1, options.maxEntries ?? SEERR_USER_CACHE_MAX);
  }

  /** The client acting as this Jellyfin user's Seerr user, or undefined if they have none. Throws if Seerr fails. */
  public async clientFor(jellyfinUserId: string): Promise<SeerrUserClient | undefined> {
    const user = await this.seerrUserId(jellyfinUserId);
    return user === undefined ? undefined : this.#seerr.asUser(user);
  }

  /** This Jellyfin user's Seerr user ID, or undefined if they have none. Throws if Seerr fails. */
  public async seerrUserId(jellyfinUserId: string): Promise<SeerrUserId | undefined> {
    const key = normalizeJellyfinUserId(jellyfinUserId);
    if (!key) return undefined;
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key);
      if (cached.expiresAt > this.#now()) {
        this.#cache.set(key, cached);
        return cached.user;
      }
    }
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = this.#lookUp(key).finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    return pending;
  }

  /** Forgets every cached user, for example after users were imported into or removed from Seerr. */
  public clear(): void {
    this.#cache.clear();
  }

  async #lookUp(key: string): Promise<SeerrUserId | undefined> {
    const user = (await this.#seerr.findUserByJellyfinId(key))?.id;
    this.#cache.set(key, { expiresAt: this.#now() + (user === undefined ? this.#missingTtlMs : this.#ttlMs), user });
    while (this.#cache.size > this.#maxEntries) {
      this.#cache.delete(this.#cache.keys().next().value as string);
    }
    return user;
  }
}
