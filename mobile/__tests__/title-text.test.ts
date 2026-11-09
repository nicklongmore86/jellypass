// The title pages stay the PWA's: Get this and its outcomes, the notes beside a status and the seasons' words, read
// from app/src/render.ts; the facts under a title built the same way; and a title page's address read strictly.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Movie, Series } from '../src/api/types';
import { routeNumber } from '../src/title/route';
import { CANCEL_TEXT, cancelErrorText } from '../src/requests/text';
import { episodesText, episodeTitle, GET_THIS_TEXT, getThisError, getThisErrorText, lengthText, rateLimitedText, runtimeText, seasonName, SEASONS_TEXT, STATE_NOTES } from '../src/title/text';
import { movieAnswer, seriesAnswer } from './support/title';

const render = readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'render.ts'), 'utf8');
const inPwa = (text: string) => render.includes(JSON.stringify(text)) || render.includes(`'${text}'`);

describe("the title pages' words", () => {
  it.each([...Object.values(GET_THIS_TEXT), ...Object.values(STATE_NOTES), ...Object.values(SEASONS_TEXT)])('has %j word for word as the PWA', (text) => {
    expect(inPwa(text)).toBe(true);
  });

  it('says the same confirmation whatever happened, and maps every failure to the PWA\'s three', () => {
    expect(['too_many_requests', 'network', 'unavailable', 'not_found', 'invalid_request', 'unexpected'].map((kind) => getThisError(kind as never))).toEqual([
      'rate_limited',
      'offline',
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
  });
});

describe('too many tries', () => {
  it('says how long to wait in whole minutes, rounded up, one minute singular', () => {
    expect([1, 59, 60, 61, 120, 121, 599, 600, 3600].map((seconds) => rateLimitedText(seconds, 'fallback'))).toEqual([
      'Too many tries. Try again in 1 minute.',
      'Too many tries. Try again in 1 minute.',
      'Too many tries. Try again in 1 minute.',
      'Too many tries. Try again in 2 minutes.',
      'Too many tries. Try again in 2 minutes.',
      'Too many tries. Try again in 3 minutes.',
      'Too many tries. Try again in 10 minutes.',
      'Too many tries. Try again in 10 minutes.',
      'Too many tries. Try again in 60 minutes.',
    ]);
  });

  it('keeps the fixed words when the server did not say (an older server), or said nothing usable', () => {
    for (const seconds of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(rateLimitedText(seconds, GET_THIS_TEXT.rate_limited)).toBe(GET_THIS_TEXT.rate_limited);
    expect(getThisErrorText('rate_limited', undefined)).toBe(GET_THIS_TEXT.rate_limited);
    expect(cancelErrorText('rate_limited', undefined)).toBe(CANCEL_TEXT.rate_limited);
    expect(getThisErrorText('rate_limited', 200)).toBe('Too many tries. Try again in 4 minutes.');
    expect(cancelErrorText('rate_limited', 200)).toBe('Too many tries. Try again in 4 minutes.');
    // The wait is only for too many tries.
    expect(getThisErrorText('offline', 200)).toBe(GET_THIS_TEXT.offline);
    expect(cancelErrorText('unavailable', 200)).toBe(CANCEL_TEXT.unavailable);
  });

  it('is word for word the PWA\'s', () => {
    expect(render).toContain("return `Too many tries. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;");
    expect(render).toContain('const minutes = Math.ceil(retryAfterSeconds / 60);');
  });
});

describe('the facts', () => {
  it('give a run time as the PWA does', () => {
    expect([null, 0, 45, 60, 118].map(runtimeText)).toEqual(['', '', '45 min', '1 h', '1 h 58 min']);
  });

  it('count a series\' seasons without its specials, and a film by its run time', () => {
    expect(lengthText(seriesAnswer(1, ['get_this', 'get_this']) as unknown as Series)).toBe('2 seasons');
    expect(lengthText(seriesAnswer(1, ['get_this']) as unknown as Series)).toBe('1 season');
    expect(lengthText(movieAnswer(1) as unknown as Movie)).toBe('1 h 58 min');
  });

  it('name seasons and episodes that have no name', () => {
    expect([episodesText(null), episodesText(1), episodesText(8)]).toEqual(['', '1 episode', '8 episodes']);
    expect([seasonName('', 3), seasonName('Finale', 3)]).toEqual(['Season 3', 'Finale']);
    expect([episodeTitle(2, ''), episodeTitle(1, 'Pilot')]).toEqual(['2. Episode 2', '1. Pilot']);
  });
});

describe("a title page's address", () => {
  it.each([
    ['7', 1, 7],
    ['2147483647', 1, 2147483647],
    ['0', 0, 0],
    ['0', 1, undefined],
    ['07', 1, undefined],
    ['1e3', 1, undefined],
    ['-1', 1, undefined],
    ['', 1, undefined],
    [['1', '2'], 1, undefined],
    [undefined, 1, undefined],
  ] as const)('reads %j (from %d) as %j', (param, min, expected) => {
    expect(routeNumber(param as string | string[] | undefined, min)).toBe(expected);
  });
});
