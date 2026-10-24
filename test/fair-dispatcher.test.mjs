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

/** A dispatcher whose calls record when they start, in `started`, as `lane:label`. */
function dispatcher(options = {}) {
  const started = [];
  const fair = new FairDispatcher({
    ratePerSecond: 50,
    burst: 1,
    maxQueuedPerLane: 100,
    maxQueued: 1000,
    queueTimeoutMs: 10_000,
    retryAfter: (error) => (error instanceof RateLimited ? error.retryAfterMs : undefined),
    ...options,
  });
  const run = (lane, label, task = async () => label) => fair.run(lane, () => {
    started.push({ name: `${lane}:${label}`, at: performance.now() });
    return task();
  });
  return { fair, run, started, names: () => started.map((call) => call.name) };
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

  it('never retries a call that failed for any other reason', async () => {
    const { run, started } = dispatcher();
    await assert.rejects(run('a', 'broken', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(started.length, 1);
  });
});
