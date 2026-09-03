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

export class JellyfinClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;

  public constructor(baseUrl: string, apiKey: string) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
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
          SortBy: 'SortName',
          SortOrder: 'Ascending',
          StartIndex: String(startIndex),
          Limit: String(limit),
        });
        const page = await this.#request<JellyfinItemQueryResult>(`/Items?${parameters.toString()}`);
        const items = page.Items ?? [];
        for (const item of items) {
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
    const authorization = `MediaBrowser Client="JellyPass", Device="Web", DeviceId="${randomUUID()}", Version="0.2.0"`;
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
        Authorization: authorization,
        'X-Emby-Token': authentication.AccessToken,
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

  public async getItemPoster(itemId: string): Promise<{ body: Uint8Array; contentType: string }> {
    const response = await fetch(`${this.#baseUrl}/Items/${encodeURIComponent(itemId)}/Images/Primary?maxHeight=360&quality=85`, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg', 'X-Emby-Token': this.#apiKey },
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
        'Content-Type': 'application/json',
        'X-Emby-Token': this.#apiKey,
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
