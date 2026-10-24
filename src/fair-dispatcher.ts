/**
 * Shares one upstream rate limit (TMDB's, for one credential) fairly between households.
 *
 * Calls start at most `ratePerSecond` a second, with at most `burst` at once (a token bucket). Each household has its
 * own queue ("lane"), and the lanes take turns: whenever a call may start, the next lane in turn with a waiting call
 * starts its oldest one, and that lane goes to the back. So however many calls one household has waiting, another
 * household's next call waits for at most one turn of each other household with calls waiting, never behind the whole
 * queue; a household asking for no more than its share is never refused or timed out because of another.
 *
 * Every queue is bounded: a lane holds at most `maxQueuedPerLane` calls and all lanes `maxQueued`, and a call that
 * cannot be queued is refused at once ({@link DispatchQueueFullError}). A call that waits longer than `queueTimeoutMs`
 * fails ({@link DispatchTimeoutError}). When the upstream says it is rate limited (`retryAfter` returns how long to
 * wait), no call starts until then, the bucket starts again from empty, and the refused call is retried once, first in
 * its lane, if it can still start before its time runs out: the household whose call met the limit is not charged for
 * everyone's load, and a limit never causes more than one retry per call.
 */

export class DispatchQueueFullError extends Error {
  public constructor() {
    super('dispatch queue is full');
    this.name = 'DispatchQueueFullError';
  }
}

export class DispatchTimeoutError extends Error {
  public constructor() {
    super('dispatch queue wait timed out');
    this.name = 'DispatchTimeoutError';
  }
}

export interface FairDispatcherOptions {
  ratePerSecond: number;
  burst: number;
  maxQueuedPerLane: number;
  maxQueued: number;
  queueTimeoutMs: number;
  /** How long the upstream asks to wait when `error` says it is rate limited (milliseconds), or undefined otherwise. */
  retryAfter: (error: unknown) => number | undefined;
  /** The longest upstream wait honoured. */
  maxRetryAfterMs?: number;
  now?: () => number;
}

interface Job {
  lane: string;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  deadline: number;
  retried: boolean;
  timer?: NodeJS.Timeout;
}

export class FairDispatcher {
  readonly #options: Required<FairDispatcherOptions>;
  /** The lanes with calls waiting, in turn order: a lane that starts a call goes to the back. */
  readonly #lanes = new Map<string, Job[]>();
  #queued = 0;
  #tokens: number;
  #refilledAt: number;
  #pausedUntil = 0;
  #timer: NodeJS.Timeout | undefined;

  public constructor(options: FairDispatcherOptions) {
    this.#options = { maxRetryAfterMs: 60_000, now: () => performance.now(), ...options };
    this.#tokens = options.burst;
    this.#refilledAt = this.#options.now();
  }

  /** How many calls are waiting, in all lanes. */
  public get queued(): number {
    return this.#queued;
  }

  /** Runs `task` in `lane`'s turn. Rejects with {@link DispatchQueueFullError} at once if the call cannot be queued. */
  public run<T>(lane: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if ((this.#lanes.get(lane)?.length ?? 0) >= this.#options.maxQueuedPerLane || this.#queued >= this.#options.maxQueued) {
        reject(new DispatchQueueFullError());
        return;
      }
      const job: Job = {
        lane,
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
        deadline: this.#options.now() + this.#options.queueTimeoutMs,
        retried: false,
      };
      this.#enqueue(job, false);
      this.#pump();
    });
  }

  #enqueue(job: Job, first: boolean): void {
    let lane = this.#lanes.get(job.lane);
    if (!lane) {
      lane = [];
      this.#lanes.set(job.lane, lane);
    }
    if (first) lane.unshift(job);
    else lane.push(job);
    this.#queued += 1;
    job.timer = setTimeout(() => this.#expire(job), Math.max(0, job.deadline - this.#options.now()));
  }

  #expire(job: Job): void {
    const lane = this.#lanes.get(job.lane);
    const index = lane?.indexOf(job) ?? -1;
    if (!lane || index < 0) return;
    lane.splice(index, 1);
    this.#queued -= 1;
    if (lane.length === 0) this.#lanes.delete(job.lane);
    if (this.#lanes.size === 0 && this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    job.reject(new DispatchTimeoutError());
  }

  /** Starts every call that may start now, then sleeps until the next one may. */
  #pump(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const now = this.#options.now();
    if (now > this.#refilledAt) {
      this.#tokens = Math.min(this.#options.burst, this.#tokens + ((now - this.#refilledAt) * this.#options.ratePerSecond) / 1000);
      this.#refilledAt = now;
    }
    while (this.#lanes.size > 0) {
      if (now < this.#pausedUntil) return this.#wake(this.#pausedUntil - now);
      if (this.#tokens < 1) return this.#wake(((1 - this.#tokens) * 1000) / this.#options.ratePerSecond);
      const [name, lane] = this.#lanes.entries().next().value as [string, Job[]];
      const job = lane.shift() as Job;
      this.#queued -= 1;
      this.#lanes.delete(name);
      if (lane.length > 0) this.#lanes.set(name, lane);
      clearTimeout(job.timer);
      this.#tokens -= 1;
      this.#start(job);
    }
  }

  #wake(ms: number): void {
    this.#timer = setTimeout(() => this.#pump(), Math.max(1, Math.ceil(ms)));
  }

  #start(job: Job): void {
    job.task().then(job.resolve, (error: unknown) => {
      const wait = this.#options.retryAfter(error);
      if (wait === undefined) return job.reject(error);
      const now = this.#options.now();
      const until = now + Math.min(this.#options.maxRetryAfterMs, Math.max(0, wait));
      if (until > this.#pausedUntil) this.#pausedUntil = until;
      // The bucket starts again from empty once the wait is over, so the limit is not met again by a burst.
      this.#tokens = 0;
      this.#refilledAt = Math.max(this.#refilledAt, this.#pausedUntil);
      if (job.retried || job.deadline <= this.#pausedUntil) return job.reject(error);
      job.retried = true;
      this.#enqueue(job, true);
      this.#pump();
    });
  }
}
