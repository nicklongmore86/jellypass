/**
 * "New only", shared by the Discover page and the service and studio pages: one choice for the member signed in, **on
 * by default** (every sign-in starts with it on), in memory only and never stored: another member (or no one) signed in puts
 * it back on. Choosing it asks nothing: it only decides which of the cards already loaded are drawn (and the hero's slides).
 */
export class HidePreference {
  #owner: string | undefined;
  /** Whether the titles already in the library, and those asked for, are hidden. */
  public held = true;

  /** The member the choice belongs to: another one, or none, puts it back on. */
  public forMember(userId: string | undefined): void {
    if (userId === this.#owner) return;
    this.#owner = userId;
    this.held = true;
  }
}
