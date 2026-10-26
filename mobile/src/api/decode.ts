// Lenient decoding of the API's answers, as docs/app-design.md ("Native clients (contract)") asks: fields the app does
// not know are ignored (only the named fields are copied, nothing is spread), an unknown `state` is `unavailable`, an
// unknown request `status` is `requested`, and an image or Play URL that is not on the allowlist (urls.ts) is null.
// Anything else that is not the documented shape (a missing field, a wrong type) is a DecodeError, which the client
// turns into the `unexpected` error kind.

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
import { safeImageUrl, safeLogoUrl, safePlayUrl } from './urls';

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

function object(value: unknown, path: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DecodeError(path);
  return value as Fields;
}

/** An own property only, so nothing on Object.prototype can stand in for a missing field. */
function field(record: Fields, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function string(record: Fields, key: string, path: string): string {
  const value = field(record, key);
  if (typeof value !== 'string') throw new DecodeError(`${path}.${key}`);
  return value;
}

function integer(record: Fields, key: string, path: string, min: number): number {
  const value = field(record, key);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new DecodeError(`${path}.${key}`);
  return value;
}

function nullableInteger(record: Fields, key: string, path: string, min: number): number | null {
  return field(record, key) === null ? null : integer(record, key, path, min);
}

function nullableNumber(record: Fields, key: string, path: string): number | null {
  const value = field(record, key);
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DecodeError(`${path}.${key}`);
  return value;
}

function boolean(record: Fields, key: string, path: string): boolean {
  const value = field(record, key);
  if (typeof value !== 'boolean') throw new DecodeError(`${path}.${key}`);
  return value;
}

function array<T>(record: Fields, key: string, path: string, item: (value: unknown, path: string) => T): T[] {
  const value = field(record, key);
  if (!Array.isArray(value)) throw new DecodeError(`${path}.${key}`);
  return value.map((entry, index) => item(entry, `${path}.${key}[${index}]`));
}

/** A URL field the allowlist decides: an allowlisted URL, or null for null and anything else. */
function allowlisted(record: Fields, key: string, path: string, safe: (url: unknown) => string | undefined): string | null {
  const value = field(record, key);
  if (value !== null && typeof value !== 'string') throw new DecodeError(`${path}.${key}`);
  return safe(value) ?? null;
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

/** The Play link, kept only for a title in the library and only when it is exactly the household's own. */
function play(record: Fields, path: string, titleState: HouseholdState, context: DecodeContext): Play | null {
  const value = field(record, 'play');
  if (value === null) return null;
  const fields = object(value, `${path}.play`);
  const url = titleState === 'in_library' ? safePlayUrl(fields, context.origin) : undefined;
  return url ? { itemId: fields['itemId'] as string, url } : null;
}

function genre(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new DecodeError(path);
  return value;
}

export function decodeMe(value: unknown): Me {
  const record = object(value, '$');
  const revision = field(record, 'apiVersion');
  return {
    name: string(record, 'name', '$'),
    household: string(record, 'household', '$'),
    // Missing before the server sent it: revision 0.
    apiVersion: revision === undefined ? 0 : integer(record, 'apiVersion', '$', 0),
  };
}

export function decodeCard(value: unknown, path: string, context: DecodeContext): Card {
  const record = object(value, path);
  const titleState = state(record, path);
  return {
    mediaType: mediaType(record, path),
    tmdbId: integer(record, 'tmdbId', path, 1),
    title: string(record, 'title', path),
    year: nullableInteger(record, 'year', path, 0),
    overview: string(record, 'overview', path),
    posterUrl: allowlisted(record, 'posterUrl', path, safeImageUrl),
    backdropUrl: allowlisted(record, 'backdropUrl', path, safeImageUrl),
    rating: nullableNumber(record, 'rating', path),
    state: titleState,
    play: play(record, path, titleState, context),
  };
}

export function decodePage(value: unknown, context: DecodeContext): Page {
  const record = object(value, '$');
  return {
    page: integer(record, 'page', '$', 1),
    nextPage: nullableInteger(record, 'nextPage', '$', 2),
    results: array(record, 'results', '$', (entry, path) => decodeCard(entry, path, context)),
  };
}

function withMediaType<T extends MediaType>(card: Card, expected: T): Card & { mediaType: T } {
  if (card.mediaType !== expected) throw new DecodeError('$.mediaType');
  return card as Card & { mediaType: T };
}

export function decodeMovie(value: unknown, context: DecodeContext): Movie {
  const record = object(value, '$');
  return {
    ...withMediaType(decodeCard(record, '$', context), 'movie'),
    genres: array(record, 'genres', '$', genre),
    runtime: nullableInteger(record, 'runtime', '$', 0),
  };
}

function decodeSeasonSummary(value: unknown, path: string): SeasonSummary {
  const record = object(value, path);
  return {
    seasonNumber: integer(record, 'seasonNumber', path, 0),
    name: string(record, 'name', path),
    episodeCount: nullableInteger(record, 'episodeCount', path, 0),
    state: state(record, path),
  };
}

export function decodeSeries(value: unknown, context: DecodeContext): Series {
  const record = object(value, '$');
  return {
    ...withMediaType(decodeCard(record, '$', context), 'tv'),
    genres: array(record, 'genres', '$', genre),
    runtime: nullableInteger(record, 'runtime', '$', 0),
    seasons: array(record, 'seasons', '$', decodeSeasonSummary),
  };
}

function decodeEpisode(value: unknown, path: string): Episode {
  const record = object(value, path);
  return {
    episodeNumber: integer(record, 'episodeNumber', path, 0),
    name: string(record, 'name', path),
    overview: string(record, 'overview', path),
  };
}

export function decodeSeason(value: unknown): Season {
  const record = object(value, '$');
  return {
    tmdbId: integer(record, 'tmdbId', '$', 1),
    seasonNumber: integer(record, 'seasonNumber', '$', 0),
    name: string(record, 'name', '$'),
    overview: string(record, 'overview', '$'),
    episodes: array(record, 'episodes', '$', decodeEpisode),
    state: state(record, '$'),
  };
}

function decodeSource(value: unknown, path: string): Source {
  const record = object(value, path);
  return {
    id: integer(record, 'id', path, 1),
    name: string(record, 'name', path),
    logoUrl: allowlisted(record, 'logoUrl', path, safeLogoUrl),
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
  return { seasonNumber: integer(record, 'seasonNumber', path, 0), status: coarseStatus(record, path) };
}

function decodeRequest(value: unknown, path: string): Request {
  const record = object(value, path);
  return {
    id: string(record, 'id', path),
    mediaType: mediaType(record, path),
    tmdbId: integer(record, 'tmdbId', path, 1),
    status: coarseStatus(record, path),
    seasons: array(record, 'seasons', path, decodeRequestSeason),
    byYou: boolean(record, 'byYou', path),
  };
}

export function decodeRequests(value: unknown): Requests {
  return { results: array(object(value, '$'), 'results', '$', decodeRequest) };
}

/** "Get this"'s fixed answer. The client never reads it to tell what happened; the contract tests decode it. */
export function decodeAccepted(value: unknown): Accepted {
  if (field(object(value, '$'), 'status') !== 'accepted') throw new DecodeError('$.status');
  return { status: 'accepted' };
}
