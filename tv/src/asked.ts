import type { HouseholdState, MediaType } from './api.js';

/** How long a title the member just asked for is shown as requested before the server's own answer is trusted alone. */
export const ASKED_TTL_MS = 2 * 60 * 1000;

/**
 * What the signed-in member asked for with "Get this" on this TV, in memory only (never stored, never sent), shared by
 * the Home row and the title view: the household app's overlay (app/src/asked.ts). The server records a "Get this" a
 * moment after it accepts the call, so an answer read right afterwards can still say `get_this`. A key (`movie:<id>`,
 * `tv:<id>`, `tv:<id>:<season>`) is added only after the API accepted the call, lives {@link ASKED_TTL_MS} (a clock set
 * back ends it rather than stretching it), and is dropped as soon as the server says anything but `get_this` for it.
 * It belongs to one member: another member, signing out or a refused token forgets all of it.
 */
export class Asked {
  readonly #now: () => number;
  #owner: string | undefined;
  #at: { [key: string]: number } = {};

  public constructor(now: () => number) {
    this.#now = now;
  }

  /** Keeps the overlay only for `userId` (the member signed in now; undefined when no one is). */
  public sync(userId: string | undefined): void {
    if (userId === this.#owner) return;
    this.forget();
    this.#owner = userId;
  }

  public forget(): void {
    this.#at = {};
    this.#owner = undefined;
  }

  /** The member's accepted "Get this", if they are still the one signed in: a series also marks the seasons asked for. */
  public add(userId: string, mediaType: MediaType, tmdbId: number, seasons: number[]): void {
    if (userId !== this.#owner) return;
    const at = this.#now();
    const key = `${mediaType}:${tmdbId}`;
    this.#at[key] = at;
    if (mediaType === 'tv') for (const season of seasons) this.#at[`${key}:${season}`] = at;
  }

  /** The state to show for a title (`season` undefined) or one of a series' seasons, given the server's. */
  public state(mediaType: MediaType, tmdbId: number, server: HouseholdState, season?: number): HouseholdState {
    const key = season === undefined ? `${mediaType}:${tmdbId}` : `${mediaType}:${tmdbId}:${season}`;
    const at = this.#at[key];
    if (at === undefined) return server;
    const since = this.#now() - at;
    if (server !== 'get_this' || since < 0 || since >= ASKED_TTL_MS) {
      delete this.#at[key];
      return server;
    }
    return 'requested';
  }
}
