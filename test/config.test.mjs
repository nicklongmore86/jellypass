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
const KEYS = [...Object.keys(BASE), 'REQUEST_BACKFILL_SINCE', 'REQUEST_BACKFILL_ENABLED', 'LOG_LEVEL', 'WS_IDLE_TIMEOUT_MS', 'WS_UPSTREAM_IDLE_TIMEOUT_MS', 'JELLYQUEST_BRIDGE_ENABLED', 'TRUSTED_PROXIES', 'TMDB_API_KEY', 'HOUSEHOLD_APP_ENABLED', 'HOUSEHOLD_DOMAIN', 'TV_ADDON_ENABLED', 'TV_ADDON_HOUSEHOLDS'];
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

const TMDB_V3_KEY = 'f00dfeedf00dfeedf00dfeedf00dfeed';
const TMDB_V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJzeW50aGV0aWMiLCJzdWIiOiJ0ZXN0In0.c3ludGhldGljLXNpZ25hdHVyZQ';

describe('TMDB configuration', () => {
  afterEach(restoreEnvironment);

  it('is optional, and a TMDB API key or read access token when set, never quoted in an error', () => {
    assert.equal(load().tmdbApiKey, undefined);
    assert.equal(load({ TMDB_API_KEY: ` ${TMDB_V3_KEY} ` }).tmdbApiKey, TMDB_V3_KEY);
    assert.equal(load({ TMDB_API_KEY: TMDB_V4_TOKEN }).tmdbApiKey, TMDB_V4_TOKEN);
    for (const value of ['secret-value', `${TMDB_V3_KEY}0`, 'eyJsecret.value', `Bearer ${TMDB_V4_TOKEN}`]) {
      assert.throws(() => load({ TMDB_API_KEY: value }), (error) =>
        /TMDB_API_KEY must be a TMDB API key/.test(error.message) && !error.message.includes(value.slice(0, 8)), value);
    }
  });
});

describe('household app configuration', () => {
  afterEach(restoreEnvironment);

  it('is off by default, even with everything it needs configured', () => {
    assert.equal(load().householdAppEnabled, false);
    assert.equal(load({ HOUSEHOLD_DOMAIN: 'example.test', TMDB_API_KEY: TMDB_V3_KEY }).householdAppEnabled, false);
    assert.equal(load({ HOUSEHOLD_APP_ENABLED: 'false' }).householdAppEnabled, false);
  });

  it('needs household hosts, Seerr and TMDB when enabled', () => {
    const ready = { HOUSEHOLD_APP_ENABLED: 'true', HOUSEHOLD_DOMAIN: 'example.test', TMDB_API_KEY: TMDB_V3_KEY };
    assert.equal(load(ready).householdAppEnabled, true);
    assert.equal(load({ ...ready, HOUSEHOLD_APP_ENABLED: '1' }).householdAppEnabled, true);
    for (const missing of ['HOUSEHOLD_DOMAIN', 'TMDB_API_KEY']) {
      assert.throws(() => load({ ...ready, [missing]: undefined }), /SEERR_API_KEY and TMDB_API_KEY are required when HOUSEHOLD_APP_ENABLED is true/, missing);
    }
    assert.throws(() => load({ ...ready, SEERR_URL: undefined, SEERR_API_KEY: undefined }), /SEERR_URL, SEERR_API_KEY and TMDB_API_KEY are required/);
    assert.throws(() => load({ ...ready, HOUSEHOLD_APP_ENABLED: 'yes' }), /HOUSEHOLD_APP_ENABLED must be true, false, 1, or 0/);
  });
});

describe('TV add-on configuration', () => {
  afterEach(restoreEnvironment);
  const app = { HOUSEHOLD_APP_ENABLED: 'true', HOUSEHOLD_DOMAIN: 'example.test', TMDB_API_KEY: TMDB_V3_KEY };

  it('is off by default, even with households listed', () => {
    assert.equal(load(app).tvAddonHouseholds, undefined);
    assert.equal(load({ ...app, TV_ADDON_HOUSEHOLDS: 'farmhouse' }).tvAddonHouseholds, undefined);
    assert.equal(load({ ...app, TV_ADDON_ENABLED: 'false', TV_ADDON_HOUSEHOLDS: '*' }).tvAddonHouseholds, undefined);
  });

  it('is on for the households listed, or every household with *', () => {
    assert.deepEqual(load({ ...app, TV_ADDON_ENABLED: 'true', TV_ADDON_HOUSEHOLDS: 'farmhouse' }).tvAddonHouseholds, ['farmhouse']);
    assert.deepEqual(load({ ...app, TV_ADDON_ENABLED: '1', TV_ADDON_HOUSEHOLDS: ' Farmhouse, mill,,farmhouse ' }).tvAddonHouseholds, ['farmhouse', 'mill']);
    assert.equal(load({ ...app, TV_ADDON_ENABLED: 'true', TV_ADDON_HOUSEHOLDS: '*' }).tvAddonHouseholds, 'all');
  });

  it('needs the household app and a list of households, each a household ID', () => {
    assert.throws(() => load({ TV_ADDON_ENABLED: 'true', TV_ADDON_HOUSEHOLDS: 'farmhouse' }), /HOUSEHOLD_APP_ENABLED is required when TV_ADDON_ENABLED is true/);
    for (const households of [undefined, '', ' , ']) {
      assert.throws(() => load({ ...app, TV_ADDON_ENABLED: 'true', TV_ADDON_HOUSEHOLDS: households }), /TV_ADDON_HOUSEHOLDS is required when TV_ADDON_ENABLED is true/, String(households));
    }
    for (const households of ['farm house', 'farmhouse;mill', '*,farmhouse', 'jelly-farmhouse.example.test']) {
      assert.throws(() => load({ ...app, TV_ADDON_ENABLED: 'true', TV_ADDON_HOUSEHOLDS: households }), /TV_ADDON_HOUSEHOLDS must list household IDs/, households);
    }
    assert.throws(() => load({ ...app, TV_ADDON_ENABLED: 'yes', TV_ADDON_HOUSEHOLDS: 'farmhouse' }), /TV_ADDON_ENABLED must be true, false, 1, or 0/);
  });
});

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

  it('defaults LOG_LEVEL to info and accepts levels and aliases case-insensitively', () => {
    const warn = mock.method(console, 'warn', () => {});
    assert.equal(load().logLevel, 'info');
    assert.equal(load({ LOG_LEVEL: '' }).logLevel, 'info');
    for (const [value, level] of [
      [' DEBUG ', 'debug'], ['trace', 'debug'], ['Verbose', 'debug'],
      ['info', 'info'], ['Information', 'info'],
      ['warn', 'warn'], ['WARNING', 'warn'],
      ['error', 'error'], ['err', 'error'],
    ]) {
      assert.equal(load({ LOG_LEVEL: value }).logLevel, level, value);
    }
    assert.equal(logLevelWarnings(warn).length, 0);
  });

  it('falls back to info with one startup warning naming an unrecognised LOG_LEVEL', () => {
    const warn = mock.method(console, 'warn', () => {});
    for (const value of ['loud', '1', 'Debugging']) {
      warn.mock.resetCalls();
      assert.equal(load({ LOG_LEVEL: value }).logLevel, 'info', value);
      const warnings = logLevelWarnings(warn);
      assert.equal(warnings.length, 1, value);
      assert.equal(warnings[0].value, value);
      assert.match(warnings[0].message, /using info/);
    }
  });

  it('defaults WS_IDLE_TIMEOUT_MS to five minutes and allows 0 to disable it', () => {
    assert.equal(load().webSocketIdleTimeoutMs, 300_000);
    assert.equal(load({ WS_IDLE_TIMEOUT_MS: '' }).webSocketIdleTimeoutMs, 300_000);
    assert.equal(load({ WS_IDLE_TIMEOUT_MS: '0' }).webSocketIdleTimeoutMs, 0);
    assert.equal(load({ WS_IDLE_TIMEOUT_MS: '600000' }).webSocketIdleTimeoutMs, 600_000);
    assert.equal(load({ WS_IDLE_TIMEOUT_MS: '86400000' }).webSocketIdleTimeoutMs, 86_400_000);
  });

  it('defaults WS_UPSTREAM_IDLE_TIMEOUT_MS to three minutes and allows 0 to disable it', () => {
    assert.equal(load().webSocketUpstreamIdleTimeoutMs, 180_000);
    assert.equal(load({ WS_UPSTREAM_IDLE_TIMEOUT_MS: '' }).webSocketUpstreamIdleTimeoutMs, 180_000);
    assert.equal(load({ WS_UPSTREAM_IDLE_TIMEOUT_MS: '0' }).webSocketUpstreamIdleTimeoutMs, 0);
    assert.equal(load({ WS_UPSTREAM_IDLE_TIMEOUT_MS: '120000' }).webSocketUpstreamIdleTimeoutMs, 120_000);
  });

  for (const name of ['WS_IDLE_TIMEOUT_MS', 'WS_UPSTREAM_IDLE_TIMEOUT_MS']) {
    it(`rejects negative, non-numeric, fractional, and oversized ${name} values`, () => {
      for (const value of ['-1', '-300000', 'abc', '300s', '1e5', '1.5', '0x10', '86400001']) {
        assert.throws(() => load({ [name]: value }), new RegExp(`${name} must be an integer between 0 and 86400000`), value);
      }
    });

    it(`warns when ${name} would cut off healthy Jellyfin connections`, () => {
      const warn = mock.method(console, 'warn', () => {});
      const named = () => warn.mock.calls.filter((call) => JSON.parse(call.arguments[0]).message.startsWith(`${name} `));
      load({ [name]: '30000' });
      load({ [name]: '60000' });
      assert.equal(named().length, 2);
      warn.mock.resetCalls();
      load({ [name]: '0' });
      load({ [name]: '60001' });
      assert.equal(named().length, 0);
    });
  }

});

function logLevelWarnings(warn) {
  return warn.mock.calls.map((call) => JSON.parse(call.arguments[0])).filter((entry) => entry.message.startsWith('LOG_LEVEL'));
}

describe('trusted proxy configuration', () => {
  afterEach(restoreEnvironment);

  it('defaults TRUSTED_PROXIES to an empty list', () => {
    assert.deepEqual(load().trustedProxies, []);
    assert.deepEqual(load({ TRUSTED_PROXIES: '' }).trustedProxies, []);
    assert.deepEqual(load({ TRUSTED_PROXIES: ' , ' }).trustedProxies, []);
  });

  it('accepts IPv4 and IPv6 addresses and CIDR ranges with surrounding whitespace', () => {
    assert.deepEqual(
      load({ TRUSTED_PROXIES: ' 192.0.2.10 , 198.51.100.0/24,2001:DB8::1, fd00::/8,::ffff:203.0.113.7, 10.0.0.0/8,' }).trustedProxies,
      ['192.0.2.10', '198.51.100.0/24', '2001:db8::1', 'fd00::/8', '203.0.113.7', '10.0.0.0/8'],
    );
  });

  it('stores entries in canonical form', () => {
    assert.deepEqual(
      load({ TRUSTED_PROXIES: '::FFFF:CB00:7105, 0:0:0:0:0:ffff:c000:0200/120, ::ffff:0:0/96, 2001:0DB8:0:0::/32, fe80::1%eth0, 0000::0001' }).trustedProxies,
      ['203.0.113.5', '192.0.2.0/24', '0.0.0.0/0', '2001:db8::/32', 'fe80::1', '::1'],
    );
  });

  it('refuses to start on an invalid entry and names it', () => {
    for (const value of ['::ffff:0:0/95', '[2001:db8::1]', '[2001:db8::1]:443', 'fe80::1%', '192.0.2.1%eth0', '2001:db8::1::1', 'proxy.example.test', '192.0.2.300', '192.0.2.0/33', '2001:db8::/129', '10.0.0.0/', '10.0.0.0/8/8', '10.0.0.0/-1', '10.0.0.0/abc', '192.0.2.1:8080']) {
      assert.throws(
        () => load({ TRUSTED_PROXIES: `192.0.2.1, ${value}` }),
        { message: `TRUSTED_PROXIES must be a comma-separated list of IP addresses or CIDR ranges; "${value}" is not valid` },
        value,
      );
    }
  });
});

describe('removed configuration', () => {
  afterEach(() => {
    restoreEnvironment();
    mock.restoreAll();
  });

  it('warns but still starts when JELLYQUEST_BRIDGE_ENABLED is set', () => {
    const warn = mock.method(console, 'warn', () => {});
    const removedWarnings = () => warn.mock.calls
      .map((call) => JSON.parse(call.arguments[0]))
      .filter((entry) => entry.message.includes('JELLYQUEST_BRIDGE_ENABLED'));

    assert.equal(load().jellyfinUrl, 'http://jellyfin.test');
    assert.equal(removedWarnings().length, 0);

    for (const value of ['true', 'false']) {
      warn.mock.resetCalls();
      const config = load({ JELLYQUEST_BRIDGE_ENABLED: value, SEERR_URL: undefined, SEERR_API_KEY: undefined });
      assert.equal('jellyquestBridgeEnabled' in config, false);
      const warnings = removedWarnings();
      assert.equal(warnings.length, 1, value);
      assert.equal(warnings[0].level, 'warn');
    }
  });
});
