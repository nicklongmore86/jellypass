import { SelfCheck, versionCheckResult } from './self-check.js';
import { AccessService } from './access-service.js';
import { AdminRequests } from './admin-requests.js';
import { WebAuth } from './auth.js';
import { loadConfig, type Config } from './config.js';
import { JellyfinClient } from './jellyfin.js';
import { JellyfinVersionGate } from './jellyfin-version.js';
import { makeServers, makeSetupServer } from './server.js';
import { SeerrClient } from './seerr.js';
import { SeerrUserMap } from './seerr-users.js';
import { HouseholdAddresses } from './household-addresses.js';
import { HouseholdRequests } from './household-requests.js';
import { BackgroundTasks, createShutdown } from './shutdown.js';
import { mergedEnvironment, missingRequired, readAdminTokenFile, setInEnvironment, settingsPaths, SettingsStore, setupRequired } from './settings.js';
import { SetupWizard } from './setup.js';
import { GrantStore } from './store.js';
import { TmdbClient, TmdbError } from './tmdb.js';

/** What stops the current phase (setup mode, or JellyPass running) on SIGINT or SIGTERM, and exits. */
let stopCurrent: ((signal: string) => Promise<void>) | undefined;
let stopping = false;

/**
 * Starts in setup mode while the required settings (Jellyfin's address and API key, the webhook token) are in neither
 * the environment nor the settings file, or come partly from the wizard and it has not been finished (setupRequired),
 * and otherwise as configured. Finishing the setup wizard, or applying its
 * changes later, stops what runs and starts it again with the new settings, in this process.
 */
async function main(): Promise<void> {
  // `on`, not `once`: a second signal must reach the idempotent handler rather than Node's default, which kills at once.
  const onSignal = (signal: string) => {
    stopping = true;
    if (stopCurrent) void stopCurrent(signal);
    else process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const environment = { ...process.env };
  const paths = settingsPaths(environment);
  for (;;) {
    const settings = await SettingsStore.load(paths.settingsFile);
    // An install the wizard configured (the environment alone lacks a required setting) keeps its admin token in the
    // setup token file, made again if it was deleted to rotate the token. One whose environment has every required
    // setting never gets the file, so its admin token stays what it was.
    const wizardInstall = settings.current !== undefined && missingRequired(environment).length > 0;
    const fileToken = setInEnvironment(environment, 'ADMIN_TOKEN') ? undefined : await readAdminTokenFile(paths.adminTokenFile, { create: wizardInstall });
    const merged = mergedEnvironment(environment, settings.current, fileToken);
    if (setupRequired(environment, settings.current, merged)) {
      await runSetup(environment, settings, paths.adminTokenFile, missingRequired(merged));
    } else {
      const adminTokenSource = setInEnvironment(environment, 'ADMIN_TOKEN') ? 'environment' : fileToken ? 'file' : 'webhook_token';
      await run(loadConfig(merged), (apply) => new SetupWizard({ settings, environment, mode: 'running', adminTokenSource, apply }));
    }
    // Between phases a signal exits at once (see onSignal).
    stopCurrent = undefined;
    if (stopping) return;
  }
}

/** Setup mode: the admin listener serves the setup wizard only, until it finishes. */
async function runSetup(environment: Record<string, string | undefined>, settings: SettingsStore, adminTokenFile: string, missing: string[]): Promise<void> {
  const adminToken = environment.ADMIN_TOKEN?.trim() || await readAdminTokenFile(adminTokenFile, { create: true }) as string;
  const adminHost = environment.ADMIN_HOST?.trim() || '127.0.0.1';
  const adminPort = Number.parseInt(environment.ADMIN_PORT ?? '8788', 10);
  if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535) throw new Error('ADMIN_PORT must be an integer between 1 and 65535');
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const wizard = new SetupWizard({
    settings,
    environment,
    mode: 'setup',
    adminTokenSource: setInEnvironment(environment, 'ADMIN_TOKEN') ? 'environment' : 'file',
    apply: () => void close().then(finished),
  });
  const server = makeSetupServer({ setup: wizard, adminToken });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  stopCurrent = async () => { await close(); process.exit(0); };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(adminPort, adminHost, () => { server.off('error', reject); resolve(); });
  });
  console.warn(JSON.stringify({
    level: 'warn',
    message: missing.length
      ? 'JellyPass is not configured yet: open the admin site on the admin listener and follow the setup wizard'
      : 'JellyPass setup is not finished yet: open the setup wizard on the admin listener and finish it',
    admin: { host: adminHost, port: adminPort, path: '/admin/setup/' },
    missing,
    // Where the token is, never the token.
    adminToken: setInEnvironment(environment, 'ADMIN_TOKEN') ? 'ADMIN_TOKEN' : adminTokenFile,
  }));
  await done;
}

async function run(config: Config, setupWizard: (apply: () => void) => SetupWizard): Promise<void> {
  let restart!: () => void;
  const restarted = new Promise<void>((resolve) => { restart = resolve; });
  let restarting = false;
  const setup = setupWizard(() => {
    restarting = true;
    void shutdown('settings applied');
  });
  const store = new GrantStore(config.stateFile, { limitHouseholds: config.householdAppEnabled });
  await store.load();

  const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey);
  const seerr = config.seerrUrl && config.seerrApiKey
    ? new SeerrClient(config.seerrUrl, config.seerrApiKey)
    : undefined;
  let catalogue: TmdbClient | undefined;
  if (config.householdAppEnabled && config.tmdbApiKey) {
    catalogue = new TmdbClient(config.tmdbApiKey);
    // Checked now so a key TMDB refuses stops startup; an unreachable TMDB is only logged (the app answers
    // `unavailable` until it is back). The message names the route and status, never the key.
    try {
      await catalogue.validate();
    } catch (error) {
      if (error instanceof TmdbError && (error.status === 401 || error.status === 403)) {
        throw new Error(`TMDB_API_KEY was refused by TMDB (${error.message})`);
      }
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'could not check TMDB_API_KEY at startup; the household app answers unavailable until TMDB answers',
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  if (config.additionalPluginRoutes.length) console.warn(JSON.stringify({ level: 'warn', message: 'HOUSEHOLD_PLUGIN_ROUTES adds household relay routes; audit member privacy', templates: config.additionalPluginRoutes }));
  const service = new AccessService(jellyfin, store, undefined, seerr, { logLevel: config.logLevel });
  // Read now and on a slow interval; startup never waits for it (see JellyfinVersionGate).
  const jellyfinVersion = new JellyfinVersionGate({
    read: () => jellyfin.getServerVersion(),
    ...(config.jellyfinUntestedVersionOk ? { environmentConfirmed: config.jellyfinUntestedVersionOk } : {}),
    confirmation: { get: () => store.getJellyfinVersionConfirmed(), set: (version) => store.setJellyfinVersionConfirmed(version) },
  });
  void jellyfinVersion.check();
  const webAuth = new WebAuth(jellyfin);
  // Shutdown aborts this signal: each job stops before its next step and failures from the abort are not logged.
  const background = new BackgroundTasks();
  const members = seerr ? new SeerrUserMap(seerr) : undefined;
  // "Get this": its branches run as background work, and its records are brought up to date with each reconciliation.
  const requests = config.householdAppEnabled && seerr && members ? new HouseholdRequests({
    store,
    jellyfin,
    seerr,
    members,
    joins: service,
    background,
    record: (result) => service.recordGetThis(result),
    recordBranch: (branch) => service.recordGetThisBranch(branch),
  }) : undefined;
  // Throws on an address map that conflicts with itself or with the legacy rule, so such a configuration never starts.
  const servers = makeServers(service, { webhook: config.webhookToken, admin: config.adminToken }, webAuth, {
    setup,
    selfCheck: new SelfCheck({
      versionStatus: () => versionCheckResult(jellyfinVersion.status()),
      jellyfinUrl: config.jellyfinUrl,
      jellyfinPublicUrls: config.jellyfinPublicUrls,
      ...(config.seerrPublicUrl ? { seerrPublicUrl: config.seerrPublicUrl } : {}),
      ...(config.tmdbApiKey ? { tmdbApiKey: config.tmdbApiKey } : {}),
      trustedProxies: config.trustedProxies,
      // Each household's canonical address, mapped or legacy, as GET /v1/groups gives it.
      householdUrls: () => {
        if (!config.householdGatewayEnabled) return [];
        const book = new HouseholdAddresses(service.getHouseholdAddresses(), config.householdDomain ? { domain: config.householdDomain, prefix: config.householdHostPrefix } : undefined);
        return service.listGroups().flatMap((group) => book.householdUrl(group.id) ?? []);
      },
    }),
    trustedProxies: config.trustedProxies,
    background,
    jellyfinVersion,
    ...(config.legacyWebhookOnMemberPort ? { memberWebhook: true } : {}),
    ...(config.householdGatewayEnabled ? {
      householdGateway: {
        additionalPluginRoutes: config.additionalPluginRoutes,
        jellyfinUrl: config.jellyfinUrl,
        ...(config.householdDomain ? { domain: config.householdDomain, hostPrefix: config.householdHostPrefix } : {}),
        webSocketIdleTimeoutMs: config.webSocketIdleTimeoutMs,
        webSocketUpstreamIdleTimeoutMs: config.webSocketUpstreamIdleTimeoutMs,
        logLevel: config.logLevel,
        ...(config.tvAddonHouseholds ? { tvAddon: { households: config.tvAddonHouseholds } } : {}),
      },
    } : {}),
    ...(config.householdAppEnabled && seerr && members && catalogue ? {
      householdApp: { catalogue, blocklist: seerr, members, ...(requests ? { requests } : {}) },
    } : {}),
    ...(requests && seerr ? {
      titleHolds: requests,
      adminRequests: new AdminRequests({ store, seerr, jellyfin, service, requests }),
    } : {}),
  });
  const backfillSince = config.requestBackfillEnabled ? config.requestBackfillSince : undefined;
  const backfillRequests = async (signal: AbortSignal) => {
    if (!backfillSince) return;
    try {
      const result = await service.backfillRequests(backfillSince, { signal });
      if (signal.aborted) return;
      if (result.granted.length > 0 || result.failed > 0) {
        console.log(JSON.stringify({ level: 'info', message: 'request backfill finished', ...result }));
      }
    } catch (error) {
      if (signal.aborted) return;
      console.error(JSON.stringify({
        level: 'error',
        message: 'request backfill failed',
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  };
  const reconcileTimer = config.reconcileIntervalSeconds > 0
    ? setInterval(() => background.run(async (signal) => {
        await backfillRequests(signal);
        if (signal.aborted) return;
        await requests?.refresh({ signal });
        if (signal.aborted) return;
        await service.reconcileAll({ dueOnly: true, signal }).catch((error: unknown) => {
          if (signal.aborted) return;
          console.error(JSON.stringify({
            level: 'error',
            message: 'scheduled reconciliation failed',
            detail: error instanceof Error ? error.message : String(error),
          }));
        });
      }), config.reconcileIntervalSeconds * 1000)
    : undefined;
  reconcileTimer?.unref();
  const syncCatalog = () => background.run(async (signal) => {
    await service.syncLibraryCatalog({ signal }).catch((error: unknown) => {
      if (signal.aborted) return;
      console.error(JSON.stringify({
        level: 'error',
        message: 'library catalog sync failed',
        detail: error instanceof Error ? error.message : String(error),
      }));
    });
    // New items: a cancelled request Seerr lost since the last reconciliation is found now, and its title held.
    if (!signal.aborted) await requests?.checkTitleHolds({ signal });
  });
  const catalogSyncTimer = config.catalogSyncIntervalSeconds > 0
    ? setInterval(syncCatalog, config.catalogSyncIntervalSeconds * 1000)
    : undefined;
  catalogSyncTimer?.unref();
  let backfillTimer: NodeJS.Timeout | undefined;
  if (config.legacyWebhookOnMemberPort) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: servers.member
        ? 'LEGACY_WEBHOOK_ON_MEMBER_PORT is on: the member listener also answers POST /webhooks/seerr; point Seerr at the admin listener and turn it off'
        : 'LEGACY_WEBHOOK_ON_MEMBER_PORT is ignored: there is no member listener while the household gateway is off',
    }));
  }
  // Started once every listener is up; a listener that cannot bind stops startup.
  let starting = servers.member ? 2 : 1;
  const started = () => {
    if (--starting > 0) return;
    console.log(JSON.stringify({
      level: 'info',
      message: 'server started',
      admin: { host: config.adminHost, port: config.adminPort },
      member: servers.member ? { host: config.host, port: config.port } : null,
      reconcileIntervalSeconds: config.reconcileIntervalSeconds,
      catalogSyncIntervalSeconds: config.catalogSyncIntervalSeconds,
      requestBackfillSince: backfillSince?.toISOString() ?? null,
      householdApp: config.householdAppEnabled,
      tvAddon: config.tvAddonHouseholds === 'all' ? 'all' : config.tvAddonHouseholds?.length ?? 0,
    }));
    if (service.getLibraryCatalog().items.length === 0) syncCatalog();
    // Catch up on missed webhooks now rather than one reconcile interval after startup.
    if (backfillSince) backfillTimer = setTimeout(() => background.run(backfillRequests), 5_000).unref();
    // Requests "Get this" was making when JellyPass last stopped are reconciled now (see AppRequestIntent).
    if (requests) background.run((signal) => requests.refresh({ signal }));
  };
  servers.admin.listen(config.adminPort, config.adminHost, started);
  servers.member?.listen(config.port, config.host, started);

  const shutdown = createShutdown({
    servers: servers.member ? [servers.member, servers.admin] : [servers.admin],
    closeStore: async () => {
      await seerr?.close();
      await store.close();
    },
    timers: () => {
      // No version read is scheduled after shutdown starts.
      jellyfinVersion.stop();
      return [reconcileTimer, catalogSyncTimer, backfillTimer];
    },
    background,
    // Applying the wizard's settings ends here instead of exiting; main starts JellyPass again with them.
    exit: (code) => {
      if (restarting && code === 0 && !stopping) restart();
      else process.exit(code);
    },
  });
  stopCurrent = shutdown;
  await restarted;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
