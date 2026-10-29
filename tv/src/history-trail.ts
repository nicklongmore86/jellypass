/**
 * Whether the member has come to a JellyPass page from somewhere else in Jellyfin web, so the Back button can use history:
 * the addresses seen since this page was loaded, in memory only. A new address goes on the trail; the address before the
 * last one coming round again is Back, and the last is dropped. A page opened by its own address (a bookmark, a reload) has
 * no trail, and its Back button goes to Jellyfin's Home instead of leaving Jellyfin web.
 */
export class HistoryTrail {
  #seen: string[];

  public constructor(first: string) {
    this.#seen = [first];
  }

  /** The address changed to `hash` (a hash change, whichever way it came). */
  public changed(hash: string): void {
    const seen = this.#seen;
    if (seen[seen.length - 1] === hash) return;
    if (seen.length > 1 && seen[seen.length - 2] === hash) seen.pop();
    else seen.push(hash);
    // A long session keeps its recent addresses only.
    if (seen.length > 100) seen.shift();
  }

  /** The session changed (a sign-out, another member, a new token): what was seen belongs to the last one, so only `hash` is left. */
  public reset(hash: string): void {
    this.#seen = [hash];
  }

  /** Whether history has an in-app address to go back to. */
  public get canGoBack(): boolean {
    return this.#seen.length > 1;
  }
}
