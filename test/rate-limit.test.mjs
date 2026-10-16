import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { WebAuth } from '../dist/auth.js';
import { AttemptCounter } from '../dist/rate-limit.js';

const WINDOW_MS = 1_000;

function counter(maxKeys = 3) {
  const clock = { now: 0 };
  return { clock, attempts: new AttemptCounter({ windowMs: WINDOW_MS, maxKeys, now: () => clock.now }) };
}

describe('AttemptCounter', () => {
  it('counts attempts per key within the window', () => {
    const { attempts } = counter();
    assert.equal(attempts.attempts('a'), 0);
    assert.equal(attempts.increment('a'), 1);
    assert.equal(attempts.increment('a'), 2);
    assert.equal(attempts.increment('b'), 1);
    assert.equal(attempts.attempts('a'), 2);
    attempts.delete('a');
    assert.equal(attempts.attempts('a'), 0);
  });

  it('never tracks more keys than the cap and evicts the oldest window first', () => {
    const { clock, attempts } = counter(3);
    for (const key of ['a', 'b', 'c']) {
      attempts.increment(key);
      clock.now += 10;
    }
    attempts.increment('a');
    for (let index = 0; index < 100; index += 1) {
      attempts.increment(`client-${index}`);
      assert.ok(attempts.size <= 3, `size ${attempts.size} after ${index + 1} new clients`);
    }
    assert.equal(attempts.size, 3);
    assert.equal(attempts.attempts('a'), 0);
    assert.equal(attempts.attempts('client-99'), 1);
    assert.equal(attempts.attempts('client-97'), 1);
  });

  it('drops expired windows without being asked about them', () => {
    const { clock, attempts } = counter(10);
    attempts.increment('a');
    attempts.increment('a');
    clock.now = 500;
    attempts.increment('b');
    assert.equal(attempts.size, 2);
    clock.now = WINDOW_MS;
    assert.equal(attempts.size, 1);
    assert.equal(attempts.attempts('a'), 0);
    assert.equal(attempts.increment('a'), 1, 'an expired window restarts from one');
    clock.now = 500 + WINDOW_MS;
    assert.equal(attempts.size, 1);
    clock.now = 2 * WINDOW_MS;
    assert.equal(attempts.size, 0);
  });
});

describe('administrator login failure limit', () => {
  afterEach(() => mock.timers.reset());

  it('locks a client out after eight failures until the five-minute window expires', async () => {
    mock.timers.enable({ apis: ['Date'], now: 0 });
    const webAuth = new WebAuth({ authenticateAdministrator: async () => null });
    for (let index = 0; index < 8; index += 1) assert.equal(await webAuth.login('admin', 'wrong', '203.0.113.5'), null);
    await assert.rejects(webAuth.login('admin', 'wrong', '203.0.113.5'), /too_many_login_attempts/);
    assert.equal(await webAuth.login('admin', 'wrong', '203.0.113.6'), null);
    mock.timers.tick(5 * 60 * 1000);
    assert.equal(await webAuth.login('admin', 'wrong', '203.0.113.5'), null);
  });
});
