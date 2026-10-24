import { normalizeJellyfinUserId, type SeerrClient, type SeerrUserClient, type SeerrUserId } from './seerr.js';

/** How long a Jellyfin user's Seerr user is trusted for read-only calls once found. */
export const SEERR_USER_TTL_MS = 60_000;
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
 * A Seerr relink or deletion can leave a cached mapping stale, so:
 *
 * - {@link verifiedClientFor}, for every state-changing or user-scoped call, checks with Seerr's GET /api/v1/user/:id
 *   that the Seerr user is still linked to this Jellyfin user before each use, and otherwise looks the user up again
 *   (once) or fails closed;
 * - {@link clientFor}, for read-only title calls only, trusts the cache for at most {@link SEERR_USER_TTL_MS};
 * - a 401, 403 or 404 from Seerr on a call made through either client forgets that user's mapping;
 * - {@link invalidate} and {@link clear} forget mappings at once, including lookups still in flight: those can no
 *   longer fill the cache, and later callers start a new lookup instead of joining them.
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

  /**
   * The client acting as this Jellyfin user's Seerr user, or undefined if they have none, from the cache. For read-only
   * title calls only (search, discover, movie, tv, season). Throws if Seerr fails.
   */
  public async clientFor(jellyfinUserId: string): Promise<SeerrUserClient | undefined> {
    const key = normalizeJellyfinUserId(jellyfinUserId);
    if (!key) return undefined;
    const user = await this.#resolve(key);
    return user === undefined ? undefined : this.#clientAs(key, user);
  }

  /**
   * The client acting as this Jellyfin user's Seerr user after Seerr has confirmed, just now, that the Seerr user is
   * still linked to them; undefined if they have none or the link cannot be confirmed. For every state-changing or
   * user-scoped call (createRequest, ownRequests, quota, watchlist). Throws if Seerr fails.
   */
  public async verifiedClientFor(jellyfinUserId: string): Promise<SeerrUserClient | undefined> {
    const key = normalizeJellyfinUserId(jellyfinUserId);
    if (!key) return undefined;
    // A stale mapping is forgotten and looked up once more; a second mismatch means Seerr is changing under us.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const user = await this.#resolve(key);
      if (user === undefined) return undefined;
      if (await this.#seerr.jellyfinUserIdOf(user) === key) return this.#clientAs(key, user);
      this.#forget(key, user);
    }
    return undefined;
  }

  /** This Jellyfin user's Seerr user ID from the cache, or undefined if they have none. Throws if Seerr fails. */
  public async seerrUserId(jellyfinUserId: string): Promise<SeerrUserId | undefined> {
    const key = normalizeJellyfinUserId(jellyfinUserId);
    return key ? this.#resolve(key) : undefined;
  }

  /** Forgets one Jellyfin user's mapping, for example after they were relinked or removed in Seerr. */
  public invalidate(jellyfinUserId: string): void {
    const key = normalizeJellyfinUserId(jellyfinUserId);
    if (!key) return;
    this.#cache.delete(key);
    this.#pending.delete(key);
  }

  /** Forgets every mapping, for example after users were imported into or removed from Seerr. */
  public clear(): void {
    this.#cache.clear();
    this.#pending.clear();
  }

  #resolve(key: string): Promise<SeerrUserId | undefined> {
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key);
      if (cached.expiresAt > this.#now()) {
        this.#cache.set(key, cached);
        return Promise.resolve(cached.user);
      }
    }
    const pending = this.#pending.get(key);
    if (pending) return pending;
    // Only the lookup still registered as pending may fill the cache, so one forgotten by invalidate() or clear()
    // answers its own callers but nobody later.
    const lookup: Promise<SeerrUserId | undefined> = this.#seerr.findUserByJellyfinId(key)
      .then((found) => {
        const user = found?.id;
        if (this.#pending.get(key) === lookup) this.#remember(key, user);
        return user;
      })
      .finally(() => {
        if (this.#pending.get(key) === lookup) this.#pending.delete(key);
      });
    this.#pending.set(key, lookup);
    return lookup;
  }

  #remember(key: string, user: SeerrUserId | undefined): void {
    this.#cache.set(key, { expiresAt: this.#now() + (user === undefined ? this.#missingTtlMs : this.#ttlMs), user });
    while (this.#cache.size > this.#maxEntries) {
      this.#cache.delete(this.#cache.keys().next().value as string);
    }
  }

  /** Forgets `key`'s mapping if it is still `user`, so a newer answer is kept. */
  #forget(key: string, user: SeerrUserId): void {
    if (this.#cache.get(key)?.user === user) this.#cache.delete(key);
  }

  #clientAs(key: string, user: SeerrUserId): SeerrUserClient {
    return this.#seerr.asUser(user, { onRejected: () => this.#forget(key, user) });
  }
}
