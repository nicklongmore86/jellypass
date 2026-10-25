import { randomUUID } from 'node:crypto';
import type { JellyfinItem, JellyfinItemQueryResult, JellyfinPolicy, JellyfinUser, LibraryCatalogItem, LibraryItemSummary } from './types.js';

interface JellyfinAuthenticationResult {
  User?: {
    Id?: string;
    Name?: string;
  };
  AccessToken?: string;
}

export class JellyfinError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** The most items JellyfinClient.findItemsByName reads for one name; past it the search counts as incomplete. */
export const MAX_NAME_SEARCH_ITEMS = 2000;

export class JellyfinClient {
  readonly #baseUrl: string;
  readonly #authorization: string;

  public constructor(baseUrl: string, apiKey: string) {
    this.#baseUrl = baseUrl;
    this.#authorization = authorizationHeader('Server', 'jellypass-server', apiKey);
  }

  public getUsers(): Promise<JellyfinUser[]> {
    return this.#request<JellyfinUser[]>('/Users');
  }

  public createUser(name: string, password: string): Promise<JellyfinUser> {
    return this.#request<JellyfinUser>('/Users/New', {
      method: 'POST',
      body: JSON.stringify({ Name: name, Password: password }),
    });
  }

  public async searchLibrary(query: string, limit = 30): Promise<LibraryItemSummary[]> {
    const parameters = new URLSearchParams({
      Recursive: 'true',
      SearchTerm: query,
      IncludeItemTypes: 'Movie,Series',
      Fields: 'ProductionYear',
      CollapseBoxSetItems: 'false',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Limit: String(limit),
    });
    const result = await this.#request<JellyfinItemQueryResult>(`/Items?${parameters.toString()}`);
    return (result.Items ?? []).map((item) => ({
      id: item.Id,
      name: item.Name,
      mediaType: item.Type?.toLowerCase() ?? 'media',
      ...(item.ProductionYear ? { productionYear: item.ProductionYear } : {}),
    }));
  }

  public async fetchLibraryCatalog(): Promise<LibraryCatalogItem[]> {
    const folders = await this.#request<JellyfinItemQueryResult>('/Library/MediaFolders');
    const catalog = new Map<string, LibraryCatalogItem>();
    for (const library of folders.Items ?? []) {
      let startIndex = 0;
      const limit = 500;
      while (true) {
        const parameters = new URLSearchParams({
          ParentId: library.Id,
          Recursive: 'true',
          IncludeItemTypes: 'Movie,Series',
          Fields: 'ProductionYear,DateCreated',
          CollapseBoxSetItems: 'false',
          SortBy: 'SortName',
          SortOrder: 'Ascending',
          StartIndex: String(startIndex),
          Limit: String(limit),
        });
        const page = await this.#request<JellyfinItemQueryResult>(`/Items?${parameters.toString()}`);
        const items = page.Items ?? [];
        for (const item of items) {
          if (item.Type !== 'Movie' && item.Type !== 'Series') continue;
          catalog.set(item.Id, {
            id: item.Id,
            name: item.Name,
            mediaType: item.Type?.toLowerCase() ?? 'media',
            libraryId: library.Id,
            libraryName: library.Name,
            ...(item.ProductionYear ? { productionYear: item.ProductionYear } : {}),
            ...(item.DateCreated ? { dateCreated: item.DateCreated } : {}),
          });
        }
        startIndex += items.length;
        if (items.length === 0 || startIndex >= (page.TotalRecordCount ?? startIndex)) break;
      }
    }
    return [...catalog.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  public async authenticateAdministrator(username: string, password: string): Promise<JellyfinUser | null> {
    const deviceId = randomUUID();
    const authorization = authorizationHeader('Web', deviceId);
    const response = await fetch(`${this.#baseUrl}/Users/AuthenticateByName`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    if (response.status === 401) return null;
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new JellyfinError(
        `Jellyfin POST /Users/AuthenticateByName returned ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
      );
    }

    const authentication = await response.json() as JellyfinAuthenticationResult;
    if (!authentication.User?.Id || !authentication.AccessToken) {
      throw new Error('Jellyfin authentication response is incomplete');
    }
    const logout = await fetch(`${this.#baseUrl}/Sessions/Logout`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/json',
        Authorization: authorizationHeader('Web', deviceId, authentication.AccessToken),
      },
    });
    if (!logout.ok) {
      throw new JellyfinError(`Jellyfin POST /Sessions/Logout returned ${logout.status}`, logout.status);
    }
    const user = await this.#request<JellyfinUser>(`/Users/${encodeURIComponent(authentication.User.Id)}`);
    return user.Policy.IsAdministrator && !user.Policy.IsDisabled
      ? user
      : null;
  }

  public async getItem(itemId: string): Promise<JellyfinItem> {
    return (await this.getItems([itemId]))[0] as JellyfinItem;
  }

  public async getItems(itemIds: string[]): Promise<JellyfinItem[]> {
    const users = await this.getUsers();
    const administrator = users.find((user) => user.Policy.IsAdministrator);
    if (!administrator) throw new Error('Jellyfin administrator user not found');
    return Promise.all(itemIds.map((itemId) => this.#request<JellyfinItem>(
      `/Users/${encodeURIComponent(administrator.Id)}/Items/${encodeURIComponent(itemId)}`,
    )));
  }

  /**
   * Every movie or series item (`mediaType`) Jellyfin holds for a TMDB title, in any library and whoever may see it,
   * read with JellyPass's API key: the household app's decision input for "Jellyfin already has it". Jellyfin cannot
   * filter by provider ID, so items with a TMDB ID are paged through and matched here.
   */
  public async findItemsByTmdbId(mediaType: 'movie' | 'tv', tmdbId: number): Promise<string[]> {
    const wanted = String(tmdbId);
    const found = new Set<string>();
    const limit = 1000;
    for (let startIndex = 0; ; startIndex += limit) {
      const parameters = new URLSearchParams({
        Recursive: 'true',
        IncludeItemTypes: mediaType === 'movie' ? 'Movie' : 'Series',
        HasTmdbId: 'true',
        Fields: 'ProviderIds',
        EnableImages: 'false',
        EnableUserData: 'false',
        EnableTotalRecordCount: 'false',
        StartIndex: String(startIndex),
        Limit: String(limit),
      });
      const items = (await this.#request<JellyfinItemQueryResult>(`/Items?${parameters.toString()}`)).Items ?? [];
      for (const item of items) {
        const providerIds = item.ProviderIds;
        const tmdb = providerIds && typeof providerIds === 'object'
          ? Object.entries(providerIds).find(([name]) => name.toLowerCase() === 'tmdb')?.[1]
          : undefined;
        if (tmdb === wanted && typeof item.Id === 'string') found.add(item.Id.toLowerCase());
      }
      if (items.length < limit) break;
    }
    return [...found].sort();
  }

  /**
   * Which of `itemIds` Jellyfin holds as a movie or series item (`mediaType`), read with JellyPass's API key whoever
   * may see them: for the items Seerr links to a title, which may have no TMDB ID of their own.
   */
  public async existingItems(mediaType: 'movie' | 'tv', itemIds: string[]): Promise<string[]> {
    const wanted = [...new Set(itemIds.map((itemId) => itemId.replace(/-/g, '').toLowerCase()))].filter((itemId) => /^[0-9a-f]{32}$/.test(itemId));
    if (wanted.length === 0) return [];
    const parameters = new URLSearchParams({
      Ids: wanted.join(','),
      Recursive: 'true',
      IncludeItemTypes: mediaType === 'movie' ? 'Movie' : 'Series',
      EnableImages: 'false',
      EnableUserData: 'false',
      EnableTotalRecordCount: 'false',
    });
    const items = (await this.#request<JellyfinItemQueryResult>(`/Items?${parameters.toString()}`)).Items ?? [];
    const found = new Set(items.flatMap((item) => typeof item.Id === 'string' ? [item.Id.replace(/-/g, '').toLowerCase()] : []));
    return wanted.filter((itemId) => found.has(itemId)).sort();
  }

  /**
   * The movie or series items (`mediaType`) Jellyfin holds that may be a title known by `names`, in any library and
   * whoever may see them, read with JellyPass's API key: for titles whose items have no TMDB ID and that Seerr links to
   * no item. Conservative, so a title Jellyfin has is never requested: every item Jellyfin's search finds for one of
   * `names` is paged through (at most {@link MAX_NAME_SEARCH_ITEMS} per name). An item with this TMDB ID matches; an
   * item with another TMDB ID is another title and never matches; an item without one matches when its name or original
   * name equals one of `names` once case, accents and punctuation are ignored, or contains one (it cannot be ruled out),
   * and, for a movie with a `year`, its production year (when it has one) is within a year of it. A different title of
   * the same name (and year) can match: the caller then gets a join rather than a request. `complete` is false when a
   * search had more items than were read: the title may be among those not read.
   */
  public async findItemsByName(mediaType: 'movie' | 'tv', tmdbId: number, names: string[], year?: number): Promise<{ itemIds: string[]; complete: boolean }> {
    const wanted = [...new Set(names.map(comparableName).filter((name) => name.length > 0))];
    const found = new Set<string>();
    let complete = true;
    const limit = 200;
    for (const name of names.slice(0, 4)) {
      for (let startIndex = 0; ; startIndex += limit) {
        if (startIndex >= MAX_NAME_SEARCH_ITEMS) {
          complete = false;
          break;
        }
        const parameters = new URLSearchParams({
          Recursive: 'true',
          IncludeItemTypes: mediaType === 'movie' ? 'Movie' : 'Series',
          SearchTerm: name,
          Fields: 'ProviderIds,OriginalTitle',
          EnableImages: 'false',
          EnableUserData: 'false',
          EnableTotalRecordCount: 'false',
          StartIndex: String(startIndex),
          Limit: String(limit),
        });
        const items = (await this.#request<JellyfinItemQueryResult>(`/Items?${parameters.toString()}`)).Items ?? [];
        for (const item of items) {
          if (typeof item.Id !== 'string') continue;
          const providerIds = item.ProviderIds;
          const tmdb = providerIds && typeof providerIds === 'object'
            ? Object.entries(providerIds).find(([key]) => key.toLowerCase() === 'tmdb')?.[1]
            : undefined;
          const known = typeof tmdb === 'string' && tmdb.trim() !== '';
          if (known && tmdb.trim() !== String(tmdbId)) continue;
          if (!known) {
            const itemNames = [item.Name, item.OriginalTitle].filter((value): value is string => typeof value === 'string').map(comparableName);
            if (!itemNames.some((itemName) => wanted.some((title) => itemName.includes(title)))) continue;
            if (mediaType === 'movie' && year !== undefined && typeof item.ProductionYear === 'number' && Math.abs(item.ProductionYear - year) > 1) continue;
          }
          found.add(item.Id.replace(/-/g, '').toLowerCase());
        }
        if (items.length < limit) break;
      }
    }
    return { itemIds: [...found].sort(), complete };
  }

  /** The season numbers of a series Jellyfin has episodes of (not missing ones), read with JellyPass's API key. */
  public async seasonsWithEpisodes(seriesId: string): Promise<number[]> {
    const parameters = new URLSearchParams({ IsMissing: 'false', EnableImages: 'false', EnableUserData: 'false' });
    const result = await this.#request<JellyfinItemQueryResult>(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${parameters.toString()}`);
    const seasons = new Set<number>();
    for (const item of result.Items ?? []) {
      const season = item.ParentIndexNumber;
      if (typeof season === 'number' && Number.isSafeInteger(season) && season >= 0) seasons.add(season);
    }
    return [...seasons].sort((left, right) => left - right);
  }

  public async getLocalTrailers(itemId: string, userId: string): Promise<JellyfinItem[]> {
    return this.#request<JellyfinItem[]>(
      `/Items/${encodeURIComponent(itemId)}/LocalTrailers?userId=${encodeURIComponent(userId)}`,
    );
  }

  public async getItemPoster(itemId: string): Promise<{ body: Uint8Array; contentType: string }> {
    const response = await fetch(`${this.#baseUrl}/Items/${encodeURIComponent(itemId)}/Images/Primary?maxHeight=360&quality=85`, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg', Authorization: this.#authorization },
    });
    if (!response.ok) {
      throw new JellyfinError(`Jellyfin poster for item ${itemId} returned ${response.status}`, response.status);
    }
    return {
      body: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || 'image/jpeg',
    };
  }

  public async updateItem(item: JellyfinItem): Promise<void> {
    await this.#request(`/Items/${encodeURIComponent(item.Id)}`, {
      method: 'POST',
      body: JSON.stringify(item),
    });
  }

  public async updatePolicy(userId: string, policy: JellyfinPolicy): Promise<void> {
    await this.#request(`/Users/${encodeURIComponent(userId)}/Policy`, {
      method: 'POST',
      body: JSON.stringify(policy),
    });
  }

  async #request<T = unknown>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/json',
        Authorization: this.#authorization,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new JellyfinError(
        `Jellyfin ${init.method ?? 'GET'} ${pathname} returned ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
      );
    }

    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

function authorizationHeader(device: string, deviceId: string, token?: string): string {
  const parameters: Array<[string, string]> = [
    ['Client', 'JellyPass'],
    ['Device', device],
    ['DeviceId', deviceId],
    ['Version', '2.6.0'],
  ];
  if (token) parameters.push(['Token', token]);
  return mediaBrowserAuthorization(parameters);
}

function mediaBrowserAuthorization(parameters: Array<[string, string]>): string {
  return `MediaBrowser ${parameters.map(([name, value]) => `${name}="${encodeURIComponent(value)}"`).join(', ')}`;
}

/** A title's name for comparison: accents, case, punctuation and spacing ignored. */
function comparableName(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
