import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SEERR_FIXTURES, assertNoCanaries, findCanaries, seerrFixture } from './support/seerr-fixtures.mjs';

const USER_OBJECTS = new Set(['requestedBy', 'modifiedBy', 'createdBy', 'user']);
const USER_FIELDS = ['id', 'email', 'username', 'jellyfinUsername', 'plexUsername', 'displayName', 'jellyfinUserId', 'avatar', 'createdAt', 'requestCount'];
/** Fields of Seerr's own records (media, requests, seasons, issues, watchlist entries, users) that are user-ish. */
const SEERR_FIELDS = new Set([
  ...USER_FIELDS, 'updatedAt', 'avatarETag', 'avatarVersion', 'lastSeasonChange', 'mediaAddedAt', 'jellyfinMediaId',
  'jellyfinMediaId4k', 'serviceId', 'externalServiceId', 'externalServiceSlug', 'serverId', 'profileId', 'rootFolder',
  'message', 'downloadId', 'externalId', 'estimatedCompletionTime', 'size', 'sizeLeft',
]);
/** Paging totals: they count Seerr records, not only those the caller may see. */
const TOTALS = new Set(['pages', 'results', 'totalPages', 'totalResults']);

/**
 * Every place a fixture holds user-ish data, as [JSON path, value]: each such field of a Seerr record (anything under
 * `mediaInfo` or `media`, and the top-level results of the request and watchlist lists), every field of a user object
 * whether set or not, a download's title, and the paging totals.
 */
function userish(value, path, inRecord = false, found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => userish(entry, `${path}[${index}]`, inRecord, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value)) {
    const at = `${path}.${key}`;
    if (inRecord && SEERR_FIELDS.has(key) && entry !== null) found.push([at, entry]);
    if (inRecord && key === 'title' && /downloadStatus(4k)?\[\d+\]$/.test(path)) found.push([at, entry]);
    if (inRecord && USER_OBJECTS.has(key) && entry) for (const field of USER_FIELDS) found.push([`${at}.${field}`, entry[field]]);
    if (TOTALS.has(key) && typeof entry === 'number' && (path.endsWith('.pageInfo') || !path.includes('.'))) found.push([at, entry]);
    const record = inRecord || key === 'mediaInfo' || key === 'media' ||
      (key === 'results' && /^(requests|watchlist)$/.test(path));
    userish(entry, at, record, found);
  }
  return found;
}

describe('Seerr 3.5.1 fixtures', () => {
  it('plant a canary in every user-ish field', () => {
    let checked = 0;
    for (const name of SEERR_FIXTURES) {
      for (const [path, value] of userish(seerrFixture(name), name)) {
        checked += 1;
        assert.notEqual(value, undefined, `${path} is missing`);
        assert.ok(findCanaries(JSON.stringify(value)).length > 0, `${path} holds ${JSON.stringify(value)}, not a canary`);
      }
    }
    assert.ok(checked > 150, `only ${checked} user-ish fields checked`);
  });

  it('include the leak channels the app must not relay', () => {
    const movie = seerrFixture('movie');
    const tv = seerrFixture('tv');
    // Another household's request on a title, with the owner as modifier; issues with their text.
    assert.match(movie.mediaInfo.requests[0].requestedBy.displayName, /Canary Otherhousehold/);
    assert.match(movie.mediaInfo.requests[0].modifiedBy.displayName, /Canary Owner/);
    assert.match(movie.mediaInfo.issues[0].comments[0].message, /canary/);
    assert.equal(tv.mediaInfo.requests.length, 2);
    // A foreign Jellyfin item ID and a download in progress for someone else.
    assert.match(seerrFixture('search').results[0].mediaInfo.jellyfinMediaId, /^c0ffee00c0ffee00/);
    assert.ok(seerrFixture('search').results[1].mediaInfo.downloadStatus.length > 0);
    // Request paging totals that count more than the caller can see.
    assert.match(String(seerrFixture('requests').pageInfo.results), /^73\d{5}$/);
  });

  it('hold only synthetic data: no real hosts, no addresses outside the documentation ranges', () => {
    for (const name of SEERR_FIXTURES) {
      const text = JSON.stringify(seerrFixture(name));
      for (const url of text.match(/https?:\/\/[^"/]+/g) ?? []) {
        assert.match(url, /\.example\.invalid$|^https:\/\/www\.(youtube\.com|themoviedb\.org)$/, `${name}: ${url}`);
      }
      for (const address of text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []) {
        assert.match(address, /^(192\.0\.2|198\.51\.100|203\.0\.113)\./, `${name}: ${address}`);
      }
      assert.doesNotMatch(text, /@(?!example\.invalid")/, name);
    }
  });

  it('are caught by assertNoCanaries in any form, and clean text passes', () => {
    for (const name of SEERR_FIXTURES.filter((fixture) => !['season', 'quota'].includes(fixture))) {
      assert.throws(() => assertNoCanaries(JSON.stringify(seerrFixture(name))), assert.AssertionError, name);
    }
    for (const leaked of [
      '{"name":"CANARY OTHERHOUSEHOLD"}',
      '{"jellyfinUserId":"c0ffee00-c0ff-ee00-0000-000000000002"}',
      '{"total":7300042}',
      'X-Total-Count: 7300042',
      '{"requestedAt":"2001-03-03T02:02:02.002Z"}',
    ]) {
      assert.throws(() => assertNoCanaries(leaked), assert.AssertionError, leaked);
    }
    assertNoCanaries(JSON.stringify({ title: 'Synthetic Movie One', tmdbId: 900001, year: 2020, total: 73000001, status: 'requested' }));
    assertNoCanaries(JSON.stringify(seerrFixture('season')));
    assertNoCanaries(JSON.stringify(seerrFixture('quota')));
  });
});
