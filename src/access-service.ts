import type { JellyfinClient } from './jellyfin.js';
import { normalizeId, type GrantStore } from './store.js';
import type { GrantRecord, JellyfinUser, SeerrWebhook } from './types.js';

export const TAG_PREFIX = 'jfa:private:';

export class AccessService {
  readonly #jellyfin: JellyfinClient;
  readonly #store: GrantStore;

  public constructor(jellyfin: JellyfinClient, store: GrantStore) {
    this.#jellyfin = jellyfin;
    this.#store = store;
  }

  public listGrants(): GrantRecord[] {
    return this.#store.list();
  }

  public async processWebhook(event: SeerrWebhook): Promise<GrantRecord | null> {
    if (event.notificationType !== 'MEDIA_AVAILABLE') {
      return null;
    }

    const grant = await this.#store.grant({
      itemId: event.media.jellyfinMediaId,
      requestId: event.request.id,
      userId: event.request.requestedBy.jellyfinUserId,
      ...(event.media.mediaType ? { mediaType: event.media.mediaType } : {}),
    });
    await this.reconcileGrant(grant);
    return grant;
  }

  public async reconcileAll(): Promise<void> {
    for (const grant of this.#store.list()) {
      await this.reconcileGrant(grant);
    }
  }

  public async reconcileGrant(grant: GrantRecord): Promise<void> {
    const [item, users] = await Promise.all([
      this.#jellyfin.getItem(grant.itemId),
      this.#jellyfin.getUsers(),
    ]);

    const knownUserIds = new Set(users.map((user) => normalizeId(user.Id)));
    const missingOwners = grant.owners.filter((owner) => !knownUserIds.has(normalizeId(owner)));
    if (missingOwners.length > 0) {
      throw new Error(`Jellyfin user not found: ${missingOwners.join(', ')}`);
    }

    const tag = accessTag(grant.itemId);
    const tags = uniqueCaseInsensitive([...(item.Tags ?? []), tag]);
    if (!sameStringSet(tags, item.Tags ?? [])) {
      await this.#jellyfin.updateItem({ ...item, Tags: tags });
    }

    await Promise.all(users.map((user) => this.#reconcileUser(user, grant, tag)));
  }

  async #reconcileUser(user: JellyfinUser, grant: GrantRecord, tag: string): Promise<void> {
    const blocked = user.Policy.BlockedTags ?? [];
    const ownsItem = grant.owners.some((owner) => normalizeId(owner) === normalizeId(user.Id));
    const shouldBlock = !user.Policy.IsAdministrator && !ownsItem;
    const withoutTag = blocked.filter((entry) => entry.toLowerCase() !== tag.toLowerCase());
    const next = shouldBlock ? [...withoutTag, tag] : withoutTag;

    if (!sameStringSet(blocked, next)) {
      await this.#jellyfin.updatePolicy(user.Id, { ...user.Policy, BlockedTags: next });
    }
  }
}

export function accessTag(itemId: string): string {
  return `${TAG_PREFIX}${normalizeId(itemId)}`;
}

export function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalized = new Set(left.map((value) => value.toLowerCase()));
  return right.every((value) => normalized.has(value.toLowerCase()));
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
