import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The settings the first-run setup wizard (setup.ts) stores, in their own file next to the state file (settings.json,
 * or SETTINGS_FILE), so the household state file's schema is untouched. They sit under the environment: a variable set
 * in the environment always wins, and the wizard shows the setting as locked. An install configured only by environment
 * variables never has this file, and nothing about it changes.
 *
 * The file holds secrets (the Jellyfin API key, the Seerr and TMDB keys and the webhook token), so it is written with
 * mode 0600 and nothing ever logs or answers its values.
 */
export interface StoredSettings {
  version: 1;
  /** When the file was first written: the install date, and the default request backfill cutoff. */
  createdAt: string;
  /** When the wizard last finished; until then, an install without the required settings starts in setup mode. */
  setupCompletedAt?: string;
  jellyfinUrl?: string;
  jellyfinApiKey?: string;
  /** When the wizard created `jellyfinApiKey` in Jellyfin (named JellyPass in Jellyfin's API keys). */
  jellyfinApiKeyCreatedAt?: string;
  seerrUrl?: string;
  seerrApiKey?: string;
  /** The Seerr webhook the wizard configured: the URL Seerr calls, when, and whether Seerr's own test reached JellyPass. */
  seerrWebhook?: { url: string; configuredAt: string; tested: boolean };
  webhookToken?: string;
  tmdbApiKey?: string;
  tmdbValidatedAt?: string;
  /** REQUEST_BACKFILL_SINCE, an ISO 8601 date-time. */
  requestBackfillSince?: string;
  householdGatewayEnabled?: boolean;
  householdAppEnabled?: boolean;
  /** TRUSTED_PROXIES, as its comma-separated canonical entries. */
  trustedProxies?: string;
}

/** A change to the settings: a key set to undefined is removed. */
export type SettingsChange = { [K in keyof StoredSettings]?: StoredSettings[K] | undefined };

/** Which environment variable each stored setting stands in for. */
export const SETTING_VARIABLES = {
  jellyfinUrl: 'JELLYFIN_URL',
  jellyfinApiKey: 'JELLYFIN_API_KEY',
  seerrUrl: 'SEERR_URL',
  seerrApiKey: 'SEERR_API_KEY',
  webhookToken: 'WEBHOOK_TOKEN',
  tmdbApiKey: 'TMDB_API_KEY',
  requestBackfillSince: 'REQUEST_BACKFILL_SINCE',
  householdGatewayEnabled: 'HOUSEHOLD_GATEWAY_ENABLED',
  householdAppEnabled: 'HOUSEHOLD_APP_ENABLED',
  trustedProxies: 'TRUSTED_PROXIES',
} as const satisfies Partial<Record<keyof StoredSettings, string>>;

/** The settings JellyPass cannot start without, from either source; missing any of them starts setup mode. */
export const REQUIRED_VARIABLES = ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'WEBHOOK_TOKEN'] as const;

const STRING_KEYS = ['createdAt', 'setupCompletedAt', 'jellyfinUrl', 'jellyfinApiKey', 'jellyfinApiKeyCreatedAt', 'seerrUrl', 'seerrApiKey', 'webhookToken', 'tmdbApiKey', 'tmdbValidatedAt', 'requestBackfillSince', 'trustedProxies'] as const;
const BOOLEAN_KEYS = ['householdGatewayEnabled', 'householdAppEnabled'] as const;

/** Whether the environment sets `name` (an empty or blank value is not set, as loadConfig reads it). */
export function setInEnvironment(environment: Record<string, string | undefined>, name: string): boolean {
  return Boolean(environment[name]?.trim());
}

/**
 * The environment loadConfig reads: `environment` with the stored settings under it (a variable the environment sets
 * wins), and ADMIN_TOKEN from the setup token file when the environment has none.
 */
export function mergedEnvironment(
  environment: Record<string, string | undefined>,
  settings: StoredSettings | undefined,
  adminToken?: string,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...environment };
  for (const [key, name] of Object.entries(SETTING_VARIABLES) as Array<[keyof typeof SETTING_VARIABLES, string]>) {
    const value = settings?.[key];
    if (value === undefined || setInEnvironment(environment, name)) continue;
    // The legacy HOUSEHOLD_DOMAIN turns the gateway on by itself; a stored choice never overrides it.
    if (key === 'householdGatewayEnabled' && setInEnvironment(environment, 'HOUSEHOLD_DOMAIN')) continue;
    merged[name] = String(value);
  }
  if (adminToken && !setInEnvironment(environment, 'ADMIN_TOKEN')) merged.ADMIN_TOKEN = adminToken;
  return merged;
}

/** The required settings neither source gives. */
export function missingRequired(merged: Record<string, string | undefined>): string[] {
  return REQUIRED_VARIABLES.filter((name) => !setInEnvironment(merged, name));
}

/**
 * Whether JellyPass starts in setup mode: while a required setting is in neither source, and also while the wizard's
 * settings make up what the environment lacks but the wizard has not been finished (a half-done wizard never starts
 * JellyPass's services). An install whose environment alone gives every required setting starts as configured, as it
 * always has, whatever the settings file holds.
 */
export function setupRequired(environment: Record<string, string | undefined>, settings: StoredSettings | undefined, merged: Record<string, string | undefined>): boolean {
  if (missingRequired(merged).length) return true;
  if (missingRequired(environment).length === 0) return false;
  return !settings?.setupCompletedAt;
}

/** Where the settings file and the setup token file live: next to the state file, unless SETTINGS_FILE names another. */
export function settingsPaths(environment: Record<string, string | undefined>): { settingsFile: string; adminTokenFile: string } {
  const stateFile = path.resolve(environment.STATE_FILE?.trim() || './data/grants.json');
  const settingsFile = path.resolve(environment.SETTINGS_FILE?.trim() || path.join(path.dirname(stateFile), 'settings.json'));
  return { settingsFile, adminTokenFile: path.join(path.dirname(settingsFile), 'admin-token') };
}

/** A new random secret: 32 bytes, base64url (43 characters). */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The admin token for an install without ADMIN_TOKEN: the one in `file` (written the first time setup mode starts,
 * mode 0600), or undefined when there is none and `create` is false.
 */
export async function readAdminTokenFile(file: string, { create }: { create: boolean }): Promise<string | undefined> {
  try {
    const token = (await readFile(file, 'utf8')).trim();
    if (token.length >= 32 && /^[A-Za-z0-9_-]+$/.test(token)) return token;
    throw new Error(`${file} does not hold a setup token; delete it and restart JellyPass to make a new one`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!create) return undefined;
  const token = generateSecret();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
  return token;
}

/** The settings file: read once, then written whole (and atomically) on every change, one change at a time. */
export class SettingsStore {
  readonly #file: string;
  #settings: StoredSettings | undefined;
  #writes: Promise<unknown> = Promise.resolve();
  #revision = 0;
  #closed = false;

  private constructor(file: string, settings: StoredSettings | undefined) {
    this.#file = file;
    this.#settings = settings;
  }

  /** Reads `file`; a file that is not there is no settings (it is created by the first change, never by reading). */
  public static async load(file: string): Promise<SettingsStore> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new SettingsStore(file, undefined);
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`settings file ${file} is not valid JSON`);
    }
    return new SettingsStore(file, validSettings(value, file));
  }

  public get file(): string {
    return this.#file;
  }

  /** The stored settings, or undefined while the file does not exist. */
  public get current(): Readonly<StoredSettings> | undefined {
    return this.#settings ? { ...this.#settings } : undefined;
  }

  /** Counts the changes made since the file was read. */
  public get revision(): number {
    return this.#revision;
  }

  /**
   * Applies `change` to a copy of the settings (a new file starts with createdAt now) and writes it; a key set to
   * undefined is removed. Changes run one at a time, so each sees the one before it; `change` may throw to make none.
   */
  public update(change: (settings: StoredSettings) => SettingsChange | Promise<SettingsChange>): Promise<StoredSettings> {
    if (this.#closed) return Promise.reject(new Error('the settings store is closed: JellyPass is restarting with the saved settings'));
    const run = async () => {
      const base: StoredSettings = this.#settings ? { ...this.#settings } : { version: 1, createdAt: new Date().toISOString() };
      const next = { ...base, ...(await change({ ...base })) } as StoredSettings;
      for (const key of Object.keys(next) as Array<keyof StoredSettings>) if (next[key] === undefined) delete next[key];
      await this.#write(validSettings(next, this.#file));
      this.#settings = next;
      this.#revision += 1;
      return { ...next };
    };
    const result = this.#writes.then(run, run);
    this.#writes = result.catch(() => undefined);
    return result;
  }

  /**
   * Refuses every later change and waits for the ones already made to be written, so the next phase of JellyPass can
   * read the file knowing nothing from this one writes it again.
   */
  public async close(): Promise<void> {
    this.#closed = true;
    await this.#writes;
  }

  async #write(settings: StoredSettings): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

/** The settings in `value`, or throws naming the key (never its value) that is not what it should be. */
function validSettings(value: unknown, file: string): StoredSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`settings file ${file} must hold a JSON object`);
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error(`settings file ${file} has an unsupported version`);
  for (const key of STRING_KEYS) {
    if (record[key] !== undefined && (typeof record[key] !== 'string' || !(record[key] as string).trim())) {
      throw new Error(`settings file ${file} has an invalid ${key}`);
    }
  }
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) throw new Error(`settings file ${file} has an invalid createdAt`);
  for (const key of BOOLEAN_KEYS) {
    if (record[key] !== undefined && typeof record[key] !== 'boolean') throw new Error(`settings file ${file} has an invalid ${key}`);
  }
  const webhook = record.seerrWebhook as Record<string, unknown> | undefined;
  if (webhook !== undefined && (!webhook || typeof webhook !== 'object' || typeof webhook.url !== 'string' || typeof webhook.configuredAt !== 'string' || typeof webhook.tested !== 'boolean')) {
    throw new Error(`settings file ${file} has an invalid seerrWebhook`);
  }
  return record as unknown as StoredSettings;
}
