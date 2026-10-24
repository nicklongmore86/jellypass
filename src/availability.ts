import type { AvailabilityEpisode, AvailabilityJournal, AvailabilityTitle, JellyfinItem, MediaQuality } from './types.js';

/**
 * How long the journal keeps history (see AvailabilityJournal): a title deleted from Jellyfin is remembered for this
 * long after a full sync last saw it, so a request made while it was there is still judged late, and one made after it
 * was deleted (a re-request) is judged new. A request made longer ago than this is judged as JellyPass 2.2.1 did.
 */
export const AVAILABILITY_RETENTION_DAYS = 400;
/** Seerr (3.5.x) counts a video wider than this as 4K. */
const SEERR_4K_MIN_WIDTH = 2000;

/** The journal title of a Jellyfin movie or series: its TMDB ID when Jellyfin has one, otherwise its own ID. */
export function titleId(item: { tmdbId?: number; itemId: string }): string {
  return item.tmdbId !== undefined ? `tmdb-${item.tmdbId}` : `item-${item.itemId.trim().toLowerCase()}`;
}

export function movieKey(title: string, quality: MediaQuality): string {
  return `movie:${title}:${quality}`;
}

export function seasonKey(title: string, quality: MediaQuality, seasonNumber: number): string {
  return `tv:${title}:${quality}:s${seasonNumber}`;
}

/**
 * The qualities Seerr would link an item to. A video wider than 2000 pixels counts as both: Seerr links it as the HD
 * item when 4K is not enabled for its server, and JellyPass cannot tell whether it is. An item with more than one
 * version counts as both too, since only one version's width is known. Either way a request may be judged late when
 * it was new, which leaves the title public: never the other way round.
 */
export function itemQualities(item: JellyfinItem): MediaQuality[] {
  const widths = [
    item.Width,
    ...(item.MediaSources ?? []).flatMap((source) => (source.MediaStreams ?? [])
      .filter((stream) => stream.Type === 'Video')
      .map((stream) => stream.Width)),
  ];
  const versions = item.MediaSources?.length || item.MediaSourceCount || 1;
  return versions > 1 || widths.some((width) => (width ?? 0) > SEERR_4K_MIN_WIDTH) ? ['hd', '4k'] : ['hd'];
}

export function tmdbIdOf(item: JellyfinItem): number | undefined {
  const entry = Object.entries(item.ProviderIds ?? {}).find(([name]) => name.toLowerCase() === 'tmdb')?.[1];
  const tmdbId = typeof entry === 'string' && /^\d{1,10}$/.test(entry.trim()) ? Number(entry.trim()) : undefined;
  return tmdbId !== undefined && tmdbId > 0 ? tmdbId : undefined;
}

/** A Jellyfin movie or series as a journal title, or undefined for any other item. */
export function availabilityTitle(item: JellyfinItem): AvailabilityTitle | undefined {
  if (item.Type !== 'Movie' && item.Type !== 'Series') return undefined;
  const tmdbId = tmdbIdOf(item);
  return {
    mediaType: item.Type === 'Movie' ? 'movie' : 'tv',
    itemId: item.Id,
    ...(tmdbId !== undefined ? { tmdbId } : {}),
    qualities: itemQualities(item),
  };
}

/** A Jellyfin episode on disk as a journal episode, or undefined for a missing (virtual) one or one without a season. */
export function availabilityEpisode(item: JellyfinItem): AvailabilityEpisode | undefined {
  if (item.Type !== 'Episode' || item.LocationType === 'Virtual' || !item.SeriesId) return undefined;
  if (!Number.isInteger(item.ParentIndexNumber)) return undefined;
  return { seriesId: item.SeriesId, seasonNumber: item.ParentIndexNumber as number, qualities: itemQualities(item) };
}

/**
 * Counts per journal key: each movie in each of its qualities, and each episode of a series in `titles` in each of its
 * qualities, by season. Episodes of a series that is not in `titles` are not counted.
 */
export function countAvailability(titles: AvailabilityTitle[], episodes: AvailabilityEpisode[]): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const series = new Map<string, string>();
  for (const title of titles) {
    if (title.mediaType === 'movie') title.qualities.forEach((quality) => add(movieKey(titleId(title), quality)));
    else series.set(title.itemId.trim().toLowerCase(), titleId(title));
  }
  for (const episode of episodes) {
    const title = series.get(episode.seriesId.trim().toLowerCase());
    if (title) episode.qualities.forEach((quality) => add(seasonKey(title, quality, episode.seasonNumber)));
  }
  return counts;
}

/**
 * The count a key had just before `time` (0 before its first change): a change recorded at `time` itself is not
 * counted, since what was seen then may have arrived after something else that happened then.
 */
export function countAt(journal: AvailabilityJournal, key: string, time: number): number {
  let count = 0;
  for (const [at, value] of journal.titles[key] ?? []) {
    if (Date.parse(at) >= time) break;
    count = value;
  }
  return count;
}

export function latestCount(journal: AvailabilityJournal, key: string): number {
  return journal.titles[key]?.at(-1)?.[1] ?? 0;
}

/** Appends a change, or replaces the last one if it has the same time; drops a change that repeats the count. */
export function recordChange(journal: AvailabilityJournal, key: string, at: string, count: number): boolean {
  if (latestCount(journal, key) === count) return false;
  const history = [...journal.titles[key] ?? []];
  if (history.at(-1)?.[0] === at) history.pop();
  if ((history.at(-1)?.[1] ?? 0) !== count || history.length === 0) history.push([at, count]);
  if (history.length > 0) journal.titles[key] = history;
  else delete journal.titles[key];
  return true;
}

/**
 * Drops history older than the retention period, keeping the change in force at its start, and every key that has
 * counted nothing since then. Moves `since` forward to that start, since earlier times can no longer be judged.
 */
export function pruneJournal(journal: AvailabilityJournal, now: Date): void {
  const cutoff = now.getTime() - AVAILABILITY_RETENTION_DAYS * 86_400_000;
  if (Date.parse(journal.since) < cutoff) journal.since = new Date(cutoff).toISOString();
  for (const [key, history] of Object.entries(journal.titles)) {
    const kept = history.filter(([at], index) => index === history.length - 1 || Date.parse(at) >= cutoff
      || Date.parse(history[index + 1]?.[0] as string) > cutoff);
    if (kept.length === 1 && kept[0]?.[1] === 0 && Date.parse(kept[0][0]) <= cutoff) delete journal.titles[key];
    else if (kept.length !== history.length) journal.titles[key] = kept;
  }
}
