export interface AttemptCounterOptions {
  windowMs: number;
  /** Most clients tracked at once; the oldest window is evicted to admit a new client. */
  maxKeys: number;
  now?: () => number;
}

/**
 * Per-client attempt counts over a fixed window, in bounded memory. A client's window starts with its first counted
 * attempt. Every window has the same length and a new window is inserted at the end of the map, so the map stays ordered
 * by expiry: each access drops expired windows from the front, and a full map evicts the window that ends soonest.
 */
export class AttemptCounter {
  readonly #windows = new Map<string, { attempts: number; resetsAt: number }>();
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;

  public constructor(options: AttemptCounterOptions) {
    this.#windowMs = options.windowMs;
    this.#maxKeys = Math.max(1, options.maxKeys);
    this.#now = options.now ?? Date.now;
  }

  public get size(): number {
    this.#expire(this.#now());
    return this.#windows.size;
  }

  public attempts(key: string): number {
    const now = this.#now();
    this.#expire(now);
    const window = this.#windows.get(key);
    return window && window.resetsAt > now ? window.attempts : 0;
  }

  public increment(key: string): number {
    const now = this.#now();
    this.#expire(now);
    const window = this.#windows.get(key);
    if (window && window.resetsAt > now) return ++window.attempts;
    this.#windows.delete(key);
    while (this.#windows.size >= this.#maxKeys) {
      this.#windows.delete(this.#windows.keys().next().value as string);
    }
    this.#windows.set(key, { attempts: 1, resetsAt: now + this.#windowMs });
    return 1;
  }

  public delete(key: string): void {
    this.#windows.delete(key);
  }

  #expire(now: number): void {
    for (const [key, window] of this.#windows) {
      if (window.resetsAt > now) return;
      this.#windows.delete(key);
    }
  }
}
