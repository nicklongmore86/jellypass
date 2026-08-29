import type { JellyfinItem, JellyfinPolicy, JellyfinUser } from './types.js';

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

  public getItem(itemId: string): Promise<JellyfinItem> {
    return this.#request<JellyfinItem>(`/Items/${encodeURIComponent(itemId)}`);
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
