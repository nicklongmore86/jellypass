import type { HouseholdState, MediaType } from './api.js';

/** How long a title the member just asked for is shown as requested before the server's own answer is trusted alone. */
export const ASKED_TTL_MS = 2 * 60 * 1000;

/** How often, at most, a running Requested looks at the wall clock again while the screen is left alone. */
export const ASKED_CHECK_MS = 15 * 1000;

/** When a key was added, on each clock. */
interface At {
  mono: number;
  wall: number;
}

/**
 * What the signed-in member asked for with "Get this" on this TV, in memory only (never stored, never sent), shared by
 * the Home row and the title view: the household app's overlay (app/src/asked.ts). The server records a "Get this" a
 * moment after it accepts the call, so an answer read right afterwards can still say `get_this`. A key (`movie:<id>`,
 * `tv:<id>`, `tv:<id>:<season>`) is added only after the API accepted the call, lives {@link ASKED_TTL_MS}, and is
 * dropped as soon as the server says anything but `get_this` for it. It belongs to one member: another member, signing
 * out or a refused token forgets all of it.
 *
 * As in the app, a key ends when the monotonic clock has run {@link ASKED_TTL_MS} or the wall clock has moved forward by
 * that much: the monotonic clock (and the timers on it) can stand still while the TV sleeps, so the wall clock catches a
 * long sleep; a wall clock set back is ignored, so it can never stretch the window.
 *
 * A Requested that runs out on a screen left alone is not left showing: one timer, set for the earliest end (and at
 * most {@link ASKED_CHECK_MS} away, to look at the wall clock again), drops what has ended and calls `expired` so the
 * row and an open view draw their statuses again from what they hold (no call). Forgetting the overlay, or its last key
 * ending, clears the timer.
 */
export class Asked {
  readonly #now: () => number;
  readonly #wall: () => number;
  readonly #expired: () => void;
  #owner: string | undefined;
  #at: { [key: string]: At } = {};
  #timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(now: () => number, wall: () => number, expired: () => void = () => undefined) {
    this.#now = now;
    this.#wall = wall;
    this.#expired = expired;
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
    this.#schedule();
  }

  /** The member's accepted "Get this", if they are still the one signed in: a series also marks the seasons asked for. */
  public add(userId: string, mediaType: MediaType, tmdbId: number, seasons: number[]): void {
    if (userId !== this.#owner) return;
    const at = { mono: this.#now(), wall: this.#wall() };
    const key = `${mediaType}:${tmdbId}`;
    this.#at[key] = at;
    if (mediaType === 'tv') for (const season of seasons) this.#at[`${key}:${season}`] = at;
    this.#schedule();
  }

  /** The state to show for a title (`season` undefined) or one of a series' seasons, given the server's. */
  public state(mediaType: MediaType, tmdbId: number, server: HouseholdState, season?: number): HouseholdState {
    const key = season === undefined ? `${mediaType}:${tmdbId}` : `${mediaType}:${tmdbId}:${season}`;
    const at = this.#at[key];
    if (at === undefined) return server;
    if (server !== 'get_this' || this.#left(at) <= 0) {
      delete this.#at[key];
      return server;
    }
    return 'requested';
  }

  /** How long a key has left: the less of what each clock gives it (a wall clock set back gives it no more). */
  #left(at: At): number {
    const sinceWall = this.#wall() - at.wall;
    return ASKED_TTL_MS - Math.max(this.#now() - at.mono, sinceWall > 0 ? sinceWall : 0);
  }

  /** The timer, set again for the earliest end of a key still running (none when there is none). */
  #schedule(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    let soonest: number | undefined;
    for (const key of Object.keys(this.#at)) {
      const left = this.#left(this.#at[key] as At);
      if (soonest === undefined || left < soonest) soonest = left;
    }
    if (soonest === undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      let ended = false;
      for (const key of Object.keys(this.#at)) {
        if (this.#left(this.#at[key] as At) > 0) continue;
        delete this.#at[key];
        ended = true;
      }
      this.#schedule();
      if (ended) this.#expired();
    }, Math.min(ASKED_CHECK_MS, Math.max(0, soonest)));
  }
}
