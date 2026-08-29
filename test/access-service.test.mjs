import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accessTag, sameStringSet } from '../dist/access-service.js';
import { parseWebhook } from '../dist/webhook.js';

describe('access tags', () => {
  it('uses stable lowercase item tags', () => {
    assert.equal(accessTag('ABC-123'), 'jfa:private:abc-123');
  });

  it('compares tag sets without case or order sensitivity', () => {
    assert.equal(sameStringSet(['Family', 'Private'], ['private', 'family']), true);
    assert.equal(sameStringSet(['Family'], ['Family', 'Private']), false);
  });
});

describe('webhook validation', () => {
  it('parses an available media event', () => {
    const event = parseWebhook({
      notificationType: 'MEDIA_AVAILABLE',
      media: { jellyfinMediaId: 'abc123', mediaType: 'movie' },
      request: {
        id: '42',
        requestedBy: { jellyfinUserId: 'user-123', username: 'Sam' },
      },
    });
    assert.equal(event.request.requestedBy.jellyfinUserId, 'user-123');
  });

  it('rejects an unresolved template variable', () => {
    assert.throws(
      () =>
        parseWebhook({
          notificationType: 'MEDIA_AVAILABLE',
          media: { jellyfinMediaId: '{{media_jellyfinMediaId}}' },
          request: { id: '42', requestedBy: { jellyfinUserId: 'user-123' } },
        }),
      /invalid/,
    );
  });
});

describe('access reconciliation', () => {
  it('preserves tags and blocks non-owners without restricting admins', async () => {
    const policyUpdates = [];
    let itemUpdate;
    const grant = {
      itemId: 'item-1',
      mediaType: 'movie',
      owners: ['alice-id'],
      requests: { '17': 'alice-id' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const jellyfin = {
      async getItem() {
        return { Id: 'item-1', Name: 'Movie', Tags: ['keep-me'] };
      },
      async getUsers() {
        return [
          { Id: 'alice-id', Name: 'Alice', Policy: { BlockedTags: ['other'] } },
          { Id: 'bob-id', Name: 'Bob', Policy: { BlockedTags: ['other'] } },
          { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
        ];
      },
      async updateItem(item) {
        itemUpdate = item;
      },
      async updatePolicy(userId, policy) {
        policyUpdates.push([userId, policy]);
      },
    };
    const store = {
      list: () => [grant],
      async grant() {
        return grant;
      },
    };

    const { AccessService } = await import('../dist/access-service.js');
    const service = new AccessService(jellyfin, store);
    await service.reconcileGrant(grant);

    assert.deepEqual(itemUpdate.Tags, ['keep-me', 'jfa:private:item-1']);
    assert.equal(policyUpdates.length, 1);
    assert.equal(policyUpdates[0][0], 'bob-id');
    assert.deepEqual(policyUpdates[0][1].BlockedTags, ['other', 'jfa:private:item-1']);
  });
});
