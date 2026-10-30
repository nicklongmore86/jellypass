import { SelfCheck, versionCheckResult } from './self-check.js';
import { AccessService } from './access-service.js';
import { AdminRequests } from './admin-requests.js';
import { WebAuth } from './auth.js';
import { loadConfig } from './config.js';
import { JellyfinClient } from './jellyfin.js';
import { JellyfinVersionGate } from './jellyfin-version.js';
import { makeServer } from './server.js';
import { SeerrClient } from './seerr.js';
import { SeerrUserMap } from './seerr-users.js';
import { HouseholdRequests } from './household-requests.js';
import { BackgroundTasks, createShutdown } from './shutdown.js';
import { GrantStore } from './store.js';
import { TmdbClient, TmdbError } from './tmdb.js';

async function main(): Promise<void> {
  const config = loadConfig();
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
  const server = makeServer(service, { webhook: config.webhookToken, admin: config.adminToken }, webAuth, {
    selfCheck: new SelfCheck({
      versionStatus: () => versionCheckResult(jellyfinVersion.status()),
      jellyfinUrl: config.jellyfinUrl,
      jellyfinPublicUrls: config.jellyfinPublicUrls,
      ...(config.seerrPublicUrl ? { seerrPublicUrl: config.seerrPublicUrl } : {}),
      ...(config.tmdbApiKey ? { tmdbApiKey: config.tmdbApiKey } : {}),
      trustedProxies: config.trustedProxies,
      householdUrls: () => config.householdDomain ? service.listGroups().map((group) => `https://${config.householdHostPrefix}${group.id}.${config.householdDomain}`) : [],
    }),
    trustedProxies: config.trustedProxies,
    background,
    jellyfinVersion,
    ...(config.householdDomain ? {
      householdGateway: {
        additionalPluginRoutes: config.additionalPluginRoutes,
        jellyfinUrl: config.jellyfinUrl,
        domain: config.householdDomain,
        hostPrefix: config.householdHostPrefix,
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
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      level: 'info',
      message: 'server started',
      host: config.host,
      port: config.port,
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
  });

  const shutdown = createShutdown({
    servers: [server],
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
  });
  // `on`, not `once`: a second signal must reach the idempotent handler rather than Node's default, which kills at once.
  process.on('SIGINT', (signal) => void shutdown(signal));
  process.on('SIGTERM', (signal) => void shutdown(signal));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
