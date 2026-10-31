import type { HouseholdState, MediaType } from './api.js';

/** How long a title the member just asked for is shown as requested before the server's own answer is trusted alone. */
export const ASKED_TTL_MS = 2 * 60 * 1000;

/** How often, at most, a running Requested looks at the wall clock again while the screen is left alone. */
export const ASKED_CHECK_MS = 15 * 1000;

/** At most this many of the member's own hides and unhides are remembered; the oldest go first (the server allows 2,000 hides). */
export const HIDDEN_CHANGES_MAX = 500;

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
 *
 * A request the member cancelled (`withdraw`, from My requests) is the other way round, as in the app: the server
 * withdraws it a moment after it accepts the call, so for the same two minutes the title and each of its seasons read as
 * `get_this` while the server still says `requested`. Each key (the title's, a season's) stops being covered on its own
 * as soon as the server says anything but `requested` for it, and all of them when the member asks for the title again.
 */
export class Asked {
  readonly #now: () => number;
  readonly #wall: () => number;
  readonly #expired: () => void;
  #owner: string | undefined;
  #at: { [key: string]: At } = {};
  /** Titles (`movie:<id>`, `tv:<id>`) whose cancel was accepted: covers the title's own key and its seasons'. */
  #withdrawn: { [title: string]: At } = {};
  /** Keys (the title's or a season's) whose withdrawal ended: the server said something but `requested` for them. */
  #ended: { [key: string]: true } = {};
  /**
   * What the member hid or unhid on this TV in this sign-in (`movie:<id>`, `tv:<id>`), with a count taken when it was
   * accepted. The server leaves a member's hidden titles out of every list itself, so this only covers answers kept from
   * before (Home's row, the Discover page's cache) and reads that began before the change. See {@link hiddenNow}.
   */
  #hidden = new Map<string, { hidden: boolean; at: number }>();
  #tick = 0;
  /** Bumped each time the overlay is forgotten, so a change sent before is not written for whoever is signed in after. */
  #epoch = 0;
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
    this.#withdrawn = {};
    this.#ended = {};
    this.#hidden = new Map();
    this.#owner = undefined;
    this.#epoch += 1;
    this.#schedule();
  }

  /**
   * The overlay's number now: a new one after every forgetting (sign-out, another member, a refused token). A hide or
   * unhide sent under one number and answered under another is nobody's now: it is neither written nor shown.
   */
  public epoch(): number {
    return this.#epoch;
  }

  /** The member's accepted "Get this", if they are still the one signed in: a series also marks the seasons asked for. */
  public add(userId: string, mediaType: MediaType, tmdbId: number, seasons: number[]): void {
    if (userId !== this.#owner) return;
    const at = { mono: this.#now(), wall: this.#wall() };
    const key = `${mediaType}:${tmdbId}`;
    delete this.#withdrawn[key];
    this.#endTitle(key);
    this.#at[key] = at;
    if (mediaType === 'tv') for (const season of seasons) this.#at[`${key}:${season}`] = at;
    this.#schedule();
  }

  /**
   * The member's accepted cancel of a request, if they are still the one signed in: the title and every season of it read
   * as available to get while the server withdraws it (see above). Any "Get this" for it that was still showing ends.
   */
  public withdraw(userId: string, mediaType: MediaType, tmdbId: number): void {
    if (userId !== this.#owner) return;
    const title = `${mediaType}:${tmdbId}`;
    for (const key of Object.keys(this.#at)) if (key === title || key.indexOf(`${title}:`) === 0) delete this.#at[key];
    this.#endTitle(title);
    this.#withdrawn[title] = { mono: this.#now(), wall: this.#wall() };
    this.#schedule();
  }

  /** The member's accepted hide (`hidden` true) or unhide of a title, if they are still the one signed in. */
  public hide(userId: string, mediaType: MediaType, tmdbId: number, hidden: boolean): void {
    if (userId !== this.#owner) return;
    const key = `${mediaType}:${tmdbId}`;
    this.#hidden.delete(key);
    this.#tick += 1;
    this.#hidden.set(key, { hidden, at: this.#tick });
    while (this.#hidden.size > HIDDEN_CHANGES_MAX) {
      const oldest = this.#hidden.keys().next();
      if (oldest.done) break;
      this.#hidden.delete(oldest.value);
    }
  }

  /** A mark taken when a read begins, for {@link hiddenNow}: a change accepted after it is newer than that read's answer. */
  public hiddenMark(): number {
    return this.#tick;
  }

  /**
   * Whether the member has the title hidden, given the answer's own `hidden` flag (undefined from a server without hiding)
   * or its absence from a list (nothing known). The member's own change on this TV wins over an answer kept from before
   * it; with `mark` (taken when a read began), a change that was already accepted then is the answer's to correct: the
   * answer is the server's word, and is what answers kept from before it are corrected to. The change itself is kept,
   * since those older answers (Home's row, the Discover page's cache) still carry the flag from before it.
   */
  public hiddenNow(mediaType: MediaType, tmdbId: number, server?: boolean, mark?: number): boolean {
    const key = `${mediaType}:${tmdbId}`;
    const change = this.#hidden.get(key);
    if (change === undefined) return server === true;
    if (mark !== undefined && change.at <= mark && server !== undefined) {
      change.hidden = server;
      return server;
    }
    return change.hidden;
  }

  /** The state to show for a title (`season` undefined) or one of a series' seasons, given the server's. */
  public state(mediaType: MediaType, tmdbId: number, server: HouseholdState, season?: number): HouseholdState {
    const title = `${mediaType}:${tmdbId}`;
    const key = season === undefined ? title : `${title}:${season}`;
    const since = this.#withdrawn[title];
    if (since !== undefined) {
      if (this.#left(since) <= 0) {
        delete this.#withdrawn[title];
        this.#endTitle(title);
      } else if (!this.#ended[key]) {
        if (server === 'requested') return 'get_this';
        this.#ended[key] = true;
      }
    }
    const at = this.#at[key];
    if (at === undefined) return server;
    if (server !== 'get_this' || this.#left(at) <= 0) {
      delete this.#at[key];
      return server;
    }
    return 'requested';
  }

  #endTitle(title: string): void {
    for (const key of Object.keys(this.#ended)) if (key === title || key.indexOf(`${title}:`) === 0) delete this.#ended[key];
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
    for (const set of [this.#at, this.#withdrawn]) {
      for (const key of Object.keys(set)) {
        const left = this.#left(set[key] as At);
        if (soonest === undefined || left < soonest) soonest = left;
      }
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
      for (const title of Object.keys(this.#withdrawn)) {
        if (this.#left(this.#withdrawn[title] as At) > 0) continue;
        delete this.#withdrawn[title];
        this.#endTitle(title);
        ended = true;
      }
      this.#schedule();
      if (ended) this.#expired();
    }, Math.min(ASKED_CHECK_MS, Math.max(0, soonest)));
  }
}
