import path from 'node:path';
import { parseTrustedProxies } from './client-ip.js';
import { isTmdbCredential } from './tmdb.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LOG_LEVEL_ALIASES: Record<string, LogLevel> = {
  debug: 'debug',
  trace: 'debug',
  verbose: 'debug',
  info: 'info',
  information: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  err: 'error',
};
/**
 * Jellyfin drops a WebSocket after 60 s without a client KeepAlive (clients send one every 30 s once the server's
 * ForceKeepAlive arrives), so a healthy connection is never silent for a minute. Five minutes leaves a wide margin.
 */
export const DEFAULT_WS_IDLE_TIMEOUT_MS = 300_000;
/**
 * Jellyfin answers every client KeepAlive and sends ForceKeepAlive to quiet sockets, so a healthy upstream is never
 * silent for much more than 60 s even while the client keeps talking.
 */
export const DEFAULT_WS_UPSTREAM_IDLE_TIMEOUT_MS = 180_000;
const MAX_WS_IDLE_TIMEOUT_MS = 86_400_000;
const JELLYFIN_WEBSOCKET_LOST_TIMEOUT_MS = 60_000;

export interface Config {
  host: string;
  port: number;
  webhookToken: string;
  adminToken: string;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  seerrUrl?: string;
  seerrApiKey?: string;
  /** The TMDB v3 API key or v4 read access token the household app reads titles with; see docs/app-design.md. */
  tmdbApiKey?: string;
  stateFile: string;
  reconcileIntervalSeconds: number;
  catalogSyncIntervalSeconds: number;
  householdDomain?: string;
  householdHostPrefix: string;
  /** Serves the household app API on household hosts; needs Seerr, TMDB_API_KEY and HOUSEHOLD_DOMAIN. */
  householdAppEnabled: boolean;
  /**
   * The TV add-on (docs/tv-addon.md): the households whose hosts add it to Jellyfin web's page, or 'all'. Undefined
   * while TV_ADDON_ENABLED is off, and then nothing on any host changes.
   */
  tvAddonHouseholds?: string[] | 'all';
  requestBackfillEnabled: boolean;
  requestBackfillSince?: Date;
  logLevel: LogLevel;
  webSocketIdleTimeoutMs: number;
  webSocketUpstreamIdleTimeoutMs: number;
  /** Reverse proxies whose X-Forwarded-For entries are believed, as canonical addresses and CIDR ranges. */
  trustedProxies: string[];
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadConfig(): Config {
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const reconcileIntervalSeconds = Number.parseInt(process.env.RECONCILE_INTERVAL_SECONDS ?? '300', 10);
  if (!Number.isInteger(reconcileIntervalSeconds) || reconcileIntervalSeconds < 0 || reconcileIntervalSeconds > 86_400) {
    throw new Error('RECONCILE_INTERVAL_SECONDS must be an integer between 0 and 86400');
  }
  const catalogSyncIntervalSeconds = Number.parseInt(process.env.CATALOG_SYNC_INTERVAL_SECONDS ?? '3600', 10);
  if (!Number.isInteger(catalogSyncIntervalSeconds) || catalogSyncIntervalSeconds < 0 || catalogSyncIntervalSeconds > 604_800) {
    throw new Error('CATALOG_SYNC_INTERVAL_SECONDS must be an integer between 0 and 604800');
  }

  const webhookToken = required('WEBHOOK_TOKEN');
  const seerrUrl = process.env.SEERR_URL?.trim().replace(/\/+$/, '');
  const seerrApiKey = process.env.SEERR_API_KEY?.trim();
  if (!!seerrUrl !== !!seerrApiKey) {
    throw new Error('SEERR_URL and SEERR_API_KEY must be configured together');
  }
  const tmdbApiKey = process.env.TMDB_API_KEY?.trim() || undefined;
  // The message never quotes the value.
  if (tmdbApiKey && !isTmdbCredential(tmdbApiKey)) {
    throw new Error('TMDB_API_KEY must be a TMDB API key (32 hexadecimal characters) or an API read access token');
  }
  if (process.env.JELLYQUEST_BRIDGE_ENABLED?.trim()) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'JELLYQUEST_BRIDGE_ENABLED is no longer supported and is ignored; JellyQuest support was removed',
    }));
  }
  const backfillSinceInput = process.env.REQUEST_BACKFILL_SINCE?.trim();
  const requestBackfillSince = backfillSinceInput ? parseBackfillSince(backfillSinceInput) : undefined;
  const requestBackfillEnabled = booleanEnvironment('REQUEST_BACKFILL_ENABLED', Boolean(requestBackfillSince));
  if (requestBackfillEnabled && !requestBackfillSince) {
    throw new Error('REQUEST_BACKFILL_SINCE is required when REQUEST_BACKFILL_ENABLED is true');
  }
  if (requestBackfillEnabled && !seerrUrl) {
    throw new Error('SEERR_URL and SEERR_API_KEY are required when REQUEST_BACKFILL_ENABLED is true');
  }
  const householdDomain = process.env.HOUSEHOLD_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (householdDomain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(householdDomain)) {
    throw new Error('HOUSEHOLD_DOMAIN must be a valid DNS domain');
  }
  const householdHostPrefix = process.env.HOUSEHOLD_HOST_PREFIX?.trim().toLowerCase() || 'jelly-';
  if (!/^[a-z0-9-]{1,32}$/.test(householdHostPrefix)) {
    throw new Error('HOUSEHOLD_HOST_PREFIX must contain only lowercase letters, numbers, and hyphens');
  }
  const householdAppEnabled = booleanEnvironment('HOUSEHOLD_APP_ENABLED', false);
  if (householdAppEnabled && (!householdDomain || !seerrUrl || !tmdbApiKey)) {
    throw new Error('HOUSEHOLD_DOMAIN, SEERR_URL, SEERR_API_KEY and TMDB_API_KEY are required when HOUSEHOLD_APP_ENABLED is true');
  }
  const tvAddonHouseholds = parseTvAddon(householdAppEnabled);
  const logLevel = parseLogLevel(process.env.LOG_LEVEL);
  const webSocketIdleTimeoutMs = webSocketTimeout('WS_IDLE_TIMEOUT_MS', DEFAULT_WS_IDLE_TIMEOUT_MS);
  const webSocketUpstreamIdleTimeoutMs = webSocketTimeout('WS_UPSTREAM_IDLE_TIMEOUT_MS', DEFAULT_WS_UPSTREAM_IDLE_TIMEOUT_MS);
  const trustedProxies = parseTrustedProxies(process.env.TRUSTED_PROXIES);
  const adminToken = process.env.ADMIN_TOKEN?.trim();
  if (!adminToken) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'ADMIN_TOKEN is not set; falling back to WEBHOOK_TOKEN, which also grants full admin API access',
    }));
  }
  return {
    host: process.env.HOST?.trim() || '0.0.0.0',
    port,
    webhookToken,
    adminToken: adminToken || webhookToken,
    jellyfinUrl: required('JELLYFIN_URL').replace(/\/+$/, ''),
    jellyfinApiKey: required('JELLYFIN_API_KEY'),
    ...(seerrUrl && seerrApiKey ? { seerrUrl, seerrApiKey } : {}),
    ...(tmdbApiKey ? { tmdbApiKey } : {}),
    stateFile: path.resolve(process.env.STATE_FILE?.trim() || './data/grants.json'),
    reconcileIntervalSeconds,
    catalogSyncIntervalSeconds,
    ...(householdDomain ? { householdDomain } : {}),
    householdHostPrefix,
    householdAppEnabled,
    ...(tvAddonHouseholds ? { tvAddonHouseholds } : {}),
    requestBackfillEnabled,
    ...(requestBackfillSince ? { requestBackfillSince } : {}),
    logLevel,
    webSocketIdleTimeoutMs,
    webSocketUpstreamIdleTimeoutMs,
    trustedProxies,
  };
}

/**
 * Accepts `YYYY-MM-DD` (UTC midnight) or an ISO 8601 date-time with seconds optional and an
 * explicit `Z` or `±HH:MM` offset. Impossible calendar dates such as 2026-02-30 are rejected.
 */
function parseBackfillSince(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2})))?$/.exec(value);
  const invalid = () => new Error('REQUEST_BACKFILL_SINCE must be YYYY-MM-DD or an ISO 8601 date-time with Z or an offset');
  if (!match) throw invalid();
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) {
    throw invalid();
  }
  if (hour === undefined) return calendar;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) throw invalid();
  if (offsetHour !== undefined && (Number(offsetHour) > 14 || Number(offsetMinute) > 59)) throw invalid();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid();
  return date;
}

/**
 * TV_ADDON_ENABLED (default false) and TV_ADDON_HOUSEHOLDS: a comma-separated list of household (group) IDs, or `*` for
 * every household, required when the add-on is on so it is switched on deliberately, one household first. The add-on
 * calls the household app API, so it needs HOUSEHOLD_APP_ENABLED.
 */
function parseTvAddon(householdAppEnabled: boolean): string[] | 'all' | undefined {
  if (!booleanEnvironment('TV_ADDON_ENABLED', false)) return undefined;
  if (!householdAppEnabled) throw new Error('HOUSEHOLD_APP_ENABLED is required when TV_ADDON_ENABLED is true');
  const input = process.env.TV_ADDON_HOUSEHOLDS?.trim() ?? '';
  if (input === '*') return 'all';
  const households = [...new Set(input.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (!households.length) throw new Error('TV_ADDON_HOUSEHOLDS is required when TV_ADDON_ENABLED is true: household IDs separated by commas, or *');
  if (households.some((id) => !/^[a-z0-9_-]{1,128}$/.test(id))) {
    throw new Error('TV_ADDON_HOUSEHOLDS must list household IDs (letters, numbers, hyphens and underscores) separated by commas, or *');
  }
  return households;
}

/** Unknown values fall back to `info` with a warning rather than blocking startup over a logging setting. */
function parseLogLevel(input: string | undefined): LogLevel {
  const value = input?.trim();
  if (!value) return 'info';
  const level = LOG_LEVEL_ALIASES[value.toLowerCase()];
  if (level) return level;
  console.warn(JSON.stringify({
    level: 'warn',
    message: 'LOG_LEVEL is not recognised; using info',
    value,
    accepted: ['debug', 'info', 'warn', 'error'],
  }));
  return 'info';
}

function webSocketTimeout(name: string, fallback: number): number {
  const input = process.env[name]?.trim() || String(fallback);
  const value = Number(input);
  if (!/^\d+$/.test(input) || value > MAX_WS_IDLE_TIMEOUT_MS) {
    throw new Error(`${name} must be an integer between 0 and ${MAX_WS_IDLE_TIMEOUT_MS}`);
  }
  if (value > 0 && value <= JELLYFIN_WEBSOCKET_LOST_TIMEOUT_MS) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: `${name} is not above Jellyfin's 60 s WebSocket keepalive window; healthy idle clients may be disconnected`,
      [name]: value,
    }));
  }
  return value;
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}
