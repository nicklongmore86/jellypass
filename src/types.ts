export interface SeerrWebhook {
  notificationType: string;
  media: {
    jellyfinMediaId: string;
    mediaType?: string;
  };
  request: {
    id: string;
    requestedBy: {
      jellyfinUserId: string;
      username?: string;
    };
  };
}

export interface JellyfinPolicy {
  IsAdministrator?: boolean;
  BlockedTags?: string[];
  [key: string]: unknown;
}

export interface JellyfinUser {
  Id: string;
  Name: string;
  Policy: JellyfinPolicy;
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Tags?: string[];
  [key: string]: unknown;
}

export interface GrantRecord {
  itemId: string;
  active: boolean;
  mediaType?: string;
  owners: string[];
  requests: Record<string, string>;
  groupIds: string[];
  sync: SyncStatus;
  updatedAt: string;
}

export interface GrantState {
  version: 2;
  grants: Record<string, GrantRecord>;
  groups: Record<string, AccessGroup>;
}

export interface AccessGroup {
  id: string;
  name: string;
  userIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SyncStatus {
  state: 'pending' | 'synced' | 'error';
  attempts: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  nextRetryAt?: string;
  lastError?: string;
}

export interface RevokeResult {
  previous: GrantRecord;
  current: GrantRecord;
}

export interface ItemChange {
  action: 'add_tag' | 'remove_tag' | 'none';
  before: string[];
  after: string[];
}

export interface UserPolicyChange {
  userId: string;
  userName: string;
  action: 'block' | 'unblock' | 'none';
  before: string[];
  after: string[];
}

export interface ChangePlan {
  itemId: string;
  itemName: string;
  tag: string;
  active: boolean;
  owners: string[];
  item: ItemChange;
  users: UserPolicyChange[];
}
