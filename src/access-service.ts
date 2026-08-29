import type { JellyfinClient } from './jellyfin.js';
import { Metrics } from './metrics.js';
import { normalizeId, type GrantStore } from './store.js';
import type {
  AccessGroup,
  ChangePlan,
  GrantRecord,
  JellyfinItem,
  JellyfinUser,
  RevokeResult,
  SeerrWebhook,
} from './types.js';

export const TAG_PREFIX = 'jfa:private:';

interface PlanContext {
  plan: ChangePlan;
  item: JellyfinItem;
  users: JellyfinUser[];
}

export class AccessService {
  readonly #jellyfin: JellyfinClient;
  readonly #store: GrantStore;
  readonly #metrics: Metrics;
  #queue: Promise<void> = Promise.resolve();

  public constructor(jellyfin: JellyfinClient, store: GrantStore, metrics = new Metrics()) {
    this.#jellyfin = jellyfin;
    this.#store = store;
    this.#metrics = metrics;
    this.#refreshGauges();
  }

  public listGrants(): GrantRecord[] {
    return this.#store.list();
  }

  public listGroups(): AccessGroup[] {
    return this.#store.listGroups();
  }

  public renderMetrics(): string {
    this.#refreshGauges();
    return this.#metrics.render();
  }

  public processWebhook(event: SeerrWebhook): Promise<GrantRecord | null> {
    return this.#exclusive(async () => {
      if (event.notificationType !== 'MEDIA_AVAILABLE') {
        this.#metrics.increment('jfa_webhooks_total', { result: 'ignored' });
        return null;
      }
      const grant = await this.#store.grant({
        itemId: event.media.jellyfinMediaId,
        requestId: event.request.id,
        userId: event.request.requestedBy.jellyfinUserId,
        ...(event.media.mediaType ? { mediaType: event.media.mediaType } : {}),
      });
      try {
        await this.#reconcileGrant(grant);
        this.#metrics.increment('jfa_webhooks_total', { result: 'granted' });
      } catch (error) {
        this.#metrics.increment('jfa_webhooks_total', { result: 'error' });
        throw error;
      }
      return this.#store.get(grant.itemId) ?? grant;
    });
  }

  public reconcileAll(options: { dryRun?: boolean; dueOnly?: boolean } = {}): Promise<ChangePlan[]> {
    return this.#exclusive(async () => {
      const plans: ChangePlan[] = [];
      const errors: Error[] = [];
      for (const grant of this.#store.list()) {
        if (options.dueOnly && !isDue(grant)) continue;
        try {
          if (options.dryRun) plans.push((await this.#buildPlan(grant)).plan);
          else {
            const plan = await this.#reconcileGrant(grant);
            plans.push(plan);
          }
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `${errors.length} grant reconciliation(s) failed`);
      }
      return plans;
    });
  }

  public planGrant(itemId: string): Promise<ChangePlan> {
    return this.#exclusive(async () => {
      const grant = this.#store.get(itemId);
      if (!grant) throw new Error(`grant not found: ${normalizeId(itemId)}`);
      return (await this.#buildPlan(grant)).plan;
    });
  }

  public revokeRequest(itemId: string, requestId: string, dryRun = false): Promise<RevokeResult & { plan: ChangePlan }> {
    return this.#exclusive(async () => {
      const existing = this.#store.get(itemId);
      if (!existing || !(requestId in existing.requests)) throw new Error('request grant not found');
      if (dryRun) {
        const hypothetical = hypotheticalRevocation(existing, requestId, this.#store);
        return { previous: existing, current: hypothetical, plan: (await this.#buildPlan(hypothetical)).plan };
      }
      const result = await this.#store.revokeRequest(itemId, requestId);
      if (!result) throw new Error('request grant not found');
      const plan = await this.#reconcileGrant(result.current);
      return { ...result, plan };
    });
  }

  public setGrantGroups(itemId: string, groupIds: string[], dryRun = false): Promise<RevokeResult & { plan: ChangePlan }> {
    return this.#exclusive(async () => {
      if (dryRun) {
        const existing = this.#store.get(itemId);
        if (!existing) throw new Error(`grant not found: ${normalizeId(itemId)}`);
        const missing = groupIds.filter((id) => !this.#store.getGroup(id));
        if (missing.length > 0) throw new Error(`group not found: ${missing.join(', ')}`);
        const hypothetical = { ...existing, groupIds: [...new Set(groupIds.map(normalizeId))] };
        hypothetical.owners = this.#store.resolveOwners(hypothetical);
        hypothetical.active = Object.keys(hypothetical.requests).length > 0 || hypothetical.groupIds.length > 0;
        return { previous: existing, current: hypothetical, plan: (await this.#buildPlan(hypothetical)).plan };
      }
      const result = await this.#store.setGrantGroups(itemId, groupIds);
      const plan = await this.#reconcileGrant(result.current);
      return { ...result, plan };
    });
  }

  public upsertGroup(input: { id: string; name: string; userIds: string[] }): Promise<AccessGroup> {
    return this.#exclusive(async () => {
      await this.#validateUsers(input.userIds);
      const group = await this.#store.upsertGroup(input);
      await this.#reconcileReferencingGroup(group.id);
      return group;
    });
  }

  public deleteGroup(groupId: string): Promise<{ groupId: string; affectedItems: string[] }> {
    return this.#exclusive(async () => {
      const results = await this.#store.deleteGroup(groupId);
      for (const result of results) await this.#reconcileGrant(result.current);
      return { groupId: normalizeId(groupId), affectedItems: results.map((result) => result.current.itemId) };
    });
  }

  async #reconcileReferencingGroup(groupId: string): Promise<void> {
    for (const grant of this.#store.list().filter((entry) => entry.groupIds.includes(groupId))) {
      await this.#reconcileGrant(grant);
    }
  }

  async #validateUsers(userIds: string[]): Promise<void> {
    const users = await this.#jellyfin.getUsers();
    const known = new Set(users.map((user) => normalizeId(user.Id)));
    const missing = userIds.map(normalizeId).filter((id) => !known.has(id));
    if (missing.length > 0) throw new Error(`Jellyfin user not found: ${missing.join(', ')}`);
  }

  async #reconcileGrant(grant: GrantRecord): Promise<ChangePlan> {
    try {
      const context = await this.#buildPlan(grant);
      await this.#applyPlan(context);
      await this.#store.markSyncSuccess(grant.itemId);
      if (!grant.active) await this.#store.purgeInactive(grant.itemId);
      this.#metrics.increment('jfa_reconciliations_total', { result: 'success' });
      return context.plan;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#store.markSyncError(grant.itemId, message);
      this.#metrics.increment('jfa_reconciliations_total', { result: 'error' });
      throw error;
    } finally {
      this.#refreshGauges();
    }
  }

  async #buildPlan(grant: GrantRecord): Promise<PlanContext> {
    const [item, users] = await Promise.all([
      this.#jellyfin.getItem(grant.itemId),
      this.#jellyfin.getUsers(),
    ]);
    const owners = grant.active ? this.#store.resolveOwners(grant) : [];
    const knownUserIds = new Set(users.map((user) => normalizeId(user.Id)));
    const missingOwners = owners.filter((owner) => !knownUserIds.has(owner));
    if (missingOwners.length > 0) throw new Error(`Jellyfin user not found: ${missingOwners.join(', ')}`);

    const tag = accessTag(grant.itemId);
    const beforeTags = item.Tags ?? [];
    const afterTags = grant.active
      ? uniqueCaseInsensitive([...beforeTags, tag])
      : beforeTags.filter((entry) => entry.toLowerCase() !== tag.toLowerCase());
    const itemAction = sameStringSet(beforeTags, afterTags) ? 'none' : grant.active ? 'add_tag' : 'remove_tag';
    const userChanges = users.map((user) => {
      const before = user.Policy.BlockedTags ?? [];
      const withoutTag = before.filter((entry) => entry.toLowerCase() !== tag.toLowerCase());
      const isOwner = owners.includes(normalizeId(user.Id));
      const shouldBlock = grant.active && !user.Policy.IsAdministrator && !isOwner;
      const after = shouldBlock ? uniqueCaseInsensitive([...withoutTag, tag]) : withoutTag;
      return {
        userId: user.Id,
        userName: user.Name,
        action: sameStringSet(before, after) ? 'none' as const : shouldBlock ? 'block' as const : 'unblock' as const,
        before,
        after,
      };
    });
    return {
      item,
      users,
      plan: {
        itemId: grant.itemId,
        itemName: item.Name,
        tag,
        active: grant.active,
        owners,
        item: { action: itemAction, before: beforeTags, after: afterTags },
        users: userChanges,
      },
    };
  }

  async #applyPlan(context: PlanContext): Promise<void> {
    if (context.plan.item.action !== 'none') {
      await this.#jellyfin.updateItem({ ...context.item, Tags: context.plan.item.after });
      this.#metrics.increment('jfa_item_updates_total');
    }
    for (const change of context.plan.users) {
      if (change.action === 'none') continue;
      const user = context.users.find((entry) => entry.Id === change.userId);
      if (!user) throw new Error(`Jellyfin user disappeared during reconciliation: ${change.userId}`);
      await this.#jellyfin.updatePolicy(user.Id, { ...user.Policy, BlockedTags: change.after });
      this.#metrics.increment('jfa_policy_updates_total');
    }
  }

  #refreshGauges(): void {
    const grants = this.#store.list();
    this.#metrics.gauge('jfa_grants', grants.filter((grant) => grant.active).length);
    this.#metrics.gauge('jfa_sync_errors', grants.filter((grant) => grant.sync.state === 'error').length);
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.catch(() => undefined).then(operation);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
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

function isDue(grant: GrantRecord): boolean {
  if (grant.sync.state === 'pending') return true;
  if (grant.sync.state === 'synced') return true;
  return !grant.sync.nextRetryAt || Date.parse(grant.sync.nextRetryAt) <= Date.now();
}

function hypotheticalRevocation(grant: GrantRecord, requestId: string, store: GrantStore): GrantRecord {
  const requests = { ...grant.requests };
  delete requests[requestId];
  const next = { ...grant, requests, updatedAt: new Date().toISOString() };
  next.owners = store.resolveOwners(next);
  next.active = Object.keys(requests).length > 0 || next.groupIds.length > 0;
  return next;
}
