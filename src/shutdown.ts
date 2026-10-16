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
    hardTimer.unref();
    running = (async () => {
      for (const timer of options.timers()) clearTimeout(timer);
      const closed = options.servers.map(drain);
      const webSockets = await Promise.all(options.servers.map((server) => server.closeWebSockets()));
      await Promise.all(closed);
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
