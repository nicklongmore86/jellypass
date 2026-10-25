import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SeerrError, TitleParser } from '../dist/seerr.js';

/** A Seerr title answer with `count` requests, as bytes. */
function answer(count = 1) {
  const requests = Array.from({ length: count }, (_, index) => ({
    id: index + 1, status: 2, is4k: false, seasons: [], requestedBy: { jellyfinUserId: 'a'.repeat(32), email: 'x'.repeat(200) },
  }));
  return new TextEncoder().encode(JSON.stringify({ title: 'Synthetic Movie One', releaseDate: '2020-05-01', mediaInfo: { id: 7, requests } }));
}

const limits = { maxJobs: 32, maxQueuedBytes: 1024 * 1024 * 1024, timeoutMs: 15_000 };
const refused = (status) => (error) => error instanceof SeerrError && error.status === status;

describe('Seerr title worker', { timeout: 60_000 }, () => {
  it('parses a title answer off the event loop', async () => {
    const parser = new TitleParser(limits);
    const record = await parser.parse(answer(2), '/api/v1/movie/:id');
    assert.deepEqual([record.names, record.year, record.mediaId, record.requests.map((request) => request.id)], [['Synthetic Movie One'], 2020, 7, ['1', '2']]);
    await parser.close();
  });

  it('refuses answers past its queue of jobs, and takes more once one is done', async () => {
    const parser = new TitleParser({ ...limits, maxJobs: 1 });
    const first = parser.parse(answer(20_000), '/api/v1/movie/:id');
    await assert.rejects(parser.parse(answer(), '/api/v1/movie/:id'), refused(503));
    assert.equal((await first).requests.length, 20_000);
    assert.equal((await parser.parse(answer(), '/api/v1/movie/:id')).requests.length, 1);
    await parser.close();
  });

  it('refuses an answer that would take the bytes queued past their cap', async () => {
    const big = answer(1000);
    const parser = new TitleParser({ ...limits, maxQueuedBytes: big.byteLength + 10 });
    const first = parser.parse(big, '/api/v1/movie/:id');
    await assert.rejects(parser.parse(answer(1000), '/api/v1/movie/:id'), refused(503));
    await first;
    // The bytes are given back once parsed.
    await parser.parse(answer(1000), '/api/v1/movie/:id');
    await parser.close();
  });

  it('stops a parse that takes too long, failing what was queued, and starts a new worker for the next one', async () => {
    const settings = { ...limits, timeoutMs: 1 };
    const parser = new TitleParser(settings);
    const slow = [parser.parse(answer(50_000), '/api/v1/movie/:id'), parser.parse(answer(), '/api/v1/movie/:id')];
    await Promise.all(slow.map((parse) => assert.rejects(parse, (error) => refused(502)(error) && /took too long/.test(error.message))));
    // The parser reads its limits as they are now.
    settings.timeoutMs = 15_000;
    assert.equal((await parser.parse(answer(), '/api/v1/movie/:id')).requests.length, 1);
    await parser.close();
  });

  it('fails what is queued when it is closed at shutdown, and refuses anything after', async () => {
    const parser = new TitleParser(limits);
    const queued = assert.rejects(parser.parse(answer(20_000), '/api/v1/movie/:id'), refused(502));
    await parser.close();
    await queued;
    await assert.rejects(parser.parse(answer(), '/api/v1/movie/:id'), refused(503));
  });
});
