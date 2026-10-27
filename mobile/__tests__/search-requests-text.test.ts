// Search and My requests stay the PWA's: their words, read from app/src/render.ts and app/src/main.ts, the search's
// pause, query length and page sizes, the grid's columns at the stylesheet's widths (app/static/app.css), and the
// small helpers that build an entry's text and its accessible name.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Request } from '../src/api/types';
import {
  kindText,
  REQUEST_TITLE_CALLS,
  requestMeta,
  requestName,
  requestNoteHere,
  requestPills,
  REQUESTS_PER_PAGE,
  REQUESTS_TEXT,
  requestSeasonName,
  requestSeasonsText,
  requestTitleText,
  whoText,
} from '../src/requests/text';
import {
  GRID_GAP,
  gridCardWidth,
  gridColumns,
  MAX_QUERY_LENGTH,
  MIN_TABLET_CARD,
  MORE_TEXT,
  NARROW_WIDTH,
  noResultsText,
  SEARCH_DEBOUNCE_MS,
  SEARCH_TEXT,
  searchQuery,
  TABLET_WIDTH,
} from '../src/search/text';

const PWA = path.join(__dirname, '..', '..', 'app');
const render = readFileSync(path.join(PWA, 'src', 'render.ts'), 'utf8');
const main = readFileSync(path.join(PWA, 'src', 'main.ts'), 'utf8');
const css = readFileSync(path.join(PWA, 'static', 'app.css'), 'utf8');
const inPwa = (text: string) => [render, main].some((source) => source.includes(JSON.stringify(text)) || source.includes(`'${text}'`));

describe("Search's and My requests' words", () => {
  it.each([...Object.values(SEARCH_TEXT), ...Object.values(MORE_TEXT), ...Object.values(REQUESTS_TEXT)])('has %j word for word as the PWA', (text) => {
    expect(inPwa(text)).toBe(true);
  });

  it('says no results as the PWA does, with the query in curly quotes', () => {
    expect(render).toContain('`No results for “${query}”.`');
    expect(noResultsText('dune')).toBe('No results for “dune”.');
  });

  it("names a request's season, its kind and who asked as the PWA does", () => {
    expect(render).toContain('`Season ${season.seasonNumber}`');
    expect(render).toContain("entry.mediaType === 'tv' ? 'Series' : 'Movie'");
    expect([requestSeasonName(3), kindText('tv'), kindText('movie')]).toEqual(['Season 3', 'Series', 'Movie']);
    expect([whoText({ byYou: true }), whoText({ byYou: false })]).toEqual([REQUESTS_TEXT.byYou, REQUESTS_TEXT.byOther]);
  });

  it("says a series request's seasons, and where its status pills go, as the PWA does", () => {
    // The PWA's requestSeasonsText() and requestPills(), line for line.
    for (const line of [
      'if (sorted.length === 1) return `Season ${sorted[0]}`;',
      'if (end - start >= 2) parts.push(`${sorted[start]}–${sorted[end]}`);',
      'return `Seasons ${parts.join(\', \')}`;',
      'if (shared.size === 1) return { status: entry.seasons[0]?.status, seasonsText: requestSeasonsText(entry.seasons.map((season) => season.seasonNumber)), perSeason: false };',
      "return { status: undefined, seasonsText: '', perSeason: true };",
      "const noteHere = pills.status ? pills.status === 'failed' : entry.status === 'failed' && !entry.seasons.some((season) => season.status === 'failed');",
      "const kind = [entry.mediaType === 'tv' ? 'Series' : 'Movie', pills.seasonsText].filter(Boolean).join(' · ');",
    ]) {
      expect({ line, inPwa: render.includes(line) }).toEqual({ line, inPwa: true });
    }
    expect([requestSeasonsText([1]), requestSeasonsText([1, 2]), requestSeasonsText([3, 1, 2]), requestSeasonsText([1, 3]), requestSeasonsText([5, 1, 2, 3, 7, 8])]).toEqual([
      'Season 1',
      'Seasons 1, 2',
      'Seasons 1–3',
      'Seasons 1, 3',
      'Seasons 1–3, 5, 7, 8',
    ]);
    expect(requestPills({ status: 'ready', seasons: [] })).toEqual({ status: 'ready', seasonsText: '', perSeason: false });
    expect(requestPills({ status: 'requested', seasons: [{ seasonNumber: 2, status: 'requested' }] })).toEqual({ status: 'requested', seasonsText: 'Season 2', perSeason: false });
    expect(requestPills({ status: 'requested', seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 2, status: 'failed' }] })).toEqual({
      status: undefined,
      seasonsText: '',
      perSeason: true,
    });
  });

  it("puts a series request's status where the PWA does at the edges", () => {
    // The seasons' shared status is the pill, not the request's own overall status.
    expect(requestPills({ status: 'requested', seasons: [1, 2].map((seasonNumber) => ({ seasonNumber, status: 'ready' as const })) })).toEqual({
      status: 'ready',
      seasonsText: 'Seasons 1, 2',
      perSeason: false,
    });
    expect(requestPills({ status: 'failed', seasons: [{ seasonNumber: 4, status: 'requested' }] })).toEqual({ status: 'requested', seasonsText: 'Season 4', perSeason: false });
    // A season listed twice is said once; listed twice with two statuses, each keeps its pill.
    expect(requestSeasonsText([2, 1, 2, 1])).toBe('Seasons 1, 2');
    expect(requestPills({ status: 'ready', seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 1, status: 'ready' }] })).toEqual({
      status: 'ready',
      seasonsText: 'Season 1',
      perSeason: false,
    });
    expect(requestPills({ status: 'ready', seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 1, status: 'failed' }] }).perSeason).toBe(true);
    // Season 0 (specials) is a season like any other.
    expect([requestSeasonsText([0]), requestSeasonsText([0, 1, 2]), requestSeasonsText([0, 2])]).toEqual(['Season 0', 'Seasons 0–2', 'Seasons 0, 2']);
    // A long list stays one line of runs.
    const many = Array.from({ length: 40 }, (_, index) => index + 1);
    expect(requestSeasonsText(many)).toBe('Seasons 1–40');
    expect(requestSeasonsText(many.filter((number) => number % 10 !== 0))).toBe('Seasons 1–9, 11–19, 21–29, 31–39');
    expect(requestPills({ status: 'ready', seasons: many.map((seasonNumber) => ({ seasonNumber, status: 'ready' as const })) }).seasonsText).toBe('Seasons 1–40');
  });
});

describe("Search's sizes", () => {
  it('pauses, caps the query and pages as the PWA', () => {
    expect(main).toContain(`SEARCH_DEBOUNCE_MS = ${SEARCH_DEBOUNCE_MS};`);
    expect(main).toContain(`MAX_QUERY_LENGTH = ${MAX_QUERY_LENGTH};`);
    expect(main).toContain(`REQUESTS_PER_PAGE = ${REQUESTS_PER_PAGE};`);
    expect(main).toContain(`REQUEST_TITLE_CALLS = ${REQUEST_TITLE_CALLS};`);
  });

  it('trims the query and keeps at most 100 characters; blank searches for nothing', () => {
    expect(searchQuery('  dune  ')).toBe('dune');
    expect(searchQuery('   ')).toBe('');
    expect(searchQuery('x'.repeat(150))).toHaveLength(MAX_QUERY_LENGTH);
  });

  it("lays the grid out at the stylesheet's widths: 3 columns, 2 below 21rem, as many of 10rem as fit from 48rem", () => {
    expect(css).toContain('grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem 0.6rem;');
    expect(css).toContain('@media (max-width: 21rem)');
    expect(css).toContain('grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr))');
    expect([NARROW_WIDTH, TABLET_WIDTH, MIN_TABLET_CARD, GRID_GAP.row, GRID_GAP.column]).toEqual([21 * 16, 48 * 16, 10 * 16, 16, 0.6 * 16]);
    expect([320, 336, 337, 390, 767].map((width) => gridColumns(width, width - 32))).toEqual([2, 2, 3, 3, 3]);
    expect([768, 1024, 1366].map((width) => gridColumns(width, Math.min(width, 1152) - 32))).toEqual([4, 5, 6]);
    expect(gridCardWidth(358, 3)).toBe(Math.floor((358 - 2 * 9.6) / 3));
  });
});

describe("a request's text", () => {
  const series: Request = {
    id: 'a',
    mediaType: 'tv',
    tmdbId: 9,
    status: 'requested',
    seasons: [
      { seasonNumber: 1, status: 'ready' },
      { seasonNumber: 2, status: 'failed' },
    ],
    byYou: true,
  };
  const film: Request = { id: 'b', mediaType: 'movie', tmdbId: 7, status: 'ready', seasons: [], byYou: false };
  const named = { status: 'loaded', title: { title: 'Dune', year: 2021, posterUrl: null } } as const;

  it('says the title once it is read, "Loading title…" until then and "Title unavailable" if it cannot be', () => {
    expect([requestTitleText(undefined), requestTitleText({ status: 'loading' }), requestTitleText({ status: 'missing' }), requestTitleText(named)]).toEqual([
      'Loading title…',
      'Loading title…',
      'Title unavailable',
      'Dune',
    ]);
    expect([requestMeta('movie', named), requestMeta('tv', { status: 'loading' })]).toEqual(['2021 · Movie', 'Series']);
  });

  it('names an entry with everything it shows, each status once, and the admin note only where something failed', () => {
    expect(requestName(film, named)).toBe('Dune, 2021 · Movie, Ready to watch, Asked for by someone in your household');
    // Seasons that differ: each with its status, none for the entry, the note after the one that failed.
    expect(requestName(series, { status: 'missing' })).toBe(
      "Title unavailable, Series, Asked for by you, Season 1: Ready to watch, Season 2: We couldn't get this, Ask your JellyPass admin to try again.",
    );
    expect(requestName({ ...series, seasons: [{ seasonNumber: 2, status: 'failed' }, { seasonNumber: 3, status: 'requested' }] }, named)).toBe(
      "Dune, 2021 · Series, Asked for by you, Season 2: We couldn't get this, Ask your JellyPass admin to try again., Season 3: Requested",
    );
    // One season, or seasons sharing one status: on the meta line, one status.
    const show = { status: 'loaded', title: { title: 'Show', year: 2027, posterUrl: null } } as const;
    expect(requestName({ ...series, seasons: [{ seasonNumber: 1, status: 'requested' }] }, show)).toBe('Show, 2027 · Series · Season 1, Requested, Asked for by you');
    expect(requestName({ ...series, status: 'ready', seasons: [1, 2, 3].map((seasonNumber) => ({ seasonNumber, status: 'ready' as const })) }, show)).toBe(
      'Show, 2027 · Series · Seasons 1–3, Ready to watch, Asked for by you',
    );
    expect(requestName({ ...series, status: 'failed', seasons: [1, 3].map((seasonNumber) => ({ seasonNumber, status: 'failed' as const })) }, { status: 'loading' })).toBe(
      "Loading title…, Series · Seasons 1, 3, We couldn't get this, Asked for by you, Ask your JellyPass admin to try again.",
    );
    expect(requestMeta('tv', show, 'Season 1')).toBe('2027 · Series · Season 1');
    expect([requestNoteHere(film), requestNoteHere(series), requestNoteHere({ status: 'failed', seasons: [] })]).toEqual([false, false, true]);
  });
});
