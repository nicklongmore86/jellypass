import { AccessService } from './access-service.js';
import { loadConfig } from './config.js';
import { JellyfinClient } from './jellyfin.js';
import { makeServer } from './server.js';
import { GrantStore } from './store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new GrantStore(config.stateFile);
  await store.load();

  const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey);
  const service = new AccessService(jellyfin, store);
  const server = makeServer(service, { webhook: config.webhookToken, admin: config.adminToken });
  const reconcileTimer = config.reconcileIntervalSeconds > 0
    ? setInterval(() => {
        service.reconcileAll({ dueOnly: true }).catch((error: unknown) => {
          console.error(JSON.stringify({
            level: 'error',
            message: 'scheduled reconciliation failed',
            detail: error instanceof Error ? error.message : String(error),
          }));
        });
      }, config.reconcileIntervalSeconds * 1000)
    : undefined;
  reconcileTimer?.unref();
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      level: 'info',
      message: 'server started',
      host: config.host,
      port: config.port,
      reconcileIntervalSeconds: config.reconcileIntervalSeconds,
    }));
  });

  const shutdown = () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
