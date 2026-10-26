// Shared by the API client's tests: the server's schema and fetch budget (read from docs/, not copied), the
// synthetic answer fixtures, a fake fetch that records every call, and how the client makes each documented
// operation. No test makes a network call.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createApiClient, parseHouseholdAddress, type ApiClient, type FetchLike, type RequestInitLike, type ResponseLike } from '../../src/api';

const DOCS = path.join(__dirname, '..', '..', '..', 'docs', 'app-api');

export type Json = Record<string, unknown>;

export const DOC = JSON.parse(readFileSync(path.join(DOCS, 'v1.openapi.json'), 'utf8')) as Json & {
  paths: Record<string, Record<string, Json & { responses: Record<string, Json>; parameters?: Json[] }>>;
  components: { schemas: Record<string, Json>; responses: Record<string, Json> };
};
export const BUDGET = JSON.parse(readFileSync(path.join(DOCS, 'fetch-budget.json'), 'utf8')) as {
  screens: Record<string, { calls: number; atOnce: string[]; belowTheFold?: string[] }>;
};

export function fixture(name: string): Json {
  return JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'app-api', `${name}.json`), 'utf8')) as Json;
}

export const ORIGIN = 'https://jelly-household.example.test';
export const ADDRESS = parseHouseholdAddress(ORIGIN)!;
export const TOKEN = 'synthetic-token-0123456789abcdef';
export const API = `${ORIGIN}/jellypass/app/v1`;

/** A Response as the client reads it. `body` is sent as JSON unless it is already a string. */
export function answer(status: number, body?: unknown, headers: Record<string, string> = {}, url?: string): ResponseLike {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    status,
    ...(url === undefined ? {} : { url }),
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: jest.fn(async () => text),
  };
}

export interface Recorded {
  url: string;
  init: RequestInitLike;
}

/** A client on ADDRESS whose fetch answers with `respond` and records each call. */
export function clientWith(
  respond: (url: string, init: RequestInitLike) => ResponseLike | Promise<ResponseLike>,
  options: { token?: string | undefined; timeoutMs?: number; now?: () => number } = {},
): { api: ApiClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  const token = 'token' in options ? options.token : TOKEN;
  const api = createApiClient({
    address: ADDRESS,
    token: () => token,
    fetch,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { api, calls };
}

export interface Operation {
  /** The call, made through the client. */
  call: (api: ApiClient) => Promise<unknown>;
  /** What it sends: `METHOD path` under /jellypass/app/v1. */
  sends: string;
  /** Its success status and answer fixture. */
  status: 200 | 202;
  fixture: string;
}

/** Every operation in docs/app-api/v1.openapi.json, as the client makes it. api-schema.test.ts checks the two match. */
export const OPERATIONS: Record<string, Operation> = {
  'GET /me': { call: (api) => api.me(), sends: 'GET /me', status: 200, fixture: 'me' },
  'GET /search': { call: (api) => api.search('  synthetic & co ', 2), sends: 'GET /search?q=synthetic%20%26%20co&page=2', status: 200, fixture: 'page' },
  'GET /discover/{list}': { call: (api) => api.discover('upcoming-tv'), sends: 'GET /discover/upcoming-tv', status: 200, fixture: 'page' },
  'GET /discover/sources': { call: (api) => api.sources(), sends: 'GET /discover/sources', status: 200, fixture: 'sources' },
  'GET /discover/network/{id}': { call: (api) => api.network(213, undefined, 3), sends: 'GET /discover/network/213?page=3', status: 200, fixture: 'page' },
  'GET /discover/network/{id}/films': { call: (api) => api.network(213, 'films'), sends: 'GET /discover/network/213/films', status: 200, fixture: 'page-last' },
  'GET /discover/network/{id}/all': { call: (api) => api.network(213, 'all', 2), sends: 'GET /discover/network/213/all?page=2', status: 200, fixture: 'page' },
  'GET /discover/studio/{id}': { call: (api) => api.studio(2), sends: 'GET /discover/studio/2', status: 200, fixture: 'page' },
  'GET /movie/{tmdbId}': { call: (api) => api.movie(900001), sends: 'GET /movie/900001', status: 200, fixture: 'movie' },
  'GET /tv/{tmdbId}': { call: (api) => api.tv(900002), sends: 'GET /tv/900002', status: 200, fixture: 'series' },
  'GET /tv/{tmdbId}/season/{n}': { call: (api) => api.season(900002, 1), sends: 'GET /tv/900002/season/1', status: 200, fixture: 'season' },
  'POST /movie/{tmdbId}/get': { call: (api) => api.getThis('movie', 900001), sends: 'POST /movie/900001/get', status: 202, fixture: 'accepted' },
  'POST /tv/{tmdbId}/get': { call: (api) => api.getThis('tv', 900002, [1, 2]), sends: 'POST /tv/900002/get', status: 202, fixture: 'accepted' },
  'GET /requests': { call: (api) => api.requests(), sends: 'GET /requests', status: 200, fixture: 'requests' },
};

/** `METHOD path` of a recorded call, under /jellypass/app/v1. */
export function sent(call: Recorded): string {
  return `${call.init.method} ${call.url.slice(API.length)}`;
}

export const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

/** Where a redirect may point: the household itself, or anywhere else. */
export const REDIRECT_TARGETS = {
  'same-origin': (url: string) => `${url}-moved`,
  'cross-origin': () => 'https://elsewhere.example.test/catch',
} as const;

/**
 * A fake platform network that behaves as React Native's does under fetch: it follows a 3xx to its Location with a
 * second request (keeping the method, headers and body for 307/308, as NSURLSession and OkHttp do) unless the call
 * says `redirect: 'manual'` or `'error'`. `first` answers the first request; every request is recorded, so a test can
 * assert that nothing ever went to the Location.
 */
export function redirectingNetwork(first: (url: string, init: RequestInitLike) => ResponseLike) {
  const requests: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init });
    let response = first(url, init);
    const redirect = (init as { redirect?: string }).redirect;
    let hops = 0;
    while (response.status >= 300 && response.status < 400 && redirect !== 'manual' && redirect !== 'error' && hops < 5) {
      const location = response.headers.get('Location')!;
      const keep = response.status === 307 || response.status === 308;
      const next = { ...init, ...(keep ? {} : { method: 'GET' as const, body: undefined }) };
      requests.push({ url: location, init: next });
      response = answer(200, '"followed"', {}, location);
      hops += 1;
    }
    if (redirect === 'error' && response.status >= 300 && response.status < 400) throw new TypeError('redirect');
    return response;
  };
  return { fetch, requests };
}
