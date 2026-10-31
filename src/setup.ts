import { randomUUID } from 'node:crypto';
import { parseTrustedProxies } from './client-ip.js';
import { loadConfig, parseBackfillSince } from './config.js';
import { generateSecret, mergedEnvironment, missingRequired, setInEnvironment, type SettingsChange, type SettingsStore, type StoredSettings } from './settings.js';
import { isTmdbCredential, TmdbClient, TmdbError } from './tmdb.js';

/**
 * The first-run setup wizard (docs/server-reference.md, "Setup wizard"): each step checks what it is given against the
 * service it names and stores the result in the settings file at once, so a wizard left half done picks up where it
 * stopped and a step run again changes only what it must. Nothing is applied until `finish`, which checks the whole
 * configuration and then restarts JellyPass's services in place with it.
 *
 * It is served on the admin listener only, to callers with ADMIN_TOKEN as a bearer token (see server.ts). A setting the
 * environment sets is locked: the wizard shows it and refuses to change it. No answer, error or log line carries a
 * secret's value: the Jellyfin administrator password is used once and never stored, and keys are only "set".
 */

/** A step refused: its HTTP status, a stable code and a sentence for the admin site (never holding a secret). */
export class SetupError extends Error {
  public constructor(public readonly status: number, public readonly code: string, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

/** The webhook payload JellyPass reads (docs/server-reference.md, "Seerr webhook"), as Seerr's form takes it. */
export const SEERR_WEBHOOK_TEMPLATE = JSON.stringify({
  notificationType: '{{notification_type}}',
  event: '{{event}}',
  media: { jellyfinMediaId: '{{media_jellyfinMediaId}}', mediaType: '{{media_type}}' },
  request: { id: '{{request_id}}', requestedBy: { jellyfinUserId: '{{requestedBy_jellyfinUserId}}', username: '{{requestedBy_username}}' } },
}, null, 2);
/** Seerr's notification type bit for Request Available (MEDIA_AVAILABLE), the only event the webhook needs. */
export const SEERR_MEDIA_AVAILABLE = 8;
/** The name the wizard gives the API key it creates in Jellyfin (Dashboard → API Keys). */
export const JELLYFIN_KEY_NAME = 'JellyPass';
const CALL_TIMEOUT_MS = 15_000;

export interface SetupWizardOptions {
  settings: SettingsStore;
  /** The process environment: every variable it sets locks the setting it names. */
  environment: Record<string, string | undefined>;
  /** `setup` while JellyPass waits for its first configuration, `running` once it serves. */
  mode: 'setup' | 'running';
  /** Where the admin token comes from: ADMIN_TOKEN, or the setup token file. */
  adminTokenSource: 'environment' | 'file' | 'webhook_token';
  /** Applies the settings: restarts JellyPass's services with them. Called after `finish` has answered. */
  apply: () => void;
  /** TMDB's API base URL (tests). */
  tmdbBaseUrl?: string;
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

type Body = Record<string, unknown>;

export class SetupWizard {
  readonly #settings: SettingsStore;
  readonly #environment: Record<string, string | undefined>;
  readonly #mode: 'setup' | 'running';
  readonly #adminTokenSource: SetupWizardOptions['adminTokenSource'];
  readonly #apply: () => void;
  readonly #tmdbBaseUrl: string | undefined;
  readonly #now: () => number;
  readonly #log: NonNullable<SetupWizardOptions['log']>;
  readonly #bootRevision: number;
  #steps: Promise<unknown> = Promise.resolve();
  #applying = false;
  /** When a Seerr webhook test last reached the setup-mode listener (see recordWebhookTest). */
  #webhookTestAt: number | undefined;

  public constructor(options: SetupWizardOptions) {
    this.#settings = options.settings;
    this.#environment = options.environment;
    this.#mode = options.mode;
    this.#adminTokenSource = options.adminTokenSource;
    this.#apply = options.apply;
    this.#tmdbBaseUrl = options.tmdbBaseUrl;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((message, fields = {}) => console.log(JSON.stringify({ level: 'info', message, ...fields })));
    this.#bootRevision = options.settings.revision;
  }

  /** The webhook token Seerr must send: the environment's, else the stored one (setup mode answers Seerr's test with it). */
  public webhookToken(): string | undefined {
    return this.#effective('WEBHOOK_TOKEN', 'webhookToken');
  }

  /** A Seerr webhook test reached JellyPass with the right token and payload. */
  public recordWebhookTest(): void {
    this.#webhookTestAt = this.#now();
  }

  /** Where each step stands. Secrets are only `set` or not; a setting the environment sets is `locked`. */
  public status(): Record<string, unknown> {
    const stored = this.#settings.current;
    const merged = this.#merged();
    const lock = (...names: string[]) => names.some((name) => setInEnvironment(this.#environment, name));
    const source = (name: string, key: keyof StoredSettings) => setInEnvironment(this.#environment, name) ? 'environment' : stored?.[key] !== undefined ? 'settings' : 'none';
    const proxies = merged.TRUSTED_PROXIES?.trim();
    return {
      mode: this.#mode,
      completedAt: stored?.setupCompletedAt ?? null,
      installedAt: stored?.createdAt ?? null,
      settingsFile: this.#settings.file,
      missing: missingRequired(merged).map(describeRequired),
      restartNeeded: this.#mode === 'running' && this.#settings.revision !== this.#bootRevision,
      adminToken: this.#adminTokenSource,
      steps: {
        jellyfin: {
          url: merged.JELLYFIN_URL?.trim() || null,
          apiKey: setInEnvironment(merged, 'JELLYFIN_API_KEY') ? 'set' : 'unset',
          source: source('JELLYFIN_API_KEY', 'jellyfinApiKey'),
          createdByJellyPass: !lock('JELLYFIN_API_KEY') && Boolean(stored?.jellyfinApiKeyCreatedAt),
          locked: lock('JELLYFIN_URL', 'JELLYFIN_API_KEY'),
          lockedBy: lockedBy(this.#environment, 'JELLYFIN_URL', 'JELLYFIN_API_KEY'),
        },
        seerr: {
          url: merged.SEERR_URL?.trim() || null,
          apiKey: setInEnvironment(merged, 'SEERR_API_KEY') ? 'set' : 'unset',
          source: source('SEERR_API_KEY', 'seerrApiKey'),
          locked: lock('SEERR_URL', 'SEERR_API_KEY'),
          lockedBy: lockedBy(this.#environment, 'SEERR_URL', 'SEERR_API_KEY'),
          webhook: stored?.seerrWebhook ? { ...stored.seerrWebhook } : null,
        },
        secrets: {
          webhookToken: setInEnvironment(merged, 'WEBHOOK_TOKEN') ? 'set' : 'unset',
          source: source('WEBHOOK_TOKEN', 'webhookToken'),
          locked: lock('WEBHOOK_TOKEN'),
          lockedBy: lockedBy(this.#environment, 'WEBHOOK_TOKEN'),
        },
        tmdb: {
          apiKey: setInEnvironment(merged, 'TMDB_API_KEY') ? 'set' : 'unset',
          source: source('TMDB_API_KEY', 'tmdbApiKey'),
          validatedAt: lock('TMDB_API_KEY') ? null : stored?.tmdbValidatedAt ?? null,
          locked: lock('TMDB_API_KEY'),
          lockedBy: lockedBy(this.#environment, 'TMDB_API_KEY'),
        },
        backfill: {
          since: merged.REQUEST_BACKFILL_SINCE?.trim() || null,
          enabled: merged.REQUEST_BACKFILL_ENABLED?.trim() ? /^(true|1)$/i.test(merged.REQUEST_BACKFILL_ENABLED.trim()) : Boolean(merged.REQUEST_BACKFILL_SINCE?.trim()),
          suggested: stored?.createdAt ?? new Date(this.#now()).toISOString(),
          locked: lock('REQUEST_BACKFILL_SINCE', 'REQUEST_BACKFILL_ENABLED'),
          lockedBy: lockedBy(this.#environment, 'REQUEST_BACKFILL_SINCE', 'REQUEST_BACKFILL_ENABLED'),
        },
        household: {
          gatewayEnabled: booleanValue(merged.HOUSEHOLD_GATEWAY_ENABLED) ?? Boolean(merged.HOUSEHOLD_DOMAIN?.trim()),
          appEnabled: booleanValue(merged.HOUSEHOLD_APP_ENABLED) ?? false,
          trustedProxies: proxies ? proxies.split(',').map((entry) => entry.trim()).filter(Boolean) : [],
          locked: {
            gatewayEnabled: lock('HOUSEHOLD_GATEWAY_ENABLED', 'HOUSEHOLD_DOMAIN'),
            appEnabled: lock('HOUSEHOLD_APP_ENABLED'),
            trustedProxies: lock('TRUSTED_PROXIES'),
          },
          lockedBy: lockedBy(this.#environment, 'HOUSEHOLD_GATEWAY_ENABLED', 'HOUSEHOLD_DOMAIN', 'HOUSEHOLD_APP_ENABLED', 'TRUSTED_PROXIES'),
        },
      },
    };
  }

  /**
   * Connects Jellyfin: signs in as the administrator given (once; the password is never stored), creates an API key
   * named JellyPass for JellyPass alone, checks it, and signs that session out again. Run again for the same Jellyfin
   * while the stored key still works, it keeps that key and needs no sign-in, so a re-run never piles up keys.
   */
  public jellyfin(body: Body): Promise<Record<string, unknown>> {
    return this.#step(async () => {
      this.#refuseLocked('JELLYFIN_URL', 'JELLYFIN_API_KEY');
      only(body, ['url', 'username', 'password']);
      const url = serviceUrl(body.url, 'Jellyfin');
      const stored = this.#settings.current;
      const version = await jellyfinVersion(url);
      if (stored?.jellyfinApiKey && stored.jellyfinUrl === url && await jellyfinKeyWorks(url, stored.jellyfinApiKey)) {
        this.#log('setup: Jellyfin API key kept', { url });
        return { status: 'kept', url, version };
      }
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username || username.length > 256 || password.length > 4096) {
        throw new SetupError(400, 'jellyfin_credentials_required', 'Enter the name and password of a Jellyfin administrator.');
      }
      const apiKey = await createJellyfinKey(url, username, password);
      await this.#settings.update(() => ({ jellyfinUrl: url, jellyfinApiKey: apiKey, jellyfinApiKeyCreatedAt: new Date(this.#now()).toISOString() }));
      this.#log('setup: Jellyfin API key created', { url, name: JELLYFIN_KEY_NAME });
      return { status: 'created', url, version, keyName: JELLYFIN_KEY_NAME };
    });
  }

  /** Connects Seerr: checks the URL and that the API key is an administrator's (it can read the webhook settings). */
  public seerr(body: Body): Promise<Record<string, unknown>> {
    return this.#step(async () => {
      this.#refuseLocked('SEERR_URL', 'SEERR_API_KEY');
      only(body, ['url', 'apiKey']);
      const url = serviceUrl(body.url, 'Seerr');
      const stored = this.#settings.current;
      const given = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      // A re-run for the same Seerr may leave the key out: the stored one is checked again.
      const apiKey = given || (stored?.seerrUrl === url ? stored.seerrApiKey : undefined);
      if (!apiKey || apiKey.length > 1024 || /\s/.test(apiKey)) throw new SetupError(400, 'seerr_key_required', 'Enter Seerr\'s API key (Settings → General).');
      const version = await seerrVersion(url);
      await seerrWebhookSettings(url, apiKey);
      await this.#settings.update((settings) => ({
        seerrUrl: url,
        seerrApiKey: apiKey,
        // A webhook configured in another Seerr is not this one's.
        ...(settings.seerrUrl !== url ? { seerrWebhook: undefined } : {}),
      }));
      this.#log('setup: Seerr connected', { url });
      return { status: 'connected', url, version };
    });
  }

  /** Generates the secrets the install needs and does not have yet (the webhook token); never replaces one. */
  public secrets(body: Body): Promise<Record<string, unknown>> {
    return this.#step(async () => {
      only(body, []);
      return { webhookToken: await this.#ensureWebhookToken() };
    });
  }

  /**
   * Points Seerr's webhook at JellyPass: Request Available only, the payload JellyPass reads, and the webhook token as
   * a bearer token. Seerr has a single webhook; one that is on and calls somewhere else is replaced only with
   * `replace: true`. Then asks Seerr to send its test notification and reports whether it reached JellyPass.
   */
  public webhook(body: Body): Promise<Record<string, unknown>> {
    return this.#step(async () => {
      only(body, ['jellypassUrl', 'replace']);
      const merged = this.#merged();
      const seerrUrl = merged.SEERR_URL?.trim();
      const seerrKey = merged.SEERR_API_KEY?.trim();
      if (!seerrUrl || !seerrKey) throw new SetupError(409, 'seerr_required', 'Connect Seerr first.');
      const base = serviceUrl(body.jellypassUrl, 'JellyPass', 'jellypassUrl');
      const webhookUrl = `${base}/webhooks/seerr`;
      if (body.replace !== undefined && typeof body.replace !== 'boolean') throw new SetupError(400, 'invalid_request', 'replace must be a boolean');
      await this.#ensureWebhookToken();
      const token = this.webhookToken() as string;
      const current = await seerrWebhookSettings(seerrUrl, seerrKey);
      const currentUrl = typeof current.options?.webhookUrl === 'string' ? current.options.webhookUrl : '';
      if (current.enabled === true && currentUrl && currentUrl !== webhookUrl && body.replace !== true) {
        throw new SetupError(409, 'seerr_webhook_in_use', 'Seerr\'s webhook is already on and calls another address. Replace it?', { currentHost: hostOf(currentUrl) });
      }
      const settings = {
        enabled: true,
        embedPoster: false,
        types: SEERR_MEDIA_AVAILABLE,
        options: {
          webhookUrl,
          authHeader: `Bearer ${token}`,
          jsonPayload: SEERR_WEBHOOK_TEMPLATE,
          customHeaders: Array.isArray(current.options?.customHeaders) ? current.options.customHeaders : [],
          supportVariables: false,
        },
      };
      await seerrCall(seerrUrl, seerrKey, '/api/v1/settings/notifications/webhook', 'POST', settings);
      const testedFrom = this.#now();
      const test = await seerrCall(seerrUrl, seerrKey, '/api/v1/settings/notifications/webhook/test', 'POST', settings, { allowFailure: true });
      // In setup mode JellyPass itself answered the test, so it also knows the test arrived with the right token.
      const tested = test.status >= 200 && test.status < 300 && (this.#mode === 'running' || (this.#webhookTestAt ?? 0) >= testedFrom);
      await this.#settings.update(() => ({ seerrWebhook: { url: webhookUrl, configuredAt: new Date(this.#now()).toISOString(), tested } }));
      this.#log('setup: Seerr webhook configured', { url: webhookUrl, tested });
      return { status: 'configured', url: webhookUrl, tested };
    });
  }

  /** Checks a TMDB API key (v3) or read access token (v4) with TMDB and stores it; `apiKey: null` removes it. */
  public tmdb(body: Body): Promise<Record<string, unknown>> {
    return this.#step(async () => {
      this.#refuseLocked('TMDB_API_KEY');
      only(body, ['apiKey']);
      if (body.apiKey === null) {
        if (booleanValue(this.#merged().HOUSEHOLD_APP_ENABLED)) throw new SetupError(409, 'tmdb_required_by_app', 'The household app needs the TMDB key. Turn the app off first.');
        await this.#settings.update(() => ({ tmdbApiKey: undefined, tmdbValidatedAt: undefined }));
        return { status: 'removed' };
      }
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!isTmdbCredential(apiKey)) throw new SetupError(400, 'tmdb_key_invalid', 'That is not a TMDB API key (32 hexadecimal characters) or API read access token.');
      try {
        await new TmdbClient(apiKey, this.#tmdbBaseUrl ? { baseUrl: this.#tmdbBaseUrl } : {}).validate();
      } catch (error) {
        if (error instanceof TmdbError && (error.status === 401 || error.status === 403)) throw new SetupError(400, 'tmdb_key_refused', 'TMDB refused that key.');
        throw new SetupError(502, 'tmdb_unreachable', 'Could not check the key with TMDB. Try again in a moment.');
      }
      await this.#settings.update(() => ({ tmdbApiKey: apiKey, tmdbValidatedAt: new Date(this.#now()).toISOString() }));
      this.#log('setup: TMDB key checked');
      return { status: 'validated' };
    });
  }

  /**
   * Sets the request backfill cutoff: by default the install date (when the settings file was first written), so no
   * request made before JellyPass was installed is ever imported. `since: null` turns the backfill off.
   */
  public backfill(body: Body): Promise<Record<string, unknown>> {
    return this.#step(async () => {
      this.#refuseLocked('REQUEST_BACKFILL_SINCE', 'REQUEST_BACKFILL_ENABLED');
      only(body, ['since']);
      if (body.since === null) {
        await this.#settings.update(() => ({ requestBackfillSince: undefined }));
        return { status: 'off' };
      }
      if (!this.#merged().SEERR_URL?.trim()) throw new SetupError(409, 'seerr_required', 'The request backfill reads Seerr. Connect Seerr first.');
      let since: string | undefined;
      if (body.since !== undefined) {
        if (typeof body.since !== 'string') throw new SetupError(400, 'invalid_request', 'since must be a date');
        try {
          since = parseBackfillSince(body.since.trim()).toISOString();
        } catch (error) {
          throw new SetupError(400, 'backfill_since_invalid', (error as Error).message);
        }
      }
      // Without a date, the install date: createdAt, which the first change (this one, at the latest) writes.
      const saved = await this.#settings.update((settings) => ({ requestBackfillSince: since ?? settings.createdAt }));
      return { status: 'saved', since: saved.requestBackfillSince };
    });
  }

  /** The household gateway, the household app and the reverse proxies in front of JellyPass (TRUSTED_PROXIES). */
  public household(body: Body): Promise<Record<string, unknown>> {
    return this.#step(async () => {
      only(body, ['gatewayEnabled', 'appEnabled', 'trustedProxies']);
      const change: SettingsChange = {};
      if (body.trustedProxies !== undefined) {
        this.#refuseLocked('TRUSTED_PROXIES');
        const list = Array.isArray(body.trustedProxies) ? body.trustedProxies : typeof body.trustedProxies === 'string' ? body.trustedProxies.split(/[\s,]+/) : null;
        if (!list || list.some((entry) => typeof entry !== 'string')) throw new SetupError(400, 'invalid_request', 'trustedProxies must be a list of IP addresses or CIDR ranges');
        let proxies: string[];
        try {
          proxies = parseTrustedProxies((list as string[]).join(','), 'trustedProxies');
        } catch (error) {
          throw new SetupError(400, 'trusted_proxies_invalid', (error as Error).message);
        }
        change.trustedProxies = proxies.length ? proxies.join(',') : undefined;
      }
      for (const [key, name] of [['gatewayEnabled', 'HOUSEHOLD_GATEWAY_ENABLED'], ['appEnabled', 'HOUSEHOLD_APP_ENABLED']] as const) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== 'boolean') throw new SetupError(400, 'invalid_request', `${key} must be a boolean`);
        this.#refuseLocked(name, ...(key === 'gatewayEnabled' ? ['HOUSEHOLD_DOMAIN'] : []));
        change[key === 'gatewayEnabled' ? 'householdGatewayEnabled' : 'householdAppEnabled'] = body[key] as boolean;
      }
      const next = mergedEnvironment(this.#environment, { ...(this.#settings.current ?? { version: 1, createdAt: '' }), ...change } as StoredSettings);
      const gateway = booleanValue(next.HOUSEHOLD_GATEWAY_ENABLED) ?? Boolean(next.HOUSEHOLD_DOMAIN?.trim());
      if (gateway && !next.TRUSTED_PROXIES?.trim()) {
        throw new SetupError(409, 'trusted_proxies_required', 'Household addresses are served behind a reverse proxy: enter its IP address (or CIDR range) first.');
      }
      if (booleanValue(next.HOUSEHOLD_APP_ENABLED) && (!gateway || !next.SEERR_URL?.trim() || !next.TMDB_API_KEY?.trim())) {
        throw new SetupError(409, 'app_requirements_missing', 'The household app needs household addresses on, Seerr and a TMDB key.');
      }
      await this.#settings.update(() => change);
      return { status: 'saved' };
    });
  }

  /**
   * Checks the whole configuration as JellyPass would start with it and, if it starts, marks setup finished and
   * applies it: setup mode hands over to JellyPass, a running JellyPass restarts its services in place.
   */
  public finish(body: Body): Promise<Record<string, unknown>> {
    return this.#step(async () => {
      only(body, []);
      if (this.#applying) return { status: 'restarting' };
      const merged = this.#merged();
      const missing = missingRequired(merged);
      if (missing.length) throw new SetupError(409, 'setup_incomplete', `Still needed: ${missing.map(describeRequired).join(', ')}.`, { missing: missing.map(describeRequired) });
      try {
        // The setup token file stands in for ADMIN_TOKEN (index.ts reads it), so the check does not warn it is missing.
        loadConfig(this.#adminTokenSource === 'file' && !merged.ADMIN_TOKEN?.trim() ? { ...merged, ADMIN_TOKEN: 'setup-token-file' } : merged);
      } catch (error) {
        // loadConfig's messages name settings, never their values.
        throw new SetupError(409, 'configuration_invalid', (error as Error).message);
      }
      await this.#settings.update((settings) => ({ setupCompletedAt: settings.setupCompletedAt ?? new Date(this.#now()).toISOString() }));
      this.#applying = true;
      this.#log(this.#mode === 'setup' ? 'setup: finished; starting JellyPass' : 'setup: settings applied; restarting JellyPass services');
      // After the answer has gone out.
      setTimeout(this.#apply, 50).unref?.();
      return { status: 'restarting' };
    });
  }

  #merged(): Record<string, string | undefined> {
    return mergedEnvironment(this.#environment, this.#settings.current);
  }

  #effective(name: string, key: keyof StoredSettings): string | undefined {
    const environment = this.#environment[name]?.trim();
    if (environment) return environment;
    const stored = this.#settings.current?.[key];
    return typeof stored === 'string' ? stored : undefined;
  }

  async #ensureWebhookToken(): Promise<'environment' | 'kept' | 'generated'> {
    if (setInEnvironment(this.#environment, 'WEBHOOK_TOKEN')) return 'environment';
    if (this.#settings.current?.webhookToken) return 'kept';
    await this.#settings.update((settings) => ({ webhookToken: settings.webhookToken ?? generateSecret() }));
    this.#log('setup: webhook token generated');
    return 'generated';
  }

  #refuseLocked(...names: string[]): void {
    const locked = lockedBy(this.#environment, ...names);
    if (locked.length) {
      throw new SetupError(409, 'locked_by_environment', `${locked.join(' and ')} ${locked.length === 1 ? 'is' : 'are'} set in the environment, which wins over the wizard. Change ${locked.length === 1 ? 'it' : 'them'} there.`, { variables: locked });
    }
  }

  /** Runs one step at a time, so two never read and write the settings together. */
  #step<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#steps.then(run, run);
    this.#steps = next.catch(() => undefined);
    return next;
  }
}

function lockedBy(environment: Record<string, string | undefined>, ...names: string[]): string[] {
  return names.filter((name) => setInEnvironment(environment, name));
}

function describeRequired(name: string): string {
  return name === 'WEBHOOK_TOKEN' ? 'webhook token' : name === 'JELLYFIN_URL' ? 'Jellyfin address' : 'Jellyfin API key';
}

function booleanValue(value: string | undefined): boolean | undefined {
  const text = value?.trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return undefined;
}

function only(body: Body, keys: string[]): void {
  const extra = Object.keys(body).filter((key) => !keys.includes(key));
  if (extra.length) throw new SetupError(400, 'invalid_request', keys.length ? `body must contain only ${keys.join(', ')}` : 'body must be empty');
}

/** A service's base URL as given: http or https, no credentials, query or fragment; a path (a base URL) is kept. */
function serviceUrl(input: unknown, service: string, name = 'url'): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw new SetupError(400, 'url_invalid', `Enter ${service}'s address, such as http://${service.toLowerCase()}:${service === 'Seerr' ? 5055 : service === 'JellyPass' ? 8788 : 8096}.`, { field: name });
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SetupError(400, 'url_invalid', `${service}'s address must be a full URL starting with http:// or https://.`, { field: name });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SetupError(400, 'url_invalid', `${service}'s address must start with http:// or https://.`, { field: name });
  if (url.username || url.password || url.search || url.hash) throw new SetupError(400, 'url_invalid', `${service}'s address must not hold a user name, password, query or fragment.`, { field: name });
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function hostOf(value: string): string | null {
  return URL.parse(value)?.host || null;
}

interface CallResult {
  status: number;
  body: unknown;
}

/**
 * One call the wizard makes. Redirects are refused, so a key is never sent on to another address; errors name the
 * service and the HTTP status only, never what the service answered (which may echo what it was sent).
 */
async function call(service: string, url: string, init: RequestInit, { allowFailure = false } = {}): Promise<CallResult> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).name;
    throw new SetupError(502, `${service.toLowerCase()}_unreachable`, `Could not reach ${service} at ${new URL(url).origin} (${code}).`);
  }
  const text = await response.text().catch(() => '');
  if (response.status >= 300 && response.status < 400) {
    throw new SetupError(502, `${service.toLowerCase()}_redirected`, `${service} answered with a redirect. Enter the address it redirects to.`);
  }
  if (!response.ok && !allowFailure) {
    throw new SetupError(502, `${service.toLowerCase()}_failed`, `${service} answered ${response.status}.`, { serviceStatus: response.status });
  }
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  return { status: response.status, body };
}

function jellyfinAuthorization(deviceId: string, token?: string): string {
  const parameters = [['Client', 'JellyPass'], ['Device', 'Setup'], ['DeviceId', deviceId], ['Version', '4.0.0'], ...(token ? [['Token', token]] : [])];
  return `MediaBrowser ${parameters.map(([name, value]) => `${name}="${encodeURIComponent(value as string)}"`).join(', ')}`;
}

function jellyfinHeaders(deviceId: string, token?: string): Record<string, string> {
  return { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: jellyfinAuthorization(deviceId, token) };
}

async function jellyfinVersion(url: string): Promise<string | null> {
  const info = await call('Jellyfin', `${url}/System/Info/Public`, { headers: { Accept: 'application/json' } });
  const record = info.body as Record<string, unknown> | undefined;
  const version = record?.Version ?? record?.version;
  if (!record || (typeof record.Id !== 'string' && typeof record.id !== 'string' && typeof version !== 'string')) {
    throw new SetupError(502, 'jellyfin_not_found', `${url} does not answer as a Jellyfin server.`);
  }
  return typeof version === 'string' ? version : null;
}

async function jellyfinKeyWorks(url: string, apiKey: string): Promise<boolean> {
  const result = await call('Jellyfin', `${url}/System/Info`, { headers: jellyfinHeaders('jellypass-setup', apiKey) }, { allowFailure: true });
  return result.status === 200;
}

/**
 * Signs in as the administrator, creates a key named JellyPass (POST /Auth/Keys), finds it as the JellyPass key that
 * was not there before, checks it reads users, and signs the session out (whatever happened).
 */
async function createJellyfinKey(url: string, username: string, password: string): Promise<string> {
  const deviceId = `jellypass-setup-${randomUUID()}`;
  const signIn = await call('Jellyfin', `${url}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: jellyfinHeaders(deviceId),
    body: JSON.stringify({ Username: username, Pw: password }),
  }, { allowFailure: true });
  if (signIn.status === 401 || signIn.status === 403) throw new SetupError(400, 'jellyfin_sign_in_refused', 'Jellyfin did not accept that name and password.');
  const session = signIn.body as { AccessToken?: unknown; User?: { Id?: unknown } } | undefined;
  if (signIn.status !== 200 || typeof session?.AccessToken !== 'string' || typeof session.User?.Id !== 'string') {
    throw new SetupError(502, 'jellyfin_failed', `Jellyfin answered the sign-in with ${signIn.status}.`);
  }
  const token = session.AccessToken;
  try {
    const user = await call('Jellyfin', `${url}/Users/${encodeURIComponent(session.User.Id)}`, { headers: jellyfinHeaders(deviceId, token) });
    const policy = (user.body as { Policy?: { IsAdministrator?: unknown; IsDisabled?: unknown } } | undefined)?.Policy;
    if (policy?.IsAdministrator !== true || policy.IsDisabled === true) {
      throw new SetupError(403, 'jellyfin_not_administrator', 'That Jellyfin user is not an enabled administrator.');
    }
    const keys = async () => {
      const listed = await call('Jellyfin', `${url}/Auth/Keys`, { headers: jellyfinHeaders(deviceId, token) });
      const items = (listed.body as { Items?: unknown } | undefined)?.Items;
      return Array.isArray(items) ? items as Array<{ AccessToken?: unknown; AppName?: unknown; DateCreated?: unknown }> : [];
    };
    const before = new Set((await keys()).map((key) => key.AccessToken));
    await call('Jellyfin', `${url}/Auth/Keys?app=${encodeURIComponent(JELLYFIN_KEY_NAME)}`, { method: 'POST', headers: jellyfinHeaders(deviceId, token) });
    const created = (await keys())
      .filter((key) => key.AppName === JELLYFIN_KEY_NAME && typeof key.AccessToken === 'string' && !before.has(key.AccessToken))
      .sort((left, right) => String(right.DateCreated ?? '').localeCompare(String(left.DateCreated ?? '')))[0];
    if (!created) throw new SetupError(502, 'jellyfin_key_missing', 'Jellyfin did not list the API key it created.');
    const apiKey = created.AccessToken as string;
    const check = await call('Jellyfin', `${url}/Users`, { headers: jellyfinHeaders('jellypass-setup', apiKey) }, { allowFailure: true });
    if (check.status !== 200) throw new SetupError(502, 'jellyfin_key_refused', 'Jellyfin refused the API key it created.');
    return apiKey;
  } finally {
    await call('Jellyfin', `${url}/Sessions/Logout`, { method: 'POST', headers: jellyfinHeaders(deviceId, token) }, { allowFailure: true }).catch(() => undefined);
  }
}

async function seerrVersion(url: string): Promise<string | null> {
  const status = await call('Seerr', `${url}/api/v1/status`, { headers: { Accept: 'application/json' } });
  const version = (status.body as { version?: unknown } | undefined)?.version;
  if (typeof version !== 'string') throw new SetupError(502, 'seerr_not_found', `${url} does not answer as Seerr.`);
  return version;
}

async function seerrCall(url: string, apiKey: string, pathname: string, method: string, body?: unknown, options?: { allowFailure?: boolean }): Promise<CallResult> {
  const result = await call('Seerr', `${url}${pathname}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { allowFailure: true });
  if (result.status === 401 || result.status === 403) throw new SetupError(400, 'seerr_key_refused', 'Seerr refused that API key. Use the key from Seerr\'s Settings → General.');
  if (!options?.allowFailure && (result.status < 200 || result.status >= 300)) {
    throw new SetupError(502, 'seerr_failed', `Seerr answered ${result.status}.`, { serviceStatus: result.status });
  }
  return result;
}

/** Seerr's webhook settings; reading them needs an administrator's key, so this also checks the key. */
async function seerrWebhookSettings(url: string, apiKey: string): Promise<{ enabled?: unknown; options?: { webhookUrl?: unknown; customHeaders?: unknown } }> {
  const result = await seerrCall(url, apiKey, '/api/v1/settings/notifications/webhook', 'GET');
  const body = result.body;
  if (!body || typeof body !== 'object') throw new SetupError(502, 'seerr_not_found', `${url} does not answer as Seerr.`);
  return body as { enabled?: unknown; options?: { webhookUrl?: unknown; customHeaders?: unknown } };
}
