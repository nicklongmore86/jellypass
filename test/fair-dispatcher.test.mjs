import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DispatchQueueFullError, DispatchTimeoutError, FairDispatcher } from '../dist/fair-dispatcher.js';

class RateLimited extends Error {
  constructor(retryAfterMs) {
    super('rate limited');
    this.retryAfterMs = retryAfterMs;
  }
}

/** A dispatcher whose calls record when they start, in `started`, as `lane:label`, and the most in flight at once. */
function dispatcher(options = {}) {
  const started = [];
  let active = 0;
  let maxActive = 0;
  const fair = new FairDispatcher({
    ratePerSecond: 50,
    burst: 1,
    maxInFlight: 10,
    maxQueuedPerLane: 100,
    maxQueued: 1000,
    queueTimeoutMs: 10_000,
    callTimeoutMs: 10_000,
    retryAfter: (error) => (error instanceof RateLimited ? error.retryAfterMs : undefined),
    ...options,
  });
  const run = (lane, label, task = async () => label, runOptions) => fair.run(lane, async (signal) => {
    started.push({ name: `${lane}:${label}`, at: performance.now(), signal });
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      return await task(signal);
    } finally {
      active -= 1;
    }
  }, runOptions);
  return {
    fair, run, started, names: () => started.map((call) => call.name), maxActive: () => maxActive, active: () => active,
  };
}

describe('fair dispatcher', () => {
  it('takes turns between lanes: a lane with one call waits behind one call of each busy lane, not their queues', async () => {
    const { run, names } = dispatcher();
    const b = Array.from({ length: 10 }, (_, index) => run('b', index));
    const c = Array.from({ length: 10 }, (_, index) => run('c', index));
    const a = run('a', 0);
    await Promise.all([...b, ...c, a]);
    // b:0 started at once with the bucket's one token; then the lanes take turns in the order they queued (b's next call
    // queued first), so a's one call waits for one call of each busy lane, not for their queues.
    assert.deepEqual(names().slice(0, 7), ['b:0', 'b:1', 'c:0', 'a:0', 'b:2', 'c:1', 'b:3']);
    assert.equal(names().length, 21);
  });

  it('starts no more calls than the bucket allows', async () => {
    const { run, started } = dispatcher({ ratePerSecond: 20, burst: 5 });
    await Promise.all(Array.from({ length: 25 }, (_, index) => run(`lane-${index % 3}`, index)));
    const times = started.map((call) => call.at);
    // 5 at once, then 20 a second: the 25th starts no sooner than one second in.
    assert.ok(times[24] - times[0] >= 950, `${times[24] - times[0]} ms`);
    for (const first of times) assert.ok(times.filter((time) => time >= first && time < first + 500).length <= 5 + 10 + 1);
  });

  it('never has more calls in flight than allowed, however long they take (Codex\'s repro)', async () => {
    // Production settings; 30 calls from three households that TMDB never answers.
    const { fair, run, maxActive } = dispatcher({ ratePerSecond: 20, burst: 10, maxInFlight: 10, callTimeoutMs: 60_000 });
    const controller = new AbortController();
    const calls = Array.from({ length: 30 }, (_, index) =>
      run(`household-${index % 3}`, index, () => new Promise(() => undefined), { signal: controller.signal }));
    await delay(1100);
    // Tokens refilled meanwhile, but no call starts while 10 are unanswered.
    assert.equal(maxActive(), 10);
    assert.equal(fair.queued, 20);
    assert.equal(fair.inFlight, 10);
    controller.abort(new Error('gave up'));
    for (const call of calls) await assert.rejects(call, /gave up/);
    assert.equal(fair.inFlight, 0);
    assert.equal(fair.queued, 0);
  });

  it('takes turns between lanes when a place in flight frees up', async () => {
    const { run, names, maxActive } = dispatcher({ ratePerSecond: 1000, burst: 100, maxInFlight: 1 });
    const slow = async () => delay(5);
    const b = Array.from({ length: 5 }, (_, index) => run('b', index, slow));
    const c = Array.from({ length: 5 }, (_, index) => run('c', index, slow));
    const a = run('a', 0, slow);
    await Promise.all([...b, ...c, a]);
    // Tokens are plentiful; only the place in flight limits, and each freed place goes to the next lane in turn.
    assert.deepEqual(names().slice(0, 7), ['b:0', 'b:1', 'c:0', 'a:0', 'b:2', 'c:1', 'b:3']);
    assert.equal(maxActive(), 1);
  });

  it('frees a place in flight when a call succeeds, fails, times out or is aborted', async () => {
    const { fair, run, started } = dispatcher({ ratePerSecond: 1000, burst: 100, maxInFlight: 1, callTimeoutMs: 100 });
    assert.equal(await run('a', 'ok'), 'ok');
    assert.equal(fair.inFlight, 0);
    await assert.rejects(run('a', 'error', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(fair.inFlight, 0);
    // A task that throws before returning a promise is a failure like any other.
    await assert.rejects(fair.run('a', () => { throw new Error('at once'); }), /at once/);
    assert.equal(fair.inFlight, 0);

    // A call that never settles, and ignores its signal, still frees its place when its time is up.
    const hung = run('a', 'hung', () => new Promise(() => undefined));
    const next = run('b', 'next');
    const startedAt = performance.now();
    await assert.rejects(hung, DispatchTimeoutError);
    assert.ok(performance.now() - startedAt >= 90, `${performance.now() - startedAt} ms`);
    assert.equal(started.find((call) => call.name === 'a:hung').signal.aborted, true);
    assert.equal(await next, 'next');
    assert.equal(fair.inFlight, 0);

    // A caller that gives up frees the place at once; its task is told to stop.
    const controller = new AbortController();
    const aborted = run('a', 'aborted', () => new Promise(() => undefined), { signal: controller.signal });
    const after = run('b', 'after');
    await delay(10);
    assert.equal(fair.inFlight, 1);
    controller.abort(new Error('caller gave up'));
    await assert.rejects(aborted, /caller gave up/);
    assert.equal(started.find((call) => call.name === 'a:aborted').signal.aborted, true);
    assert.equal(await after, 'after');
    assert.equal(fair.inFlight, 0);
  });

  it('times out and bounds calls waiting for a place in flight, and forgets one whose caller gives up', async () => {
    const { fair, run, names } = dispatcher({
      ratePerSecond: 1000, burst: 100, maxInFlight: 1, maxQueuedPerLane: 2, queueTimeoutMs: 100, callTimeoutMs: 5000,
    });
    let finish;
    const busy = run('a', 'busy', () => new Promise((resolve) => { finish = resolve; }));
    await delay(5);
    const waiting = [run('b', 0), run('b', 1)];
    // The lane is full while the place is taken: refused at once.
    await assert.rejects(run('b', 2), DispatchQueueFullError);
    const controller = new AbortController();
    const givenUp = run('c', 0, undefined, { signal: controller.signal });
    controller.abort(new Error('gave up'));
    await assert.rejects(givenUp, /gave up/);
    const startedAt = performance.now();
    for (const call of waiting) await assert.rejects(call, DispatchTimeoutError);
    assert.ok(performance.now() - startedAt < 200, `${performance.now() - startedAt} ms`);
    assert.equal(fair.queued, 0);
    finish('done');
    assert.equal(await busy, 'done');
    // Only the call in flight ever started.
    assert.deepEqual(names(), ['a:busy']);
  });

  it('refuses a call at once when its lane, or every lane together, is full', async () => {
    const { fair, run } = dispatcher({ maxQueuedPerLane: 3, maxQueued: 5, burst: 1, ratePerSecond: 20 });
    const queued = [run('a', 0), run('a', 1), run('a', 2), run('a', 3)];
    await assert.rejects(run('a', 4), DispatchQueueFullError);
    // Another lane still has room, until all lanes together hold 5.
    queued.push(run('b', 0), run('b', 1));
    await assert.rejects(run('c', 0), DispatchQueueFullError);
    assert.equal(fair.queued, 5);
    await Promise.all(queued);
    assert.equal(fair.queued, 0);
  });

  it('fails a call that waits longer than its time, and forgets it', async () => {
    const { fair, run, names } = dispatcher({ ratePerSecond: 1, burst: 1, queueTimeoutMs: 100 });
    const first = run('a', 0);
    const late = run('a', 1);
    await assert.rejects(late, DispatchTimeoutError);
    assert.equal(fair.queued, 0);
    await first;
    assert.deepEqual(names(), ['a:0']);
  });

  it('keeps a lane within its share served while another lane always has a full queue', async () => {
    const { run } = dispatcher({ ratePerSecond: 40, burst: 1, maxQueuedPerLane: 20, queueTimeoutMs: 400 });
    let flooding = true;
    const flood = (async () => {
      const pending = new Set();
      while (flooding) {
        const call = run('b', 'x').catch(() => undefined);
        pending.add(call);
        call.finally(() => pending.delete(call));
        await delay(1);
      }
      await Promise.all(pending);
    })();
    // One call at a time from lane a: each starts within a couple of turns, never refused or timed out.
    for (let index = 0; index < 10; index += 1) {
      const started = performance.now();
      assert.equal(await run('a', index), index);
      assert.ok(performance.now() - started < 200, `${performance.now() - started} ms`);
    }
    flooding = false;
    await flood;
  });

  it('after a rate limit, starts nothing until the wait is over, then retries that call once, first in its lane', async () => {
    const { run, started } = dispatcher({ ratePerSecond: 50, burst: 5 });
    let limited = false;
    const first = run('a', 'first', async () => {
      if (!limited) {
        limited = true;
        throw new RateLimited(300);
      }
      return 'first';
    });
    await delay(20);
    const others = [run('a', 'second'), run('b', 'other')];
    assert.deepEqual(await Promise.all([first, ...others]), ['first', 'second', 'other']);
    const [limitedAt, ...after] = started.map((call) => call.at);
    assert.deepEqual(started.map((call) => call.name), ['a:first', 'a:first', 'b:other', 'a:second']);
    for (const at of after) assert.ok(at - limitedAt >= 290, `${at - limitedAt} ms`);
    // The bucket starts again from empty, so the calls after the wait do not all start at once.
    assert.ok(after[2] - after[0] >= 30, `${after[2] - after[0]} ms`);
  });

  it('retries a rate-limited call only once, and not at all when the wait outlasts its time', async () => {
    const { run, started } = dispatcher({ queueTimeoutMs: 1000 });
    await assert.rejects(run('a', 'twice', async () => { throw new RateLimited(0); }), RateLimited);
    assert.equal(started.length, 2);
    await assert.rejects(run('a', 'long', async () => { throw new RateLimited(5000); }), RateLimited);
    assert.equal(started.length, 3);
  });

  it('never lets retries exceed a lane\'s queue bound, also when every call in flight meets a 429 (Codex\'s repro)', async () => {
    // Production settings, one household: 10 calls in flight and 20 waiting, then TMDB refuses every call in flight.
    const { fair, run, started } = dispatcher({
      ratePerSecond: 20, burst: 10, maxInFlight: 10, maxQueuedPerLane: 20, maxQueued: 2000, callTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    const refusals = [];
    const outcomes = Array.from({ length: 30 }, (_, index) =>
      run('household', index, () => new Promise((resolve, reject) => {
        refusals.push(() => reject(new RateLimited(300)));
      }), { signal: controller.signal }).catch((error) => error));
    await delay(20);
    assert.equal(fair.inFlight, 10);
    assert.equal(fair.queued, 20);
    let mostQueued = fair.queued;
    for (const refuse of refusals.splice(0)) {
      refuse();
      await delay(0);
      mostQueued = Math.max(mostQueued, fair.queued);
    }
    // The lane is full, so none is retried: each fails with TMDB's 429, as a call that cannot be retried does.
    assert.equal(mostQueued, 20);
    assert.equal(fair.inFlight, 0);
    for (const outcome of outcomes.slice(0, 10)) assert.ok(await outcome instanceof RateLimited);
    assert.equal(started.length, 10);
    // After the wait (the bucket refilling from empty) the next 10 start; a refused call is retried, first in its lane,
    // only while the lane has room.
    await delay(1000);
    assert.equal(fair.inFlight, 10);
    assert.equal(fair.queued, 10);
    for (const refuse of refusals.splice(0)) {
      refuse();
      await delay(0);
      mostQueued = Math.max(mostQueued, fair.queued);
    }
    assert.equal(mostQueued, 20);
    assert.equal(fair.queued, 20);
    controller.abort(new Error('gave up'));
    await Promise.all(outcomes);
    assert.equal(fair.queued, 0);
    assert.equal(fair.inFlight, 0);
  });

  it('never lets retries exceed the bound on all lanes together', async () => {
    // Three lanes each with room, but all lanes together full when TMDB refuses every call in flight.
    const { fair, run } = dispatcher({
      ratePerSecond: 20, burst: 10, maxInFlight: 10, maxQueuedPerLane: 20, maxQueued: 15, callTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    const refusals = [];
    const outcomes = Array.from({ length: 25 }, (_, index) =>
      run(`household-${index % 3}`, index, () => new Promise((resolve, reject) => {
        refusals.push(() => reject(new RateLimited(300)));
      }), { signal: controller.signal }).catch((error) => error));
    await delay(20);
    assert.equal(fair.inFlight, 10);
    assert.equal(fair.queued, 15);
    let mostQueued = fair.queued;
    for (const refuse of refusals.splice(0)) {
      refuse();
      await delay(0);
      mostQueued = Math.max(mostQueued, fair.queued);
    }
    assert.equal(mostQueued, 15);
    assert.equal(fair.inFlight, 0);
    for (const outcome of outcomes.slice(0, 10)) assert.ok(await outcome instanceof RateLimited);
    controller.abort(new Error('gave up'));
    await Promise.all(outcomes);
    assert.equal(fair.queued, 0);
    assert.equal(fair.inFlight, 0);
  });

  it('never retries a call that failed for any other reason', async () => {
    const { run, started } = dispatcher();
    await assert.rejects(run('a', 'broken', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(started.length, 1);
  });
});
