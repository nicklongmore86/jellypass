import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  webhookToken: string;
  adminToken: string;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  stateFile: string;
  reconcileIntervalSeconds: number;
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

  const webhookToken = required('WEBHOOK_TOKEN');

  return {
    host: process.env.HOST?.trim() || '0.0.0.0',
    port,
    webhookToken,
    adminToken: process.env.ADMIN_TOKEN?.trim() || webhookToken,
    jellyfinUrl: required('JELLYFIN_URL').replace(/\/+$/, ''),
    jellyfinApiKey: required('JELLYFIN_API_KEY'),
    stateFile: path.resolve(process.env.STATE_FILE?.trim() || './data/grants.json'),
    reconcileIntervalSeconds,
  };
}
