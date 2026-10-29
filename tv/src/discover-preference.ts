/**
 * "Hide what I have", shared by the Discover page and the service and studio pages: one choice for the member signed in, in
 * memory only, forgotten when another member (or no one) is signed in. Choosing it asks nothing: it only decides which of the
 * cards already loaded are drawn.
 */
export class HidePreference {
  #owner: string | undefined;
  /** Whether the titles already in the library, and those asked for, are hidden. */
  public held = false;

  /** The member the choice belongs to: another one, or none, forgets it. */
  public forMember(userId: string | undefined): void {
    if (userId === this.#owner) return;
    this.#owner = userId;
    this.held = false;
  }
}
