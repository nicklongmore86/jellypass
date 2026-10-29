import { currentSession, type Session } from './jellyfin-web.js';

/** The session a call was sent under: who, with which token, and which sign-in generation (see `SessionWatch`). */
export interface Stamp {
  userId: string;
  token: string;
  generation: number;
}

/**
 * One place that decides whether a late answer still belongs to the session that asked. Jellyfin web's sign-out does
 * not reload this script, so a call can come back after a sign-out, or after the same member signed in again with a new
 * token: that answer (success or failure, 401 included) must touch nothing of the new session. A generation is bumped
 * whenever the member or the token seen here changes, so a token that changes and changes back is still a new session.
 */
export class SessionWatch {
  readonly #scope: { ApiClient?: unknown };
  readonly #origin: string;
  #key: string | undefined;
  #generation = 0;

  public constructor(scope: { ApiClient?: unknown }, origin: string) {
    this.#scope = scope;
    this.#origin = origin;
  }

  /** The current session if signed in to this origin (bumping the generation if it is not the one last seen). */
  public current(): Session | undefined {
    const found = currentSession(this.#scope);
    const session = found && found.origin === this.#origin ? found : undefined;
    const key = session ? `${session.userId}\n${session.token}` : undefined;
    if (key !== this.#key) {
      this.#key = key;
      this.#generation += 1;
    }
    return session;
  }

  /** The sign-in generation now: it differs from an earlier one whenever the member or the token seen here changed since (signing out included). */
  public snapshot(): number {
    this.current();
    return this.#generation;
  }

  /** Marks `session` (the one a call is sent under) so its answer can be checked with `holds`. */
  public stamp(session: Session): Stamp {
    this.current();
    return { userId: session.userId, token: session.token, generation: this.#generation };
  }

  /** The current session, only if it is the very one `stamp` was taken under; otherwise undefined: ignore the answer. */
  public holds(stamp: Stamp): Session | undefined {
    const session = this.current();
    return session && session.userId === stamp.userId && session.token === stamp.token && this.#generation === stamp.generation ? session : undefined;
  }
}
