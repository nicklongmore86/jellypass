// Home stays the PWA's: its words (status words, filters, hero controls, row and error wording, the JustWatch credit),
// its rows per filter in order with their kind and whether they are fetched at once, and each service's waterline,
// read from app/src/render.ts and app/src/main.ts. Also the small helpers that build a card's text and name.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { HOME_LAYOUT, NETWORK_ACCENTS, type HomeRow } from '../src/home/layout';
import {
  backdropMeta,
  cardName,
  EMPTY_ROW_TEXT,
  ERROR_TEXT,
  errorText,
  HERO_TEXT,
  HOME_FILTERS,
  HOME_TEXT,
  posterMeta,
  REQUEST_LABELS,
  RETRY_TEXT,
  networkLinkName,
  shortOverview,
  SOURCE_TEXT,
  sourceHeading,
  studioLinkName,
  BADGE_WORDS,
  badgeWord,
  STATE_LABELS,
  stateLabel,
} from '../src/home/text';

const read = (file: string) => readFileSync(path.join(__dirname, '..', '..', 'app', 'src', file), 'utf8');
const render = read('render.ts');
const main = read('main.ts');

/** Whether the PWA's source has `text` as a string literal. */
const inPwa = (source: string, text: string) => source.includes(JSON.stringify(text)) || source.includes(`'${text}'`);

describe("Home's words", () => {
  it.each([
    ...Object.values(STATE_LABELS),
    ...Object.values(REQUEST_LABELS),
    ...Object.values(ERROR_TEXT).flatMap((text) => [text.title, text.body]),
    ...Object.values(HOME_TEXT.filters),
    ...Object.values(HOME_TEXT.shown),
    HOME_TEXT.label,
    ...Object.values(HERO_TEXT.labels),
    HERO_TEXT.previous,
    HERO_TEXT.next,
    ...Object.values(SOURCE_TEXT.networkPrefix),
    SOURCE_TEXT.studios,
    SOURCE_TEXT.justWatch,
    ...Object.values(SOURCE_TEXT.lists),
    SOURCE_TEXT.listsLabel,
    EMPTY_ROW_TEXT,
    RETRY_TEXT,
  ])('has %j word for word as the PWA', (text) => {
    expect(inPwa(render, text)).toBe(true);
  });

  it('has the five status words, and an unknown state reads as "Can\'t request"', () => {
    expect(new Set([...Object.values(STATE_LABELS), ...Object.values(REQUEST_LABELS)]).size).toBe(5);
    expect(stateLabel('surprise' as never)).toBe("Can't request");
  });

  it('maps every failure to the PWA\'s wording', () => {
    expect(errorText('app_access_disabled')).toBe('app_access_disabled');
    expect(ERROR_TEXT.app_access_disabled.body).toContain('administrator');
    expect(['too_many_requests', 'network', 'not_found', 'unavailable', 'unexpected', 'invalid_request'].map((kind) => errorText(kind as never))).toEqual([
      'rate_limited',
      'offline',
      'not_found',
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
  });
});

describe('the network and studio pages', () => {
  it("heads a page as the PWA's SOURCE_TEXT.heading does", () => {
    expect([sourceHeading('studio', 'Pixar'), sourceHeading('network', 'Netflix'), sourceHeading('network', 'Netflix', 'series'), sourceHeading('network', 'Netflix', 'films')]).toEqual([
      'Pixar movies',
      'Popular on Netflix',
      'Series on Netflix',
      'Films on Netflix',
    ]);
    expect(render).toContain('return `${name} movies`;');
  });

  it("names Home's links to them", () => {
    expect([studioLinkName('Pixar'), networkLinkName('Popular on', 'Netflix')]).toEqual(['Pixar, studio', 'See all Popular on Netflix']);
  });
});

describe("Home's layout", () => {
  it.each(HOME_FILTERS)('under %s has the PWA\'s rows, in order, each fetched at once or lazily as there', (filter) => {
    const block = new RegExp(`\\n  ${filter}: \\[([\\s\\S]*?)\\n  \\],`).exec(main.slice(main.indexOf('const HOME_LAYOUT')));
    expect(block).not.toBeNull();
    const pwa = [...block![1]!.matchAll(/row\('([a-z-]+)', '([^']+)', '(poster|backdrop)', (true|false)\)|\{ part: '([a-z]+)' \}/g)].map((match) =>
      match[5] ? match[5] : `${match[1]} ${match[2]} ${match[3]} ${match[4]}`,
    );
    const ours = HOME_LAYOUT[filter].map((part) => (part.part === 'row' ? `${(part as HomeRow).list} ${part.heading} ${part.variant} ${part.eager}` : part.part));
    expect(ours).toEqual(pwa);
  });

  it('has no all-time rows', () => {
    const lists = HOME_FILTERS.flatMap((filter) => HOME_LAYOUT[filter].filter((part): part is HomeRow => part.part === 'row').map((part) => part.list));
    expect(lists.filter((list) => list.startsWith('top-'))).toEqual([]);
  });

  it("gives each service the PWA's waterline", () => {
    const pwa = /NETWORK_ACCENTS[^=]*= \{([^}]*)\}/.exec(render)![1]!;
    expect(Object.fromEntries([...pwa.matchAll(/(\d+): '([a-z]+)'/g)].map((match) => [Number(match[1]), match[2]]))).toEqual(NETWORK_ACCENTS);
  });
});

describe('card text', () => {
  const card = { title: 'Dune', year: 2021, rating: 7.84, state: 'in_library', mediaType: 'movie' } as const;

  it('says "year · Movie/Series" under a poster and "year · ★ rating TMDB" under a big card', () => {
    expect(posterMeta(card)).toBe('2021 · Movie');
    expect(posterMeta({ year: null, mediaType: 'tv' })).toBe('Series');
    expect(backdropMeta(card)).toBe('2021 · ★ 7.8 TMDB');
    expect(backdropMeta({ year: null, rating: null })).toBe('');
  });

  it('names a card by title, year and rating, then its status', () => {
    expect(cardName(card)).toBe('Dune, 2021, TMDB rating 7.8 out of 10, Ready to watch');
    expect(cardName(card, true)).toBe('Dune, 2021, Movie, TMDB rating 7.8 out of 10, Ready to watch');
    expect(cardName({ ...card, year: null, rating: null, state: 'get_this' })).toBe('Dune, Available to get');
  });

  it('cuts a long overview at a word, and leaves a short one alone', () => {
    expect(shortOverview('  Short.  ')).toBe('Short.');
    const long = `${'word '.repeat(60)}end`;
    const cut = shortOverview(long);
    expect(cut.length).toBeLessThanOrEqual(161);
    expect(cut.endsWith('word…')).toBe(true);
  });
});

describe('the short words shared with the TV add-on', () => {
  const tv = readFileSync(path.join(__dirname, '..', '..', 'tv', 'src', 'discover-model.ts'), 'utf8');

  it.each([...Object.values(BADGE_WORDS), HOME_TEXT.hide.label, HOME_TEXT.hide.name])('has %j as the TV add-on has it', (text) => {
    expect(tv).toContain(JSON.stringify(text).replace(/^"|"$/g, '') );
  });

  it('keeps each badge word short and different from the full wording, and an unknown state reads as "Can\'t get"', () => {
    expect(BADGE_WORDS).toEqual({ in_library: 'In library', requested: 'Requested', get_this: 'Get this', unavailable: "Can't get" });
    for (const [state, word] of Object.entries(BADGE_WORDS)) {
      expect(word.length).toBeLessThanOrEqual(10);
      if (state !== 'requested') expect(word).not.toBe(STATE_LABELS[state as keyof typeof STATE_LABELS]);
    }
    expect(badgeWord('surprise' as never)).toBe("Can't get");
  });

  it('names the New only chip for a screen reader by what it does', () => {
    expect([HOME_TEXT.hide.label, HOME_TEXT.hide.name]).toEqual(['New only', "New only: show only titles you don't have or haven't requested"]);
  });
});
