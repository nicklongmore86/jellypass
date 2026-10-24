import { normalizeJellyfinUserId, SeerrMemberClient, type SeerrClient, type SeerrUserId, type SeerrUserResolver } from './seerr.js';

/** How long a Jellyfin user's Seerr user is offered as the candidate once found (it is still confirmed before each call). */
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
 * admin key), and makes the {@link SeerrMemberClient}s that act for them. A Jellyfin user Seerr has no user for is
 * unmapped: their calls fail with `SeerrUnmappedUserError`, and the caller must treat the title as unavailable.
 * Nothing falls back to the admin client or imports the user; Seerr users are created where they are today, by
 * importing a Jellyfin user from the admin API.
 *
 * The map only proposes candidates: every member call is confirmed with Seerr immediately before it is sent (see
 * {@link SeerrMemberClient}), so a stale entry can cost a lookup but never acts as anyone else. Found and missing users
 * are cached (for {@link SEERR_USER_TTL_MS} and {@link SEERR_USER_MISSING_TTL_MS}), up to {@link SEERR_USER_CACHE_MAX}
 * entries. Failed lookups are not cached, and concurrent lookups for one user share a call.
 *
 * - A candidate Seerr no longer links to the Jellyfin user, or a 401, 403 or 404 from Seerr on a call made as it, is
 *   forgotten.
 * - {@link invalidate} and {@link clear} forget mappings at once, including lookups still in flight: those can no
 *   longer fill the cache, and later callers start a new lookup instead of joining them. A call being confirmed when
 *   its user is invalidated is confirmed again before it is sent.
 */
export class SeerrUserMap implements SeerrUserResolver {
  readonly #seerr: SeerrClient;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #missingTtlMs: number;
  readonly #maxEntries: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #pending = new Map<string, Promise<SeerrUserId | undefined>>();
  /** Invalidation stamps from one counter that never repeats, so a forgotten stamp still reads as a change. */
  readonly #versions = new Map<string, number>();
  #counter = 0;
  #clearedAt = 0;

  public constructor(seerr: SeerrClient, options: { now?: () => number; ttlMs?: number; missingTtlMs?: number; maxEntries?: number } = {}) {
    this.#seerr = seerr;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? SEERR_USER_TTL_MS;
    this.#missingTtlMs = options.missingTtlMs ?? SEERR_USER_MISSING_TTL_MS;
    this.#maxEntries = Math.max(1, options.maxEntries ?? SEERR_USER_CACHE_MAX);
  }

  /**
   * The client for this Jellyfin user's own Seerr data, or undefined if `jellyfinUserId` is not a Jellyfin user ID. It
   * holds the Jellyfin user, not a Seerr user, and confirms the Seerr user before every call, so it may be kept.
   */
  public member(jellyfinUserId: string): SeerrMemberClient | undefined {
    const key = normalizeJellyfinUserId(jellyfinUserId);
    return key ? new SeerrMemberClient(this.#seerr, key, this) : undefined;
  }

  /**
   * The Seerr user this Jellyfin user is believed to have, from the cache, or undefined if they have none. Unconfirmed:
   * it says nothing about who a call would act as. Throws if Seerr fails.
   */
  public async candidate(jellyfinUserId: string): Promise<SeerrUserId | undefined> {
    const key = normalizeJellyfinUserId(jellyfinUserId);
    return key ? this.#resolve(key) : undefined;
  }

  /** Forgets `user` as this Jellyfin user's mapping if it still is, so a newer answer is kept. */
  public forget(jellyfinUserId: string, user: SeerrUserId): void {
    const key = normalizeJellyfinUserId(jellyfinUserId);
    if (key && this.#cache.get(key)?.user === user) this.#cache.delete(key);
  }

  /** Changes whenever this Jellyfin user's mapping is invalidated or every mapping is cleared. */
  public version(jellyfinUserId: string): number {
    const key = normalizeJellyfinUserId(jellyfinUserId);
    return (key && this.#versions.get(key)) || this.#clearedAt;
  }

  /** Forgets one Jellyfin user's mapping, for example after they were relinked or removed in Seerr. */
  public invalidate(jellyfinUserId: string): void {
    const key = normalizeJellyfinUserId(jellyfinUserId);
    if (!key) return;
    this.#cache.delete(key);
    this.#pending.delete(key);
    this.#versions.delete(key);
    this.#versions.set(key, ++this.#counter);
    while (this.#versions.size > this.#maxEntries) {
      this.#versions.delete(this.#versions.keys().next().value as string);
    }
  }

  /** Forgets every mapping, for example after users were imported into or removed from Seerr. */
  public clear(): void {
    this.#cache.clear();
    this.#pending.clear();
    this.#versions.clear();
    this.#clearedAt = ++this.#counter;
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
}
