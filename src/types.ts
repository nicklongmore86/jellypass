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
  /** Seerr MediaRequestStatus: 1 pending, 2 approved, 3 declined, 4 failed, 5 completed. */
  status?: number;
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
  /** Household "Add to my library" joins that changed this grant, oldest first, for administrators to audit. */
  joins?: LibraryJoin[];
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

export interface LibraryJoin {
  userId: string;
  /** Households added to the grant; empty when the user, who belongs to none, was added as a manual user. */
  groupIds: string[];
  userAdded: boolean;
  joinedAt: string;
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
  /**
   * What an administrator removed from each item, by item ID (see AccessRemovals): the one removal record that household
   * library joins and grant moves (recovery or remap, dry runs included) both check, so neither adds a removed user or
   * group to that item again. Webhooks and the request backfill never grant a handled request again, and a new request
   * is a new grant decision (see GrantStore.grant).
   */
  removedAccess?: Record<string, AccessRemovals>;
  /**
   * Household app "Get this" records, by a random ID that never leaves JellyPass (see AppRequestRecord). Additive: a
   * 2.2.1 build keeps the field as it is without reading or updating it.
   */
  appRequests?: Record<string, AppRequestRecord>;
  /** The key the household app derives its opaque IDs from (hex, 32 bytes); made the first time one is needed. */
  appIdKey?: string;
  /**
   * Household app "Get this" requests about to be sent to Seerr, or sent and not yet settled, by a random ID (see
   * AppRequestIntent). Additive like `appRequests`.
   */
  appRequestIntents?: Record<string, AppRequestIntent>;
  /**
   * `MEDIA_AVAILABLE` webhooks acknowledged without a grant because a "Get this" request for their title was not yet
   * settled (see AppRequestIntent), oldest first, one per request; granted once it is. Additive like `appRequests`.
   */
  deferredWebhooks?: SeerrWebhook[];
}

/**
 * A Seerr request "Get this" is about to make, or made and has not settled yet (docs/app-design.md, "Late requests"):
 * written atomically before the request is sent, so neither a webhook arriving before Seerr's answer nor a restart can
 * grant the request privately. While any intent names a title, webhooks and the backfill grant no request for that
 * title (they are deferred); the intent is removed once the request is recorded and settled (its grant then follows
 * its record), or once it is known that no request was made.
 *
 * - `submitting`: the request is about to be, or was, sent; Seerr's answer is not recorded. On restart (or after an
 *   uncertain failure) the request is looked up in Seerr by the member and title: found, it is recorded; not found once
 *   APP_INTENT_TIMEOUT_MS has passed, the intent is removed.
 * - `settling`: the request (`seerrRequestId`) is recorded, but whether the title was in Jellyfin when it was made could
 *   not be read yet; it is read again, and once APP_SETTLE_DEADLINE_MS has passed the grant follows the join rules.
 */
export interface AppRequestIntent {
  householdId: string;
  /** The member it is made as, normalized. */
  jellyfinUserId: string;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  /** The seasons it asks for, ascending; empty for a movie. */
  seasons: number[];
  /** When Jellyfin was read and did not have the title (or these seasons): the read the request branch was chosen on. */
  observedAbsentAt: string;
  createdAt: string;
  status: 'submitting' | 'settling';
  seerrRequestId?: string;
}

/**
 * What one household app "Get this" did for one household (docs/app-design.md, "Get this"): the household's
 * attribution record, the only source of the app's `requested` state and of the readiness it shows.
 *
 * - `request`: JellyPass made `seerrRequestId` as the member (or found the member's own request for the title).
 * - `interest`: the title was already requested by someone else; `seerrRequestId` is that request, if one was found.
 *   The household is joined to the title's grant when the grant is created.
 * - `join`: Jellyfin already had the title; the household was joined to the grant of `itemIds` at once.
 *
 * Status, as the member's own request would have it: `pending` (pending or approved), `completed`, `failed`,
 * `declined` and `deleted`.
 */
export interface AppRequestRecord {
  /** The household whose host the call was made on; never changed by membership. */
  householdId: string;
  /** The member who asked, normalized (32 lowercase hex digits). */
  jellyfinUserId: string;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  /** The seasons this record covers, ascending; empty for a movie. */
  seasons: number[];
  createdAt: string;
  updatedAt: string;
  branch: 'request' | 'interest' | 'join';
  status: AppRequestStatus;
  seerrRequestId?: string;
  /** Seerr's media record for the title when the record was made, to tell its deletion apart. */
  seerrMediaId?: number;
  itemIds?: string[];
  /**
   * For a series, the seasons of `seasons` Jellyfin now has episodes of (read with JellyPass's key). A series record is
   * `completed` only once every season it covers is ready; until then it stays as it was and is refreshed.
   */
  readySeasons?: number[];
  /**
   * A `request` record whose grant must follow the library join rules rather than make a new grant
   * (docs/app-design.md, "Late requests" and "New seasons of a series Jellyfin has"): `existing-series` when Jellyfin
   * already had the series (the request is for seasons it lacks), `present-at-settle` when Jellyfin had the title when
   * the request was settled (it arrived while the request was being made), `unverified` when Jellyfin could not be read
   * to settle it within APP_SETTLE_DEADLINE_MS.
   */
  joinOnGrant?: 'existing-series' | 'present-at-settle' | 'unverified';
  /** When Jellyfin was last read for the title before the request was sent (the request branch's last step). */
  checkedAt?: string;
  /** The household was deleted: never shown, joined or `requested` again. */
  detached?: true;
}

export type AppRequestStatus = 'pending' | 'completed' | 'failed' | 'declined' | 'deleted';

/**
 * See GrantState.removedAccess. Kept in the state rather than on the grant so it outlives a grant that is purged or
 * replaced by a move.
 *
 * - `groupIds`: groups an administrator removed from the item. No join or move adds them again.
 * - `userIds`: users an administrator's change took access from: a removed manual user, a revoked request's requester,
 *   each member of a removed household who had no other access. A marked user's own joins change nothing, and no move
 *   adds them as a manual user again.
 *
 * An administrator assigning a group to the item again clears its mark; assigning a user as a manual user, or adding a
 * household they belong to, clears theirs. Deleting a group clears that group everywhere. When a grant moves to a new
 * item, its marks follow it there, except for users and groups the new item's grant already gave access to on its own
 * (see GrantStore.mergeGrants).
 */
export interface AccessRemovals {
  userIds?: string[];
  groupIds?: string[];
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
