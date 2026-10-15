import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { loadConfig } from '../dist/config.js';

const BASE = {
  WEBHOOK_TOKEN: 'webhook-secret',
  ADMIN_TOKEN: 'admin-secret',
  JELLYFIN_URL: 'http://jellyfin.test',
  JELLYFIN_API_KEY: 'jellyfin-key',
  SEERR_URL: 'http://seerr.test',
  SEERR_API_KEY: 'seerr-key',
};
const KEYS = [...Object.keys(BASE), 'REQUEST_BACKFILL_SINCE', 'REQUEST_BACKFILL_ENABLED', 'LOG_LEVEL', 'WS_IDLE_TIMEOUT_MS'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function load(overrides = {}) {
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE, ...overrides })) {
    if (value !== undefined) process.env[key] = value;
  }
  return loadConfig();
}

function restoreEnvironment() {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe('request backfill configuration', () => {
  afterEach(restoreEnvironment);

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

describe('logging and WebSocket configuration', () => {
  afterEach(() => {
    restoreEnvironment();
    mock.restoreAll();
  });

  it('defaults LOG_LEVEL to info and accepts known levels case-insensitively', () => {
    assert.equal(load().logLevel, 'info');
    assert.equal(load({ LOG_LEVEL: '' }).logLevel, 'info');
    assert.equal(load({ LOG_LEVEL: ' DEBUG ' }).logLevel, 'debug');
    for (const level of ['info', 'warn', 'error']) assert.equal(load({ LOG_LEVEL: level }).logLevel, level);
  });

  it('rejects unknown LOG_LEVEL values', () => {
    for (const value of ['verbose', 'trace', '1']) {
      assert.throws(() => load({ LOG_LEVEL: value }), /LOG_LEVEL must be one of debug, info, warn, error/, value);
    }
  });

  it('defaults WS_IDLE_TIMEOUT_MS to five minutes and allows 0 to disable it', () => {
    assert.equal(load().webSocketIdleTimeoutMs, 300_000);
    assert.equal(load({ WS_IDLE_TIMEOUT_MS: '' }).webSocketIdleTimeoutMs, 300_000);
    assert.equal(load({ WS_IDLE_TIMEOUT_MS: '0' }).webSocketIdleTimeoutMs, 0);
    assert.equal(load({ WS_IDLE_TIMEOUT_MS: '600000' }).webSocketIdleTimeoutMs, 600_000);
    assert.equal(load({ WS_IDLE_TIMEOUT_MS: '86400000' }).webSocketIdleTimeoutMs, 86_400_000);
  });

  it('rejects negative, non-numeric, fractional, and oversized WS_IDLE_TIMEOUT_MS values', () => {
    for (const value of ['-1', '-300000', 'abc', '300s', '1e5', '1.5', '0x10', '86400001']) {
      assert.throws(() => load({ WS_IDLE_TIMEOUT_MS: value }), /WS_IDLE_TIMEOUT_MS must be an integer between 0 and 86400000/, value);
    }
  });

  it('warns when WS_IDLE_TIMEOUT_MS would cut off healthy Jellyfin clients', () => {
    const warn = mock.method(console, 'warn', () => {});
    load({ WS_IDLE_TIMEOUT_MS: '30000' });
    assert.equal(warn.mock.calls.filter((call) => String(call.arguments[0]).includes('WS_IDLE_TIMEOUT_MS')).length, 1);
    warn.mock.resetCalls();
    load({ WS_IDLE_TIMEOUT_MS: '0' });
    load({ WS_IDLE_TIMEOUT_MS: '300000' });
    assert.equal(warn.mock.calls.filter((call) => String(call.arguments[0]).includes('WS_IDLE_TIMEOUT_MS')).length, 0);
  });
});
