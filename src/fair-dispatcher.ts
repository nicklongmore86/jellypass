/**
 * Shares one upstream rate limit (TMDB's, for one credential) fairly between households.
 *
 * Calls start at most `ratePerSecond` a second, with at most `burst` started at once (a token bucket), and at most
 * `maxInFlight` are ever unfinished at the same time: while that many are in flight no call starts, however many tokens
 * have built up, and the next starts when one of them settles. Each household has its own queue ("lane"), and the lanes
 * take turns: whenever a call may start, the next lane in turn with a waiting call starts its oldest one, and that lane
 * goes to the back. So however many calls one household has waiting, another household's next call waits for at most
 * one turn of each other household with calls waiting, never behind the whole queue; a household asking for no more
 * than its share is never refused because of another.
 *
 * Every queue is bounded: a lane holds at most `maxQueuedPerLane` calls and all lanes `maxQueued`, and a call that
 * cannot be queued is refused at once ({@link DispatchQueueFullError}). A call that waits longer than `queueTimeoutMs`
 * to start, for a token or for a call in flight to settle, fails ({@link DispatchTimeoutError}). A call in flight longer
 * than `callTimeoutMs` is aborted (its task's signal) and fails, and its place is freed then whether or not the task
 * settles, so a hung upstream call never holds one for longer. A call whose `signal` aborts is forgotten if waiting, or
 * aborted and its place freed if in flight. When the upstream says it is rate limited (`retryAfter` returns how long to
 * wait), no call starts until then, the bucket starts again from empty, and the refused call is retried once, first in
 * its lane, if it can still start before its time runs out: the household whose call met the limit is not charged for
 * everyone's load, and a limit never causes more than one retry per call. A retry is queued like any new call, so only
 * if its lane and every lane together have room: when either is full, the call fails with the upstream's error, as
 * when its wait outlasts its time. So the queue bounds always hold, however many calls in flight are rate limited.
 */

export class DispatchQueueFullError extends Error {
  public constructor() {
    super('dispatch queue is full');
    this.name = 'DispatchQueueFullError';
  }
}

export class DispatchTimeoutError extends Error {
  public constructor(message = 'dispatch queue wait timed out') {
    super(message);
    this.name = 'DispatchTimeoutError';
  }
}

export interface FairDispatcherOptions {
  ratePerSecond: number;
  burst: number;
  /** The most calls unfinished at once. */
  maxInFlight: number;
  maxQueuedPerLane: number;
  maxQueued: number;
  queueTimeoutMs: number;
  /** How long a call may be in flight before it is aborted and its place freed. */
  callTimeoutMs: number;
  /** How long the upstream asks to wait when `error` says it is rate limited (milliseconds), or undefined otherwise. */
  retryAfter: (error: unknown) => number | undefined;
  /** The longest upstream wait honoured. */
  maxRetryAfterMs?: number;
  now?: () => number;
}

interface Job {
  lane: string;
  task: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  deadline: number;
  retried: boolean;
  signal?: AbortSignal;
  /** Settles the call when it is in flight (with an error: aborts it). */
  finish?: (outcome: { error: unknown } | { value: unknown }) => void;
  timer?: NodeJS.Timeout;
}

export class FairDispatcher {
  readonly #options: Required<FairDispatcherOptions>;
  /** The lanes with calls waiting, in turn order: a lane that starts a call goes to the back. */
  readonly #lanes = new Map<string, Job[]>();
  #queued = 0;
  #inFlight = 0;
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

  /** How many calls are in flight. */
  public get inFlight(): number {
    return this.#inFlight;
  }

  /**
   * Runs `task` in `lane`'s turn, with a signal that aborts when the call times out or `signal` aborts. Rejects with
   * {@link DispatchQueueFullError} at once if the call cannot be queued.
   */
  public run<T>(lane: string, task: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const { signal } = options;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (!this.#hasRoom(lane)) {
        reject(new DispatchQueueFullError());
        return;
      }
      const onAbort = () => {
        if (job.finish) job.finish({ error: signal?.reason });
        else this.#dequeue(job, signal?.reason);
      };
      const job: Job = {
        lane,
        task,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        deadline: this.#options.now() + this.#options.queueTimeoutMs,
        retried: false,
        ...(signal ? { signal } : {}),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#enqueue(job, false);
      this.#pump();
    });
  }

  /** Whether `lane`, and every lane together, can hold one more waiting call. Checked before every call is queued. */
  #hasRoom(lane: string): boolean {
    return (this.#lanes.get(lane)?.length ?? 0) < this.#options.maxQueuedPerLane && this.#queued < this.#options.maxQueued;
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
    job.timer = setTimeout(() => this.#dequeue(job, new DispatchTimeoutError()), Math.max(0, job.deadline - this.#options.now()));
  }

  /** Forgets a waiting call and fails it with `error`. */
  #dequeue(job: Job, error: unknown): void {
    const lane = this.#lanes.get(job.lane);
    const index = lane?.indexOf(job) ?? -1;
    if (!lane || index < 0) return;
    lane.splice(index, 1);
    clearTimeout(job.timer);
    this.#queued -= 1;
    if (lane.length === 0) this.#lanes.delete(job.lane);
    if (this.#lanes.size === 0 && this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    job.reject(error);
  }

  /** Starts every call that may start now, then sleeps until the next one may (or until a call in flight settles). */
  #pump(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const now = this.#options.now();
    if (now > this.#refilledAt) {
      this.#tokens = Math.min(this.#options.burst, this.#tokens + ((now - this.#refilledAt) * this.#options.ratePerSecond) / 1000);
      this.#refilledAt = now;
    }
    while (this.#lanes.size > 0) {
      if (this.#inFlight >= this.#options.maxInFlight) return;
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
    this.#inFlight += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => finish({ error: new DispatchTimeoutError('dispatched call timed out') }), this.#options.callTimeoutMs);
    const finish = (outcome: { error: unknown } | { value: unknown }) => {
      if (job.finish !== finish) return;
      delete job.finish;
      clearTimeout(timer);
      this.#inFlight -= 1;
      if ('value' in outcome) job.resolve(outcome.value);
      else {
        controller.abort(outcome.error);
        this.#failed(job, outcome.error);
      }
      this.#pump();
    };
    job.finish = finish;
    // A task that throws at once settles like one that rejects.
    Promise.resolve()
      .then(() => job.task(controller.signal))
      .then((value) => finish({ value }), (error: unknown) => finish({ error }));
  }

  /**
   * A call in flight failed with `error`: retried once if the upstream was rate limited, there is time, and its lane and
   * every lane together have room for it, else failed.
   */
  #failed(job: Job, error: unknown): void {
    const wait = job.signal?.aborted ? undefined : this.#options.retryAfter(error);
    if (wait === undefined) return job.reject(error);
    const now = this.#options.now();
    const until = now + Math.min(this.#options.maxRetryAfterMs, Math.max(0, wait));
    if (until > this.#pausedUntil) this.#pausedUntil = until;
    // The bucket starts again from empty once the wait is over, so the limit is not met again by a burst.
    this.#tokens = 0;
    this.#refilledAt = Math.max(this.#refilledAt, this.#pausedUntil);
    if (job.retried || job.deadline <= this.#pausedUntil || !this.#hasRoom(job.lane)) return job.reject(error);
    job.retried = true;
    this.#enqueue(job, true);
  }
}
