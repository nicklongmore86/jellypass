import path from 'node:path';
import { publicProbeUrls } from './self-check.js';
import { parseAdditionalPluginRoutes } from './gateway-route-policy.js';
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
  jellyfinPublicUrls: string[];
  seerrPublicUrl?: string;
  additionalPluginRoutes: string[];
  /** The member listener (household addresses only), HOST and PORT; started only with the household gateway on. */
  host: string;
  port: number;
  /** The admin listener (admin site and API, metrics, the Seerr webhook, health), ADMIN_HOST and ADMIN_PORT. */
  adminHost: string;
  adminPort: number;
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
  /**
   * HOUSEHOLD_GATEWAY_ENABLED (default: on when HOUSEHOLD_DOMAIN is set): the member listener serves the households'
   * addresses (the address map, and the legacy rule below). Needs TRUSTED_PROXIES.
   */
  householdGatewayEnabled: boolean;
  /** The legacy address rule, `https://<householdHostPrefix><household>.<householdDomain>` (HOUSEHOLD_DOMAIN). */
  householdDomain?: string;
  householdHostPrefix: string;
  /**
   * LEGACY_WEBHOOK_ON_MEMBER_PORT: also answer POST /webhooks/seerr on the member listener, for a Host that is no
   * household's, so a Seerr webhook URL from before 4.0.0 keeps working until it is moved to the admin listener.
   */
  legacyWebhookOnMemberPort: boolean;
  /** Serves the household app API on household addresses; needs Seerr, TMDB_API_KEY and the household gateway. */
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
  /**
   * JELLYFIN_UNTESTED_VERSION_OK: one exact Jellyfin version, outside the supported releases, that counts as confirmed
   * without an administrator confirming it in the admin site (see JellyfinVersionGate).
   */
  jellyfinUntestedVersionOk?: string;
}

/**
 * The environment loadConfig reads: process.env, or the one it was given (process.env with the setup wizard's stored
 * settings under it, see settings.ts). Set only while loadConfig runs, which is synchronous.
 */
let env: Record<string, string | undefined> = process.env;

function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadConfig(environment: Record<string, string | undefined> = process.env): Config {
  env = environment;
  try {
    return readConfig();
  } finally {
    env = process.env;
  }
}

function readConfig(): Config {
  const port = portEnvironment('PORT', 8787);
  const adminPort = portEnvironment('ADMIN_PORT', 8788);
  const reconcileIntervalSeconds = Number.parseInt(env.RECONCILE_INTERVAL_SECONDS ?? '300', 10);
  if (!Number.isInteger(reconcileIntervalSeconds) || reconcileIntervalSeconds < 0 || reconcileIntervalSeconds > 86_400) {
    throw new Error('RECONCILE_INTERVAL_SECONDS must be an integer between 0 and 86400');
  }
  const catalogSyncIntervalSeconds = Number.parseInt(env.CATALOG_SYNC_INTERVAL_SECONDS ?? '3600', 10);
  if (!Number.isInteger(catalogSyncIntervalSeconds) || catalogSyncIntervalSeconds < 0 || catalogSyncIntervalSeconds > 604_800) {
    throw new Error('CATALOG_SYNC_INTERVAL_SECONDS must be an integer between 0 and 604800');
  }

  const webhookToken = required('WEBHOOK_TOKEN');
  const seerrUrl = env.SEERR_URL?.trim().replace(/\/+$/, '');
  const seerrApiKey = env.SEERR_API_KEY?.trim();
  if (!!seerrUrl !== !!seerrApiKey) {
    throw new Error('SEERR_URL and SEERR_API_KEY must be configured together');
  }
  const tmdbApiKey = env.TMDB_API_KEY?.trim() || undefined;
  // The message never quotes the value.
  if (tmdbApiKey && !isTmdbCredential(tmdbApiKey)) {
    throw new Error('TMDB_API_KEY must be a TMDB API key (32 hexadecimal characters) or an API read access token');
  }
  if (env.JELLYQUEST_BRIDGE_ENABLED?.trim()) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'JELLYQUEST_BRIDGE_ENABLED is no longer supported and is ignored; JellyQuest support was removed',
    }));
  }
  const backfillSinceInput = env.REQUEST_BACKFILL_SINCE?.trim();
  const requestBackfillSince = backfillSinceInput ? parseBackfillSince(backfillSinceInput) : undefined;
  const requestBackfillEnabled = booleanEnvironment('REQUEST_BACKFILL_ENABLED', Boolean(requestBackfillSince));
  if (requestBackfillEnabled && !requestBackfillSince) {
    throw new Error('REQUEST_BACKFILL_SINCE is required when REQUEST_BACKFILL_ENABLED is true');
  }
  if (requestBackfillEnabled && !seerrUrl) {
    throw new Error('SEERR_URL and SEERR_API_KEY are required when REQUEST_BACKFILL_ENABLED is true');
  }
  const householdDomain = env.HOUSEHOLD_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (householdDomain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(householdDomain)) {
    throw new Error('HOUSEHOLD_DOMAIN must be a valid DNS domain');
  }
  // The legacy rule's own default, so an install from before 4.0.0 that never set a prefix keeps its addresses.
  const householdHostPrefix = env.HOUSEHOLD_HOST_PREFIX?.trim().toLowerCase() || 'jelly-';
  if (!/^[a-z0-9-]{1,32}$/.test(householdHostPrefix)) {
    throw new Error('HOUSEHOLD_HOST_PREFIX must contain only lowercase letters, numbers, and hyphens');
  }
  const householdGatewayEnabled = booleanEnvironment('HOUSEHOLD_GATEWAY_ENABLED', Boolean(householdDomain));
  const householdAppEnabled = booleanEnvironment('HOUSEHOLD_APP_ENABLED', false);
  if (householdAppEnabled && (!householdGatewayEnabled || !seerrUrl || !tmdbApiKey)) {
    throw new Error('the household gateway (HOUSEHOLD_GATEWAY_ENABLED, or HOUSEHOLD_DOMAIN), SEERR_URL, SEERR_API_KEY and TMDB_API_KEY are required when HOUSEHOLD_APP_ENABLED is true');
  }
  const legacyWebhookOnMemberPort = booleanEnvironment('LEGACY_WEBHOOK_ON_MEMBER_PORT', false);
  const tvAddonHouseholds = parseTvAddon(householdAppEnabled);
  const logLevel = parseLogLevel(env.LOG_LEVEL);
  const webSocketIdleTimeoutMs = webSocketTimeout('WS_IDLE_TIMEOUT_MS', DEFAULT_WS_IDLE_TIMEOUT_MS);
  const webSocketUpstreamIdleTimeoutMs = webSocketTimeout('WS_UPSTREAM_IDLE_TIMEOUT_MS', DEFAULT_WS_UPSTREAM_IDLE_TIMEOUT_MS);
  const trustedProxies = parseTrustedProxies(env.TRUSTED_PROXIES);
  // Household addresses are only ever served behind a reverse proxy (it terminates HTTPS); naming it is required, so
  // sign-in rate limits apply per client rather than to the proxy as a whole.
  if (householdGatewayEnabled && trustedProxies.length === 0) {
    throw new Error('TRUSTED_PROXIES is required when the household gateway is on (HOUSEHOLD_GATEWAY_ENABLED, or HOUSEHOLD_DOMAIN): set it to the IP address or CIDR range of the reverse proxy in front of JellyPass');
  }
  const host = env.HOST?.trim() || '0.0.0.0';
  const adminHost = env.ADMIN_HOST?.trim() || '127.0.0.1';
  if (householdGatewayEnabled && adminPort === port) {
    throw new Error('ADMIN_PORT must differ from PORT: the admin site is never served on the member (household) listener');
  }
  const jellyfinUntestedVersionOk = env.JELLYFIN_UNTESTED_VERSION_OK?.trim() || undefined;
  if (jellyfinUntestedVersionOk && !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(jellyfinUntestedVersionOk)) {
    throw new Error('JELLYFIN_UNTESTED_VERSION_OK must be one exact Jellyfin version, as the admin site shows it (for example 13.0.0)');
  }
  const adminToken = env.ADMIN_TOKEN?.trim();
  if (!adminToken) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'ADMIN_TOKEN is not set; falling back to WEBHOOK_TOKEN, which also grants full admin API access',
    }));
  }
  return {
    jellyfinPublicUrls: publicProbeUrls(env.JELLYFIN_PUBLIC_URLS),
    ...(env.SEERR_PUBLIC_URL ? { seerrPublicUrl: publicProbeUrls(env.SEERR_PUBLIC_URL)[0] } : {}),
    additionalPluginRoutes: parseAdditionalPluginRoutes(env.HOUSEHOLD_PLUGIN_ROUTES),
    host,
    port,
    adminHost,
    adminPort,
    webhookToken,
    adminToken: adminToken || webhookToken,
    jellyfinUrl: required('JELLYFIN_URL').replace(/\/+$/, ''),
    jellyfinApiKey: required('JELLYFIN_API_KEY'),
    ...(seerrUrl && seerrApiKey ? { seerrUrl, seerrApiKey } : {}),
    ...(tmdbApiKey ? { tmdbApiKey } : {}),
    stateFile: path.resolve(env.STATE_FILE?.trim() || './data/grants.json'),
    reconcileIntervalSeconds,
    catalogSyncIntervalSeconds,
    householdGatewayEnabled,
    ...(householdDomain ? { householdDomain } : {}),
    householdHostPrefix,
    legacyWebhookOnMemberPort,
    householdAppEnabled,
    ...(tvAddonHouseholds ? { tvAddonHouseholds } : {}),
    requestBackfillEnabled,
    ...(requestBackfillSince ? { requestBackfillSince } : {}),
    logLevel,
    webSocketIdleTimeoutMs,
    webSocketUpstreamIdleTimeoutMs,
    trustedProxies,
    ...(jellyfinUntestedVersionOk ? { jellyfinUntestedVersionOk } : {}),
  };
}

/**
 * Accepts `YYYY-MM-DD` (UTC midnight) or an ISO 8601 date-time with seconds optional and an
 * explicit `Z` or `±HH:MM` offset. Impossible calendar dates such as 2026-02-30 are rejected.
 */
export function parseBackfillSince(value: string): Date {
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
  const input = env.TV_ADDON_HOUSEHOLDS?.trim() ?? '';
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
  const input = env[name]?.trim() || String(fallback);
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

function portEnvironment(name: string, fallback: number): number {
  const port = Number.parseInt(env[name] ?? String(fallback), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}
