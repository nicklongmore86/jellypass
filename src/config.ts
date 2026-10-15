import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  webhookToken: string;
  adminToken: string;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  seerrUrl?: string;
  seerrApiKey?: string;
  jellyquestBridgeEnabled: boolean;
  stateFile: string;
  reconcileIntervalSeconds: number;
  catalogSyncIntervalSeconds: number;
  householdDomain?: string;
  householdHostPrefix: string;
  requestBackfillEnabled: boolean;
  requestBackfillSince?: Date;
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
  const jellyquestBridgeEnabled = booleanEnvironment('JELLYQUEST_BRIDGE_ENABLED', false);
  if (jellyquestBridgeEnabled && !seerrUrl) {
    throw new Error('SEERR_URL and SEERR_API_KEY are required when JELLYQUEST_BRIDGE_ENABLED is true');
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
    jellyquestBridgeEnabled,
    stateFile: path.resolve(process.env.STATE_FILE?.trim() || './data/grants.json'),
    reconcileIntervalSeconds,
    catalogSyncIntervalSeconds,
    ...(householdDomain ? { householdDomain } : {}),
    householdHostPrefix,
    requestBackfillEnabled,
    ...(requestBackfillSince ? { requestBackfillSince } : {}),
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

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}
