import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  webhookToken: string;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  stateFile: string;
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

  return {
    host: process.env.HOST?.trim() || '0.0.0.0',
    port,
    webhookToken: required('WEBHOOK_TOKEN'),
    jellyfinUrl: required('JELLYFIN_URL').replace(/\/+$/, ''),
    jellyfinApiKey: required('JELLYFIN_API_KEY'),
    stateFile: path.resolve(process.env.STATE_FILE?.trim() || './data/grants.json'),
  };
}
