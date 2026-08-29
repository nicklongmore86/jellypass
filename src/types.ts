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
  mediaType?: string;
  owners: string[];
  requests: Record<string, string>;
  updatedAt: string;
}

export interface GrantState {
  version: 1;
  grants: Record<string, GrantRecord>;
}
