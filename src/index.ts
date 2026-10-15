import { AccessService } from './access-service.js';
import { WebAuth } from './auth.js';
import { loadConfig } from './config.js';
import { JellyfinClient } from './jellyfin.js';
import { makeServer } from './server.js';
import { RequestBridge } from './request-bridge.js';
import { SeerrClient } from './seerr.js';
import { GrantStore } from './store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new GrantStore(config.stateFile);
  await store.load();

  const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey);
  const seerr = config.seerrUrl && config.seerrApiKey
    ? new SeerrClient(config.seerrUrl, config.seerrApiKey)
    : undefined;
  const service = new AccessService(jellyfin, store, undefined, seerr, { logLevel: config.logLevel });
  const webAuth = new WebAuth(jellyfin);
  const server = makeServer(service, { webhook: config.webhookToken, admin: config.adminToken }, webAuth, {
    ...(config.jellyquestBridgeEnabled && config.seerrUrl ? {
      requestBridge: new RequestBridge(config.seerrUrl, config.jellyfinUrl, service),
    } : {}),
    ...(config.householdDomain ? {
      householdGateway: {
        jellyfinUrl: config.jellyfinUrl,
        domain: config.householdDomain,
        hostPrefix: config.householdHostPrefix,
        webSocketIdleTimeoutMs: config.webSocketIdleTimeoutMs,
        webSocketUpstreamIdleTimeoutMs: config.webSocketUpstreamIdleTimeoutMs,
        logLevel: config.logLevel,
      },
    } : {}),
  });
  const backfillSince = config.requestBackfillEnabled ? config.requestBackfillSince : undefined;
  const backfillRequests = async () => {
    if (!backfillSince) return;
    try {
      const result = await service.backfillRequests(backfillSince);
      if (result.granted.length > 0 || result.failed > 0) {
        console.log(JSON.stringify({ level: 'info', message: 'request backfill finished', ...result }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'request backfill failed',
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  };
  const reconcileTimer = config.reconcileIntervalSeconds > 0
    ? setInterval(() => {
        void backfillRequests().then(() => service.reconcileAll({ dueOnly: true })).catch((error: unknown) => {
          console.error(JSON.stringify({
            level: 'error',
            message: 'scheduled reconciliation failed',
            detail: error instanceof Error ? error.message : String(error),
          }));
        });
      }, config.reconcileIntervalSeconds * 1000)
    : undefined;
  reconcileTimer?.unref();
  const syncCatalog = () => service.syncLibraryCatalog().catch((error: unknown) => {
    console.error(JSON.stringify({
      level: 'error',
      message: 'library catalog sync failed',
      detail: error instanceof Error ? error.message : String(error),
    }));
  });
  const catalogSyncTimer = config.catalogSyncIntervalSeconds > 0
    ? setInterval(syncCatalog, config.catalogSyncIntervalSeconds * 1000)
    : undefined;
  catalogSyncTimer?.unref();
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      level: 'info',
      message: 'server started',
      host: config.host,
      port: config.port,
      reconcileIntervalSeconds: config.reconcileIntervalSeconds,
      catalogSyncIntervalSeconds: config.catalogSyncIntervalSeconds,
      requestBackfillSince: backfillSince?.toISOString() ?? null,
    }));
    if (service.getLibraryCatalog().items.length === 0) void syncCatalog();
    // Catch up on missed webhooks now rather than one reconcile interval after startup.
    if (backfillSince) setTimeout(() => void backfillRequests(), 5_000).unref();
  });

  const shutdown = () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (catalogSyncTimer) clearInterval(catalogSyncTimer);
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
