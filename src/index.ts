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
  const server = makeServer(service, config.webhookToken);
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ level: 'info', message: 'server started', host: config.host, port: config.port }));
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
