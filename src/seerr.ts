import type { SeerrRequest } from './types.js';

export class SeerrClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;

  public constructor(baseUrl: string, apiKey: string) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
  }

  public async getRequest(requestId: string): Promise<SeerrRequest> {
    const response = await fetch(`${this.#baseUrl}/api/v1/request/${encodeURIComponent(requestId)}`, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/json',
        'X-Api-Key': this.#apiKey,
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Seerr GET request ${requestId} returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await response.json()) as SeerrRequest;
  }
}
