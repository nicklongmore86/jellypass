// Decoding of the API's answers, as docs/app-design.md ("Native clients (contract)") asks: lenient only where the
// contract says so, strict otherwise. Fields the app does not know are ignored (only the named fields are copied,
// nothing is spread), an unknown `state` is `unavailable`, an unknown request `status` is `requested`, a `/me` without
// `apiVersion` is revision 0, an image URL off its field's pattern is null (that image only: one bad poster never
// blanks a screen), and a Play link that is not exactly the household's own is null (the schema: "a client ignores
// anything else"). Anything else that breaks docs/app-api/v1.openapi.json (a missing field, a wrong type, a number,
// length, item count or pattern outside the schema's limits) is a DecodeError, which the client turns into the
// `unexpected` error kind. __tests__/api-decode-constraints.test.ts fails when a limit here and the schema differ.

import {
  COARSE_STATUSES,
  HOUSEHOLD_STATES,
  MEDIA_TYPES,
  type Accepted,
  type Card,
  type CoarseStatus,
  type Episode,
  type HouseholdState,
  type MediaType,
  type Me,
  type Movie,
  type Network,
  type Page,
  type Play,
  type Request,
  type RequestSeason,
  type Requests,
  type Season,
  type SeasonSummary,
  type Series,
  type Source,
  type Sources,
} from './types';
import { safePlayUrl } from './urls';

/** An answer that is not the documented shape. Its message names the field, never a value. */
export class DecodeError extends Error {
  public constructor(path: string) {
    super(`unexpected answer at ${path}`);
    this.name = 'DecodeError';
  }
}

/** What decoding needs beyond the answer: the household origin, the only place a Play link may go. */
export interface DecodeContext {
  origin: string;
}

type Fields = Record<string, unknown>;

/** A number's limits, inclusive, as the schema's `minimum` and `maximum`. */
interface Range {
  min: number;
  max?: number;
}

/** A string's limits: `minLength` and `maxLength` in code points, as JSON Schema counts them, and `pattern`. */
interface Text {
  min?: number;
  max?: number;
  pattern?: RegExp;
}

/** A Card's TMDB ID (up to 2^53 - 1), and one a path can carry, as on a Movie, Series, Season or Request (up to 2^31 - 1). */
const CARD_TMDB_ID: Range = { min: 1, max: Number.MAX_SAFE_INTEGER };
const PATH_TMDB_ID: Range = { min: 1, max: 2147483647 };

/** The schema's image patterns, one width each: any other image URL is dropped, as the PWA drops it. */
const POSTER_URL = /^https:\/\/image\.tmdb\.org\/t\/p\/w342\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
const BACKDROP_URL = /^https:\/\/image\.tmdb\.org\/t\/p\/w780\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
const LOGO_URL = /^https:\/\/image\.tmdb\.org\/t\/p\/w300\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
const PLAY_ITEM_ID = /^[0-9a-f]{32}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;

function object(value: unknown, path: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DecodeError(path);
  return value as Fields;
}

/** An own property only, so nothing on Object.prototype can stand in for a missing field. */
function field(record: Fields, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function text(value: unknown, path: string, limits: Text = {}): string {
  if (typeof value !== 'string') throw new DecodeError(path);
  const length = [...value].length;
  if (length < (limits.min ?? 0) || length > (limits.max ?? Infinity) || (limits.pattern && !limits.pattern.test(value))) {
    throw new DecodeError(path);
  }
  return value;
}

function string(record: Fields, key: string, path: string, limits: Text = {}): string {
  return text(field(record, key), `${path}.${key}`, limits);
}

/** An image URL: a string or null, and null too when it is not on `pattern`, the field's own allowlist. */
function image(record: Fields, key: string, path: string, pattern: RegExp): string | null {
  if (field(record, key) === null) return null;
  const url = string(record, key, path);
  return pattern.test(url) ? url : null;
}

function inRange(value: number, range: Range): boolean {
  return value >= range.min && value <= (range.max ?? Infinity);
}

function integer(record: Fields, key: string, path: string, range: Range): number {
  const value = field(record, key);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || !inRange(value, range)) throw new DecodeError(`${path}.${key}`);
  return value;
}

function nullableInteger(record: Fields, key: string, path: string, range: Range): number | null {
  return field(record, key) === null ? null : integer(record, key, path, range);
}

function nullableNumber(record: Fields, key: string, path: string, range: Range): number | null {
  const value = field(record, key);
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !inRange(value, range)) throw new DecodeError(`${path}.${key}`);
  return value;
}

function boolean(record: Fields, key: string, path: string): boolean {
  const value = field(record, key);
  if (typeof value !== 'boolean') throw new DecodeError(`${path}.${key}`);
  return value;
}

/** An array of at most `maxItems` (the schema's), each item decoded by `item`. */
function array<T>(record: Fields, key: string, path: string, item: (value: unknown, path: string) => T, maxItems = Infinity): T[] {
  const value = field(record, key);
  if (!Array.isArray(value) || value.length > maxItems) throw new DecodeError(`${path}.${key}`);
  return value.map((entry, index) => item(entry, `${path}.${key}[${index}]`));
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : undefined;
}

function state(record: Fields, path: string): HouseholdState {
  const value = field(record, 'state');
  if (typeof value !== 'string') throw new DecodeError(`${path}.state`);
  return oneOf(HOUSEHOLD_STATES, value) ?? 'unavailable';
}

function coarseStatus(record: Fields, path: string): CoarseStatus {
  const value = field(record, 'status');
  if (typeof value !== 'string') throw new DecodeError(`${path}.status`);
  return oneOf(COARSE_STATUSES, value) ?? 'requested';
}

function mediaType(record: Fields, path: string): MediaType {
  const value = oneOf(MEDIA_TYPES, field(record, 'mediaType'));
  if (!value) throw new DecodeError(`${path}.mediaType`);
  return value;
}

/**
 * The Play link, kept only for a title in the library and only when it is exactly the household's own. A Play that
 * is not an object of two strings is not the documented shape; one that points anywhere else is ignored.
 */
function play(record: Fields, path: string, titleState: HouseholdState, context: DecodeContext): Play | null {
  const value = field(record, 'play');
  if (value === null) return null;
  const fields = object(value, `${path}.play`);
  const itemId = string(fields, 'itemId', `${path}.play`);
  string(fields, 'url', `${path}.play`);
  const url = titleState === 'in_library' && PLAY_ITEM_ID.test(itemId) ? safePlayUrl(fields, context.origin) : undefined;
  return url ? { itemId, url } : null;
}

function genre(value: unknown, path: string): string {
  return text(value, path, { min: 1, max: 100 });
}

export function decodeMe(value: unknown): Me {
  const record = object(value, '$');
  const revision = field(record, 'apiVersion');
  return {
    name: string(record, 'name', '$'),
    household: string(record, 'household', '$'),
    // Missing before the server sent it: revision 0. Sent, it is 1 or more.
    apiVersion: revision === undefined ? 0 : integer(record, 'apiVersion', '$', { min: 1 }),
  };
}

function card(record: Fields, path: string, context: DecodeContext, tmdbId: Range): Card {
  const titleState = state(record, path);
  return {
    mediaType: mediaType(record, path),
    tmdbId: integer(record, 'tmdbId', path, tmdbId),
    title: string(record, 'title', path, { max: 300 }),
    year: nullableInteger(record, 'year', path, { min: 0, max: 9999 }),
    overview: string(record, 'overview', path, { max: 4000 }),
    posterUrl: image(record, 'posterUrl', path, POSTER_URL),
    backdropUrl: image(record, 'backdropUrl', path, BACKDROP_URL),
    rating: nullableNumber(record, 'rating', path, { min: 0, max: 10 }),
    state: titleState,
    play: play(record, path, titleState, context),
  };
}

export function decodeCard(value: unknown, path: string, context: DecodeContext): Card {
  return card(object(value, path), path, context, CARD_TMDB_ID);
}

export function decodePage(value: unknown, context: DecodeContext): Page {
  const record = object(value, '$');
  return {
    page: integer(record, 'page', '$', { min: 1, max: 500 }),
    nextPage: nullableInteger(record, 'nextPage', '$', { min: 2, max: 500 }),
    results: array(record, 'results', '$', (entry, path) => decodeCard(entry, path, context)),
  };
}

function withMediaType<T extends MediaType>(decoded: Card, expected: T): Card & { mediaType: T } {
  if (decoded.mediaType !== expected) throw new DecodeError('$.mediaType');
  return decoded as Card & { mediaType: T };
}

export function decodeMovie(value: unknown, context: DecodeContext): Movie {
  const record = object(value, '$');
  return {
    ...withMediaType(card(record, '$', context, PATH_TMDB_ID), 'movie'),
    genres: array(record, 'genres', '$', genre, 20),
    runtime: nullableInteger(record, 'runtime', '$', { min: 1 }),
  };
}

function decodeSeasonSummary(value: unknown, path: string): SeasonSummary {
  const record = object(value, path);
  return {
    seasonNumber: integer(record, 'seasonNumber', path, { min: 0 }),
    name: string(record, 'name', path, { max: 200 }),
    episodeCount: nullableInteger(record, 'episodeCount', path, { min: 0 }),
    state: state(record, path),
  };
}

export function decodeSeries(value: unknown, context: DecodeContext): Series {
  const record = object(value, '$');
  return {
    ...withMediaType(card(record, '$', context, PATH_TMDB_ID), 'tv'),
    genres: array(record, 'genres', '$', genre, 20),
    runtime: nullableInteger(record, 'runtime', '$', { min: 1 }),
    seasons: array(record, 'seasons', '$', decodeSeasonSummary, 200),
  };
}

function decodeEpisode(value: unknown, path: string): Episode {
  const record = object(value, path);
  return {
    episodeNumber: integer(record, 'episodeNumber', path, { min: 0 }),
    name: string(record, 'name', path, { max: 200 }),
    overview: string(record, 'overview', path, { max: 4000 }),
  };
}

export function decodeSeason(value: unknown): Season {
  const record = object(value, '$');
  return {
    tmdbId: integer(record, 'tmdbId', '$', PATH_TMDB_ID),
    seasonNumber: integer(record, 'seasonNumber', '$', { min: 0, max: 999 }),
    name: string(record, 'name', '$', { max: 200 }),
    overview: string(record, 'overview', '$', { max: 4000 }),
    episodes: array(record, 'episodes', '$', decodeEpisode, 500),
    state: state(record, '$'),
  };
}

function decodeSource(value: unknown, path: string): Source {
  const record = object(value, path);
  return {
    id: integer(record, 'id', path, { min: 1 }),
    name: string(record, 'name', path, { min: 1 }),
    logoUrl: image(record, 'logoUrl', path, LOGO_URL),
  };
}

function decodeNetwork(value: unknown, path: string): Network {
  return { ...decodeSource(value, path), hasFilms: boolean(object(value, path), 'hasFilms', path) };
}

export function decodeSources(value: unknown): Sources {
  const record = object(value, '$');
  return {
    networks: array(record, 'networks', '$', decodeNetwork),
    studios: array(record, 'studios', '$', decodeSource),
  };
}

function decodeRequestSeason(value: unknown, path: string): RequestSeason {
  const record = object(value, path);
  return { seasonNumber: integer(record, 'seasonNumber', path, { min: 1, max: 999 }), status: coarseStatus(record, path) };
}

function decodeRequest(value: unknown, path: string): Request {
  const record = object(value, path);
  return {
    id: string(record, 'id', path, { pattern: REQUEST_ID }),
    mediaType: mediaType(record, path),
    tmdbId: integer(record, 'tmdbId', path, PATH_TMDB_ID),
    status: coarseStatus(record, path),
    seasons: array(record, 'seasons', path, decodeRequestSeason),
    byYou: boolean(record, 'byYou', path),
  };
}

export function decodeRequests(value: unknown): Requests {
  return { results: array(object(value, '$'), 'results', '$', decodeRequest) };
}

export function decodeAccepted(value: unknown): Accepted {
  if (field(object(value, '$'), 'status') !== 'accepted') throw new DecodeError('$.status');
  return { status: 'accepted' };
}
