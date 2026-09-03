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
  const householdDomain = process.env.HOUSEHOLD_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (householdDomain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(householdDomain)) {
    throw new Error('HOUSEHOLD_DOMAIN must be a valid DNS domain');
  }
  const householdHostPrefix = process.env.HOUSEHOLD_HOST_PREFIX?.trim().toLowerCase() || 'jelly-';
  if (!/^[a-z0-9-]{1,32}$/.test(householdHostPrefix)) {
    throw new Error('HOUSEHOLD_HOST_PREFIX must contain only lowercase letters, numbers, and hyphens');
  }
  return {
    host: process.env.HOST?.trim() || '0.0.0.0',
    port,
    webhookToken,
    adminToken: process.env.ADMIN_TOKEN?.trim() || webhookToken,
    jellyfinUrl: required('JELLYFIN_URL').replace(/\/+$/, ''),
    jellyfinApiKey: required('JELLYFIN_API_KEY'),
    ...(seerrUrl && seerrApiKey ? { seerrUrl, seerrApiKey } : {}),
    jellyquestBridgeEnabled,
    stateFile: path.resolve(process.env.STATE_FILE?.trim() || './data/grants.json'),
    reconcileIntervalSeconds,
    catalogSyncIntervalSeconds,
    ...(householdDomain ? { householdDomain } : {}),
    householdHostPrefix,
  };
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}
