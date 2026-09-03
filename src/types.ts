export interface SeerrWebhook {
  notificationType: string;
  media?: {
    jellyfinMediaId?: string;
    mediaType?: string;
  };
  request: {
    id: string;
    requestedBy?: {
      jellyfinUserId?: string;
      username?: string;
    };
  };
}

export interface SeerrRequest {
  id: number;
  type?: string;
  is4k?: boolean;
  requestedBy?: {
    jellyfinUserId?: string;
  };
  media?: {
    mediaType?: string;
    jellyfinMediaId?: string;
    jellyfinMediaId4k?: string;
  };
}

export interface RecentSeerrRequest {
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year?: number;
  posterPath?: string;
  jellyfinItemId?: string;
  requestStatus: 'pending' | 'approved' | 'declined' | 'failed' | 'completed' | 'unknown';
  mediaStatus: 'unknown' | 'pending' | 'processing' | 'partially_available' | 'available' | 'deleted';
  requestedBy: string;
  createdAt: string;
  seasonCount?: number;
}

export interface JellyfinPolicy {
  IsAdministrator?: boolean;
  IsDisabled?: boolean;
  IsHidden?: boolean;
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
  Type?: string;
  CollectionType?: string;
  ProductionYear?: number;
  DateCreated?: string;
  Tags?: string[];
  [key: string]: unknown;
}

export interface JellyfinItemQueryResult {
  Items?: JellyfinItem[];
  TotalRecordCount?: number;
}

export interface LibraryItemSummary {
  id: string;
  name: string;
  mediaType: string;
  productionYear?: number;
}

export interface LibraryCatalogItem extends LibraryItemSummary {
  libraryId: string;
  libraryName: string;
  dateCreated?: string;
}

export interface LibraryCatalog {
  lastSyncedAt?: string;
  items: Record<string, LibraryCatalogItem>;
}

export interface GrantRecord {
  itemId: string;
  active: boolean;
  mediaType?: string;
  owners: string[];
  requests: Record<string, string>;
  manualUserIds: string[];
  groupIds: string[];
  sync: SyncStatus;
  updatedAt: string;
}

export interface GrantState {
  version: 4;
  grants: Record<string, GrantRecord>;
  groups: Record<string, AccessGroup>;
  catalog: LibraryCatalog;
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

export interface RelatedItemChange extends ItemChange {
  itemId: string;
  itemName: string;
  itemType?: string;
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
  relatedItems: RelatedItemChange[];
  users: UserPolicyChange[];
}
