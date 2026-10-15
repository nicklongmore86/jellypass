import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadConfig } from '../dist/config.js';

const BASE = {
  WEBHOOK_TOKEN: 'webhook-secret',
  ADMIN_TOKEN: 'admin-secret',
  JELLYFIN_URL: 'http://jellyfin.test',
  JELLYFIN_API_KEY: 'jellyfin-key',
  SEERR_URL: 'http://seerr.test',
  SEERR_API_KEY: 'seerr-key',
};
const KEYS = [...Object.keys(BASE), 'REQUEST_BACKFILL_SINCE', 'REQUEST_BACKFILL_ENABLED'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function load(overrides = {}) {
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE, ...overrides })) {
    if (value !== undefined) process.env[key] = value;
  }
  return loadConfig();
}

describe('request backfill configuration', () => {
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('is enabled by default only when REQUEST_BACKFILL_SINCE is set', () => {
    const off = load();
    assert.equal(off.requestBackfillEnabled, false);
    assert.equal(off.requestBackfillSince, undefined);

    const on = load({ REQUEST_BACKFILL_SINCE: '2026-10-15' });
    assert.equal(on.requestBackfillEnabled, true);
    assert.equal(on.requestBackfillSince.toISOString(), '2026-10-15T00:00:00.000Z');

    assert.equal(load({ REQUEST_BACKFILL_SINCE: '2026-10-15', REQUEST_BACKFILL_ENABLED: 'false' }).requestBackfillEnabled, false);
  });

  it('requires a cutoff and Seerr when enabled', () => {
    assert.throws(() => load({ REQUEST_BACKFILL_ENABLED: 'true' }), /REQUEST_BACKFILL_SINCE is required/);
    assert.throws(
      () => load({ REQUEST_BACKFILL_SINCE: '2026-10-15', SEERR_URL: undefined, SEERR_API_KEY: undefined }),
      /SEERR_URL and SEERR_API_KEY are required when REQUEST_BACKFILL_ENABLED/,
    );
    assert.equal(load({ REQUEST_BACKFILL_SINCE: '2026-10-15', REQUEST_BACKFILL_ENABLED: '0', SEERR_URL: undefined, SEERR_API_KEY: undefined }).requestBackfillEnabled, false);
  });

  it('parses dates as UTC midnight and date-times with an explicit offset', () => {
    const since = (value) => load({ REQUEST_BACKFILL_SINCE: value }).requestBackfillSince.toISOString();
    assert.equal(since('2024-02-29'), '2024-02-29T00:00:00.000Z');
    assert.equal(since('2026-10-15T08:00Z'), '2026-10-15T08:00:00.000Z');
    assert.equal(since('2026-10-15T08:00:00+02:00'), '2026-10-15T06:00:00.000Z');
    assert.equal(since('2026-10-15T08:00:00.250-05:30'), '2026-10-15T13:30:00.250Z');
  });

  it('rejects malformed, impossible, and offset-less values', () => {
    for (const value of [
      'yesterday',
      '2026-02-30',
      '2025-02-29',
      '2026-13-01',
      '2026-10-15T08:00:00',
      '2026-10-15T25:00Z',
      '2026-10-15T08:60Z',
      '2026-10-15T08:00+15:00',
      '15/10/2026',
      '2026-10-15 08:00Z',
    ]) {
      assert.throws(() => load({ REQUEST_BACKFILL_SINCE: value }), /REQUEST_BACKFILL_SINCE must be/, value);
    }
  });
});
