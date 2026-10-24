import { randomUUID } from 'node:crypto';
import { availabilityEpisode, availabilityTitle } from './availability.js';
import type {
  AvailabilityEpisode,
  AvailabilityTitle,
  JellyfinItem,
  JellyfinItemQueryResult,
  JellyfinPolicy,
  JellyfinUser,
  LibraryCatalogItem,
  LibraryItemSummary,
} from './types.js';

/** Enough to tell a title (TMDB ID) and its quality (see itemQualities), without images or user data. */
const AVAILABILITY_QUERY = {
  Recursive: 'true',
  Fields: 'ProviderIds,Width,MediaSourceCount',
  CollapseBoxSetItems: 'false',
  EnableImages: 'false',
  EnableUserData: 'false',
};

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
   * Every movie, series and episode on disk in every library, for a full sync of the AvailabilityJournal. Missing
   * (virtual) episodes are left out.
   */
  public async fetchAvailability(): Promise<{ titles: AvailabilityTitle[]; episodes: AvailabilityEpisode[] }> {
    const folders = await this.#request<JellyfinItemQueryResult>('/Library/MediaFolders');
    const titles: AvailabilityTitle[] = [];
    const episodes: AvailabilityEpisode[] = [];
    for (const library of folders.Items ?? []) {
      for (const item of await this.#allItems({ ...AVAILABILITY_QUERY, ParentId: library.Id, IncludeItemTypes: 'Movie,Series' })) {
        const title = availabilityTitle(item);
        if (title) titles.push(title);
      }
      for (const item of await this.#allItems({ ...AVAILABILITY_QUERY, ParentId: library.Id, IncludeItemTypes: 'Episode', IsMissing: 'false' })) {
        const episode = availabilityEpisode(item);
        if (episode) episodes.push(episode);
      }
    }
    return { titles, episodes };
  }

  /**
   * The movies and series Jellyfin saved (added, or changed) since `since`, and every episode on disk of each series
   * one of whose episodes it saved. Jellyfin sets an item's last-saved time when it adds the item, whatever the file's
   * dates (unlike DateCreated), so this finds a title added with an old file time.
   */
  public async fetchSavedSince(since: Date): Promise<{ titles: AvailabilityTitle[]; episodes: AvailabilityEpisode[] }> {
    const saved = await this.#allItems({
      ...AVAILABILITY_QUERY,
      IncludeItemTypes: 'Movie,Series,Episode',
      MinDateLastSaved: since.toISOString(),
    });
    const titles = saved.flatMap((item) => availabilityTitle(item) ?? []);
    const seriesIds = [...new Set(saved.flatMap((item) => item.Type === 'Episode' && item.SeriesId ? [item.SeriesId] : []))];
    const known = new Set(titles.map((title) => title.itemId));
    const unknown = seriesIds.filter((seriesId) => !known.has(seriesId));
    for (let start = 0; start < unknown.length; start += 100) {
      const ids = unknown.slice(start, start + 100).join(',');
      for (const item of await this.#allItems({ ...AVAILABILITY_QUERY, Ids: ids })) {
        const title = availabilityTitle(item);
        if (title) titles.push(title);
      }
    }
    const episodes: AvailabilityEpisode[] = [];
    for (const seriesId of seriesIds) episodes.push(...await this.getEpisodes(seriesId));
    return { titles, episodes };
  }

  /** A series' episodes on disk, by season and quality. */
  public async getEpisodes(seriesId: string): Promise<AvailabilityEpisode[]> {
    const parameters = new URLSearchParams({
      Fields: 'Width,MediaSourceCount',
      IsMissing: 'false',
      EnableImages: 'false',
      EnableUserData: 'false',
    });
    const result = await this.#request<JellyfinItemQueryResult>(
      `/Shows/${encodeURIComponent(seriesId)}/Episodes?${parameters.toString()}`,
    );
    return (result.Items ?? []).flatMap((item) => {
      const episode = availabilityEpisode({ ...item, Type: item.Type ?? 'Episode', SeriesId: item.SeriesId ?? seriesId });
      return episode ? [episode] : [];
    });
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

  /** Pages through `/Items` with these parameters. */
  async #allItems(query: Record<string, string>): Promise<JellyfinItem[]> {
    const items: JellyfinItem[] = [];
    const limit = 500;
    while (true) {
      const parameters = new URLSearchParams({ ...query, StartIndex: String(items.length), Limit: String(limit) });
      const page = await this.#request<JellyfinItemQueryResult>(`/Items?${parameters.toString()}`);
      const pageItems = page.Items ?? [];
      items.push(...pageItems);
      if (pageItems.length === 0 || items.length >= (page.TotalRecordCount ?? items.length)) return items;
    }
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
    ['Version', '2.2.1'],
  ];
  if (token) parameters.push(['Token', token]);
  return mediaBrowserAuthorization(parameters);
}

function mediaBrowserAuthorization(parameters: Array<[string, string]>): string {
  return `MediaBrowser ${parameters.map(([name, value]) => `${name}="${encodeURIComponent(value)}"`).join(', ')}`;
}
