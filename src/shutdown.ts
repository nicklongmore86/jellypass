import type { JellyPassServer } from './server.js';

/** How long in-flight HTTP requests get to finish before their connections are closed. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
/** Docker sends SIGKILL 10 s after SIGTERM; give up well before that. */
export const DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS = 5_000;
const IDLE_SWEEP_INTERVAL_MS = 50;

export interface ShutdownOptions {
  /** Every listening server; each stops accepting connections and drains. */
  servers: JellyPassServer[];
  /** Flushes the pending state-file write and refuses new ones. */
  closeStore: () => Promise<void>;
  /** Background timers (reconcile, catalog sync, backfill) to clear before anything else. */
  timers: () => Array<NodeJS.Timeout | undefined>;
  /** Background work already running; it is told to stop and given up to `graceMs` before the store closes. */
  background?: { stop(): Promise<void> };
  graceMs?: number;
  hardTimeoutMs?: number;
  exit?: (code: number) => void;
  log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Returns an idempotent shutdown function: the first call stops timers, closes listeners and proxied WebSockets, gives
 * in-flight HTTP requests `graceMs` to finish, flushes the state file and exits 0. If that has not finished within
 * `hardTimeoutMs`, it logs and exits 1. Later calls return the same promise.
 */
export function createShutdown(options: ShutdownOptions): (reason: string) => Promise<void> {
  const graceMs = options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? defaultLog;
  let running: Promise<void> | undefined;

  return (reason) => {
    if (running) {
      log('info', 'shutdown already in progress', { reason });
      return running;
    }
    const startedAt = performance.now();
    log('info', 'shutting down', { reason });
    const hardTimer = setTimeout(() => {
      log('error', 'shutdown timed out; exiting', { timeoutMs: hardTimeoutMs });
      exit(1);
    }, hardTimeoutMs);
    // Deliberately not unref'd: a stalled step with no other open handle would otherwise let the process exit 0 on its
    // own, without the timeout log. Every completion path clears it.
    running = (async () => {
      for (const timer of options.timers()) clearTimeout(timer);
      const backgroundStopped = stopBackground();
      const closed = options.servers.map(drain);
      const webSockets = await Promise.all(options.servers.map((server) => server.closeWebSockets()));
      await Promise.all([...closed, backgroundStopped]);
      await options.closeStore();
      clearTimeout(hardTimer);
      log('info', 'shutdown complete', {
        webSockets: webSockets.reduce((sum, count) => sum + count, 0),
        durationMs: Math.round(performance.now() - startedAt),
      });
      exit(0);
    })().catch((error: unknown) => {
      clearTimeout(hardTimer);
      log('error', 'shutdown failed', { detail: error instanceof Error ? error.message : String(error) });
      exit(1);
    });
    return running;
  };

  /**
   * Waits up to `graceMs` for running background work to notice it was stopped. Work still running after that is
   * abandoned; any state change it tries later is refused by the closed store.
   */
  async function stopBackground(): Promise<void> {
    if (!options.background) return;
    let cutoff: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([
      options.background.stop().then(() => true),
      new Promise<false>((resolve) => { cutoff = setTimeout(() => resolve(false), graceMs); }),
    ]);
    clearTimeout(cutoff);
    if (!stopped) log('info', 'background work still running; shutting down without waiting for it', { graceMs });
  }

  function drain(server: JellyPassServer): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve) => {
      // Keep-alive sockets that go idle after their in-flight response would otherwise hold close() open until the
      // keep-alive timeout, so sweep them while waiting; whatever is still busy after the grace period is cut off.
      const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_INTERVAL_MS);
      const cutoff = setTimeout(() => server.closeAllConnections(), graceMs);
      server.close(() => {
        clearInterval(sweep);
        clearTimeout(cutoff);
        resolve();
      });
    });
  }
}

function defaultLog(level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/**
 * Runs background jobs (reconcile, backfill, catalog sync, household library joins) under one AbortSignal, so shutdown
 * can stop them from starting further steps and wait for the ones in flight.
 */
export class BackgroundTasks {
  readonly #controller = new AbortController();
  readonly #running = new Set<Promise<void>>();

  public get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /**
   * Starts `task` unless stopped, and returns a promise that settles (never rejects) when it does, or undefined when
   * it was not started. The task handles its own errors; anything it lets escape is dropped.
   */
  public run(task: (signal: AbortSignal) => Promise<unknown>): Promise<void> | undefined {
    if (this.signal.aborted) return undefined;
    const running: Promise<void> = task(this.signal).then(() => undefined, () => undefined)
      .finally(() => this.#running.delete(running));
    this.#running.add(running);
    return running;
  }

  /** Aborts the signal and resolves once every running task has settled. */
  public async stop(): Promise<void> {
    this.#controller.abort(new Error('shutting down'));
    await Promise.all([...this.#running]);
  }
}
