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
  /** Set by Seerr's database when the request is saved; a requester cannot choose it. */
  createdAt?: string;
  /**
   * The seasons a TV request asked for. Seerr (3.5.x) keeps only seasons it had no episodes of (status unknown or
   * deleted) and refuses a request that is left with none.
   */
  seasons?: Array<{ seasonNumber?: number }>;
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
  /** Items whose request grant a late request's household joined (see AccessService.backfillRequests). */
  joined: string[];
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
  /**
   * Usually the file's modification time, not when Jellyfin added the item: downloaders keep a release's old file
   * times, and a rewrite or upgrade sets a new one. JellyPass never uses it to judge a request (see AvailabilityJournal).
   */
  DateCreated?: string;
  Tags?: string[];
  ProviderIds?: Record<string, string | null | undefined>;
  /** The primary video's width, with `Fields=Width`. */
  Width?: number;
  /** With `Fields=MediaSourceCount`; Jellyfin leaves it out for an item with one version. */
  MediaSourceCount?: number;
  MediaSources?: Array<{ MediaStreams?: Array<{ Type?: string; Width?: number }> }>;
  /** An episode's series and season number. */
  SeriesId?: string;
  ParentIndexNumber?: number;
  LocationType?: string;
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

/** `hd` is Seerr's standard quality; `4k` its 4K quality, a video wider than 2000 pixels as Seerr (3.5.x) counts it. */
export type MediaQuality = 'hd' | '4k';

/** A movie or series JellyPass saw in Jellyfin, for the AvailabilityJournal. */
export interface AvailabilityTitle {
  mediaType: 'movie' | 'tv';
  itemId: string;
  tmdbId?: number;
  qualities: MediaQuality[];
}

/** An episode JellyPass saw in Jellyfin, for the AvailabilityJournal. */
export interface AvailabilityEpisode {
  seriesId: string;
  seasonNumber: number;
  qualities: MediaQuality[];
}

/**
 * What JellyPass itself saw in Jellyfin, and when, so that a request can be judged by whether its title was already
 * there when it was made (see AccessService.classifyRequest). Jellyfin's own dates cannot answer that (see
 * JellyfinItem.DateCreated). Each key counts, over time, the Jellyfin items of a movie in one quality
 * (`movie:<title>:<quality>`) or the episodes of one season of a series in one quality
 * (`tv:<title>:<quality>:s<season>`), where `<title>` is `tmdb-<TMDB ID>`, or `item-<Jellyfin ID>` for an item
 * Jellyfin has no TMDB ID for. Keyed by title rather than Jellyfin item, an entry survives the new item ID, path or
 * file date of a re-import, an upgrade or a rewrite.
 */
export interface AvailabilityJournal {
  /**
   * The earliest time the journal can judge: when the first full sync that recorded it finished, moved forward as old
   * history is pruned (see AVAILABILITY_RETENTION_DAYS). A request made before it is judged as JellyPass 2.2.1 did.
   */
  since: string;
  /** When the latest full sync finished. */
  syncedAt: string;
  /** When the latest look for items Jellyfin saved since the one before started (see AccessService.pollAvailability). */
  polledAt?: string;
  /**
   * Per key, each change of the count as `[time, count]`, oldest first. A count seen to rise is dated when the
   * observation finished; one a full sync saw fall, when that sync started (see GrantStore.recordAvailabilitySync).
   */
  titles: Record<string, Array<[string, number]>>;
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
  /** Seerr request IDs that already produced a grant or were recorded as late; the backfill never re-imports them. */
  handledRequestIds?: string[];
  /** Added after 2.2.1 without a schema change: 2.2.1 loads and saves the field unchanged and ignores it. */
  availability?: AvailabilityJournal;
  /**
   * Requests an administrator revoked, by request ID, with the items they were revoked from. Moving a grant (recovery
   * or remap) never adds a request to an item it was revoked from, so a copy left on a stale grant cannot restore it.
   */
  revokedRequests?: Record<string, string[]>;
  /**
   * What an administrator removed from each item, by item ID (see AccessRemovals): the one removal record that household
   * library joins and grant moves (recovery or remap, dry runs included) both check, so neither adds a removed user or
   * group to that item again. Webhooks and the request backfill never grant a handled request again, and a new request
   * is a new grant decision (see GrantStore.grant); a late request is not (see GrantStore.recordLateRequest).
   */
  removedAccess?: Record<string, AccessRemovals>;
}

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
