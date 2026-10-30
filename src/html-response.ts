import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';
import { brotliCompressSync, constants, createBrotliCompress, createGzip, gzipSync } from 'node:zlib';

/**
 * Every HTML page JellyPass serves or relays is marked `Cache-Control: no-transform`, so a CDN in front of it (such as
 * Cloudflare Web Analytics' automatic setup) adds no script to it: the household app, the admin UI and the gateway
 * promise no analytics. A CDN that honours no-transform also stops compressing the page, so JellyPass compresses it
 * itself (br or gzip, as the client accepts) unless it is already encoded. Nothing but HTML is touched, so the CDN keeps
 * compressing scripts, styles, JSON and media as before.
 */

export type HtmlCoding = 'br' | 'gzip';

/** Brotli at quality 5: close to gzip's speed, still smaller. The pages are tens of kilobytes at most. */
const BROTLI_OPTIONS = { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } };
/** Headers that describe only the unencoded body, dropped when JellyPass encodes it. */
const IDENTITY_ONLY_HEADERS = ['content-length', 'accept-ranges', 'content-md5', 'digest'];
/** A 406's body. */
const NOT_ACCEPTABLE = Buffer.from('Not Acceptable: this page is sent br, gzip or unencoded.\n');
/** A static page's encoded bodies, by its bytes: worked out once each. */
const ENCODED = new WeakMap<Buffer, Partial<Record<HtmlCoding, Buffer>>>();

export function isHtml(contentType: OutgoingHttpHeaders[string]): boolean {
  return /^\s*text\/html\s*(?:;|$)/i.test(joined(contentType));
}

/** `value` with `no-transform` added, its other directives as they were; `no-transform` alone if there were none. */
export function withNoTransform(value: OutgoingHttpHeaders[string]): string {
  const directives = joined(value).replace(/^[\s,]+|[\s,]+$/g, '');
  if (!directives) return 'no-transform';
  return hasToken(directives, 'no-transform') ? directives : `${directives}, no-transform`;
}

/** A Vary header with `Accept-Encoding` added, unless it is already there or the header is `*`. */
export function withVaryAcceptEncoding(value: OutgoingHttpHeaders[string]): string {
  const names = joined(value).replace(/^[\s,]+|[\s,]+$/g, '');
  if (!names) return 'Accept-Encoding';
  return hasToken(names, 'accept-encoding') || hasToken(names, '*') ? names : `${names}, Accept-Encoding`;
}

/**
 * The coding the client prefers of those JellyPass offers (br, then gzip on a tie), from its Accept-Encoding; `identity`
 * if it accepts neither but takes the page unencoded (which it does unless it refuses `identity` itself, or `*` without
 * naming `identity`); undefined if it accepts nothing JellyPass can send.
 */
export function negotiatedCoding(acceptEncoding: string | string[] | undefined): HtmlCoding | 'identity' | undefined {
  const weights = new Map<string, number>();
  for (const part of joined(acceptEncoding).split(',')) {
    const [name = '', ...parameters] = part.split(';');
    const coding = name.trim().toLowerCase();
    if (!coding) continue;
    let weight = 1;
    for (const parameter of parameters) {
      const q = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(parameter);
      if (q) weight = Number(q[1]) || 0;
    }
    weights.set(coding, weight);
  }
  const weight = (coding: string) => weights.get(coding) ?? weights.get('*') ?? 0;
  const br = weight('br');
  const gzip = weights.get('gzip') ?? weights.get('x-gzip') ?? weight('gzip');
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return (weights.get('identity') ?? weights.get('*') ?? 1) > 0 ? 'identity' : undefined;
}

/**
 * An If-None-Match as JellyPass forwards it to Jellyfin: every weak tag in its strong form. If-None-Match compares tags
 * weakly anyway, but Jellyfin compares them exactly, so the weak tag JellyPass gives a page it encodes (see
 * {@link htmlAnswer}) would otherwise never match, and the page would never be revalidated.
 */
export function strongIfNoneMatch(value: string | string[] | undefined): string | undefined {
  const tags = entityTags(value);
  return tags.length ? [...new Set(tags.map((tag) => tag.replace(/^W\//, '')))].join(', ') : value === undefined ? undefined : joined(value);
}

/**
 * The headers an answer is sent with, and the coding JellyPass encodes its body with: anything but HTML unchanged and
 * unencoded; HTML marked no-transform and varying on Accept-Encoding, and encoded when it has a body (`hasBody`: a HEAD
 * counts the body its GET would have, so both are negotiated alike) that is whole (not a range), not already encoded,
 * and the client accepts a coding. A successful page the client accepts no coding of at all, not even unencoded, is
 * `refused`: it is answered with a 406 instead (see {@link writeNotAcceptable}). A 304 is marked like the page it
 * revalidates, and when that page was one JellyPass encoded (the client asked with the weak tag JellyPass gave it, and
 * Jellyfin answered with the strong one), it carries that weak tag again.
 */
export function htmlAnswer(
  request: IncomingMessage,
  status: number,
  headers: OutgoingHttpHeaders,
  hasBody: boolean,
): { headers: OutgoingHttpHeaders; coding?: HtmlCoding; refused?: true } {
  const result: OutgoingHttpHeaders = { ...headers };
  if (status === 304) return { headers: notModified(request, result) };
  if (!isHtml(header(result, 'content-type'))) return { headers: result };
  result['Cache-Control'] = withNoTransform(take(result, 'cache-control'));
  result.Vary = withVaryAcceptEncoding(take(result, 'vary'));
  const encoding = joined(header(result, 'content-encoding')).toLowerCase();
  const whole = status >= 200 && status !== 204 && status !== 206 && header(result, 'content-range') === undefined;
  if (!hasBody || !whole || (encoding && encoding !== 'identity')) return { headers: result };
  const coding = negotiatedCoding(request.headers['accept-encoding']);
  if (coding === undefined) return status < 300 ? { headers: result, refused: true } : { headers: result };
  if (coding === 'identity') return { headers: result };
  for (const name of IDENTITY_ONLY_HEADERS) take(result, name);
  take(result, 'content-encoding');
  result['Content-Encoding'] = coding;
  // The ETag named the unencoded bytes: a weak one still names the page, as nginx's gzip does.
  const etag = take(result, 'etag');
  if (typeof etag === 'string') result.ETag = etag.startsWith('W/') ? etag : `W/${etag}`;
  return { headers: result, coding };
}

/**
 * Answers a request for a page the client accepts no coding of, not even unencoded, with a 406: never stored, and the
 * same short text whatever the page was.
 */
export function writeNotAcceptable(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(406, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(NOT_ACCEPTABLE.length),
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : NOT_ACCEPTABLE);
}

/** Sends a whole answer, HTML marked and encoded as {@link htmlAnswer} says; anything else exactly as given. */
export function writeWhole(request: IncomingMessage, response: ServerResponse, status: number, headers: OutgoingHttpHeaders, body: Buffer): void {
  // A HEAD's body is the GET's when JellyPass has it (its own pages, or Jellyfin web's page asked as a GET), else empty:
  // either way it is negotiated as its GET would be, with the encoded length only when it is known.
  const head = request.method === 'HEAD';
  const answer = htmlAnswer(request, status, headers, head || body.length > 0);
  if (answer.refused) return writeNotAcceptable(request, response);
  const sent = answer.coding && body.length > 0 ? encoded(body, answer.coding) : body;
  if (answer.coding) {
    take(answer.headers, 'transfer-encoding');
    if (sent.length > 0) answer.headers['Content-Length'] = String(sent.length);
  }
  response.writeHead(status, answer.headers);
  response.end(head ? undefined : sent);
}

/**
 * Writes the head of a streamed answer (HTML marked as {@link htmlAnswer} says) and returns where its body is to be
 * written: the response itself, or an encoder that writes to it; undefined if the answer is already sent (a 406, see
 * {@link htmlAnswer}). A HEAD is negotiated as its GET would be, so it gets the GET's headers (without a length, which
 * an encoded body has only once it is written). An encoder that fails ends the response, and one is never left behind
 * when the response closes early.
 */
export function writeStreamedHead(request: IncomingMessage, response: ServerResponse, status: number, headers: OutgoingHttpHeaders): Writable | undefined {
  const answer = htmlAnswer(request, status, headers, true);
  if (answer.refused) {
    writeNotAcceptable(request, response);
    return undefined;
  }
  response.writeHead(status, answer.headers);
  if (!answer.coding || request.method === 'HEAD') return response;
  const encoder = answer.coding === 'br' ? createBrotliCompress(BROTLI_OPTIONS) : createGzip();
  encoder.once('error', () => response.destroy());
  response.once('close', () => encoder.destroy());
  encoder.pipe(response);
  return encoder;
}

function encoded(body: Buffer, coding: HtmlCoding): Buffer {
  let codings = ENCODED.get(body);
  if (!codings) ENCODED.set(body, codings = {});
  return codings[coding] ??= coding === 'br' ? brotliCompressSync(body, BROTLI_OPTIONS) : gzipSync(body);
}

/** A 304's headers: marked as {@link htmlAnswer} says. Cache-Control is only changed, never added, as a 304's replaces the stored one. */
function notModified(request: IncomingMessage, headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const etag = header(headers, 'etag');
  const weakened = typeof etag === 'string' && !etag.startsWith('W/') && entityTags(request.headers['if-none-match']).includes(`W/${etag}`);
  if (!weakened && !isHtml(header(headers, 'content-type'))) return headers;
  const cacheControl = take(headers, 'cache-control');
  if (cacheControl !== undefined) headers['Cache-Control'] = withNoTransform(cacheControl);
  headers.Vary = withVaryAcceptEncoding(take(headers, 'vary'));
  if (weakened) {
    take(headers, 'etag');
    headers.ETag = `W/${etag}`;
  }
  return headers;
}

/** The entity tags in an If-None-Match (or `*`), as written. */
function entityTags(value: string | string[] | undefined): string[] {
  return joined(value).match(/(?:W\/)?"[^"]*"|\*/g) ?? [];
}

function joined(value: OutgoingHttpHeaders[string]): string {
  return (Array.isArray(value) ? value.join(', ') : value === undefined ? '' : String(value)).trim();
}

function hasToken(list: string, token: string): boolean {
  return list.split(',').some((part) => part.trim().split(/[\s=;]/, 1)[0]?.toLowerCase() === token);
}

/** The value of header `name` in `headers`, whatever its spelling. */
function header(headers: OutgoingHttpHeaders, name: string): OutgoingHttpHeaders[string] {
  const key = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/** Removes header `name` from `headers`, whatever its spelling (every spelling), and returns its value. */
function take(headers: OutgoingHttpHeaders, name: string): OutgoingHttpHeaders[string] {
  let value: OutgoingHttpHeaders[string];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue;
    value ??= headers[key];
    delete headers[key];
  }
  return value;
}
