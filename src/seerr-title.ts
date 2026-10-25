import type { SeerrTitleRecord } from './seerr.js';

/**
 * Decodes and shapes a Seerr title answer (GET /api/v1/movie/:id or /api/v1/tv/:id) into a {@link SeerrTitleRecord}.
 * It runs in the title worker (src/seerr-title-worker.ts), off the event loop: the answer carries every household's
 * records on the title, so parsing it on the main thread would hold up every other answer for as long as those records
 * take to parse. Throws on a body that is not UTF-8 JSON (without quoting it).
 */
export function parseTitleAnswer(bytes: Uint8Array): SeerrTitleRecord {
  let answer: unknown;
  try {
    answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('invalid JSON');
  }
  const media = ownField(answer, 'mediaInfo');
  const requests = ownField(media, 'requests');
  // A movie's TMDB title and release date, or a series' name and first air date (Seerr copies them from TMDB).
  const names = [...new Set(['title', 'originalTitle', 'name', 'originalName']
    .map((name) => ownField(answer, name))
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0 && name.length <= 500))];
  const date = ownField(answer, 'releaseDate') ?? ownField(answer, 'firstAirDate');
  const year = typeof date === 'string' && /^[0-9]{4}-/.test(date) ? Number(date.slice(0, 4)) : undefined;
  return {
    names,
    ...optional('year', year),
    ...optional('mediaId', positiveSafeInteger(ownField(media, 'id'))),
    ...optional('jellyfinMediaId', jellyfinItemId(ownField(media, 'jellyfinMediaId'))),
    ...optional('jellyfinMediaId4k', jellyfinItemId(ownField(media, 'jellyfinMediaId4k'))),
    requests: (Array.isArray(requests) ? requests : []).flatMap((request) => {
      const requestId = positiveSafeInteger(ownField(request, 'id'));
      const status = positiveSafeInteger(ownField(request, 'status'));
      if (requestId === undefined || status === undefined) return [];
      const seasons = ownField(request, 'seasons');
      const requester = ownField(ownField(request, 'requestedBy'), 'jellyfinUserId');
      const createdAt = ownField(request, 'createdAt');
      const created = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
      return [{
        id: String(requestId),
        status,
        is4k: ownField(request, 'is4k') === true,
        seasons: (Array.isArray(seasons) ? seasons : []).flatMap((season) => {
          const number = positiveSafeInteger(ownField(season, 'seasonNumber'));
          return number === undefined ? [] : [number];
        }),
        ...optional('requesterJellyfinId', typeof requester === 'string' ? jellyfinItemId(requester) : undefined),
        ...optional('createdAt', Number.isFinite(created) ? created : undefined),
      }];
    }),
  };
}

/** One own property of a JSON object, or undefined; never anything inherited. */
function ownField(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, name)) return undefined;
  return (value as Record<string, unknown>)[name];
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A Jellyfin ID (item or user) as Seerr stores it, normalized to 32 lowercase hex digits, or undefined. */
function jellyfinItemId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value.replace(/-/g, '')) ? value.replace(/-/g, '').toLowerCase() : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>;
}
