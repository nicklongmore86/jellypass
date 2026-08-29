import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../dist/access-service.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import { makeServer } from '../dist/server.js';
import { GrantStore } from '../dist/store.js';
import { createFakeJellyfin } from './support/fake-jellyfin.mjs';

describe('HTTP integration', { timeout: 5_000 }, () => {
  let jellyfin;
  let bridge;
  let bridgeUrl;

  before(async () => {
    jellyfin = await createFakeJellyfin();
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'jfa-http-test-')), 'grants.json');
    const store = new GrantStore(file);
    await store.load();
    const service = new AccessService(new JellyfinClient(jellyfin.url, 'test-key'), store);
    bridge = makeServer(service, { webhook: 'webhook-secret', admin: 'admin-secret' });
    await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const address = bridge.address();
    bridgeUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    bridge.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => bridge.close(resolve)),
      jellyfin.close(),
    ]);
  });

  it('processes a webhook through both HTTP services', async () => {
    const unauthorized = await fetch(`${bridgeUrl}/webhooks/seerr`, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
    await unauthorized.json();

    const response = await fetch(`${bridgeUrl}/webhooks/seerr`, {
      method: 'POST',
      headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notificationType: 'MEDIA_AVAILABLE',
        media: { jellyfinMediaId: 'item-1', mediaType: 'movie' },
        request: { id: '17', requestedBy: { jellyfinUserId: 'alice-id' } },
      }),
    });
    assert.equal(response.status, 200);
    await response.json();
    assert.deepEqual(jellyfin.item.Tags, ['existing', 'jfa:private:item-1']);
    assert.deepEqual(jellyfin.user('bob-id').Policy.BlockedTags, ['jfa:private:item-1']);

    const metrics = await fetch(`${bridgeUrl}/metrics`, { headers: { Authorization: 'Bearer admin-secret' } });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /jfa_webhooks_total\{result="granted"\} 1/);

    const plan = await fetch(`${bridgeUrl}/v1/grants/item-1/plan`, { headers: { Authorization: 'Bearer admin-secret' } });
    assert.equal(plan.status, 200);
    assert.equal((await plan.json()).plan.item.action, 'none');

    const revoke = await fetch(`${bridgeUrl}/v1/grants/item-1/requests/17`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin-secret' },
    });
    assert.equal(revoke.status, 200);
    await revoke.json();
    assert.deepEqual(jellyfin.item.Tags, ['existing']);
    assert.deepEqual(jellyfin.user('bob-id').Policy.BlockedTags, []);
  });
});
