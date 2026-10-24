export interface SeerrWebhook {
  notificationType: string;
  media?: {
    jellyfinMediaId?: string;
    mediaType?: string;
  };
  request: {
    id: string;
    /**
     * Whether Seerr's `{{event}}` text names a 4K request. Undefined when the payload has no
     * recognizable event, so the 4K and HD items cannot be told apart.
     */
    is4k?: boolean;
    requestedBy?: {
      jellyfinUserId?: string;
      username?: string;
    };
  };
}

/** A webhook whose notificationType is not MEDIA_AVAILABLE; it carries nothing to grant. */
export interface IgnoredWebhook {
  notificationType: string;
}

export interface SeerrRequest {
  id: number;
  type?: string;
  is4k?: boolean;
  createdAt?: string;
  requestedBy?: {
    jellyfinUserId?: string;
  };
  media?: {
    mediaType?: string;
    status?: number;
    status4k?: number;
    jellyfinMediaId?: string;
    jellyfinMediaId4k?: string;
    tmdbId?: number;
  };
}

export interface RequestBackfillResult {
  scanned: number;
  granted: string[];
  skipped: number;
  failed: number;
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
  /** Set when moving the grant off its deleted Jellyfin item did not finish as a plain move (see GrantRemapNote). */
  remap?: GrantRemapNote;
}

export interface GrantRemapNote {
  /**
   * Items part of this grant's requests already moved to. Its manual users and groups were kept here because they
   * cannot be attributed to any one of those items, so a later recovery moves only newly resolved requests and their
   * requesters' households, never the whole audience.
   */
  splitTo?: string[];
  /**
   * The grant's item existed again when a move off it finished: the targets were applied, but this grant was kept
   * intact (still restricting the item) for an administrator to resolve.
   */
  sourceReappeared?: { at: string; movedTo: string[] };
}

export interface GrantState {
  version: 7;
  grants: Record<string, GrantRecord>;
  groups: Record<string, AccessGroup>;
  catalog: LibraryCatalog;
  passwordlessUserIds: string[];
  /** Seerr request IDs that already produced a grant; the backfill never re-imports them. */
  handledRequestIds?: string[];
  /**
   * Requests an administrator revoked, by request ID, with the items they were revoked from. Moving a grant (recovery
   * or remap) never adds a request to an item it was revoked from, so a copy left on a stale grant cannot restore it.
   */
  revokedRequests?: Record<string, string[]>;
}

export interface AccessGroup {
  id: string;
  name: string;
  userIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SyncStatus {
  /**
   * `orphaned`: the grant's Jellyfin item was deleted and no replacement could be resolved from its Seerr requests.
   * Scheduled reconciliation skips it (lastError says why) until an administrator remaps it or runs a full reconcile.
   */
  state: 'pending' | 'synced' | 'error' | 'orphaned';
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
