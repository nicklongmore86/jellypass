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

/** The coding the client prefers of those JellyPass offers (br, then gzip on a tie), from its Accept-Encoding. */
export function negotiatedCoding(acceptEncoding: string | string[] | undefined): HtmlCoding | undefined {
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
  return gzip > 0 ? 'gzip' : undefined;
}

/**
 * The headers an answer is sent with, and the coding JellyPass encodes its body with: anything but HTML unchanged and
 * unencoded; HTML marked no-transform and varying on Accept-Encoding, and encoded when it has a body that is whole
 * (not a range), not already encoded, and the client accepts a coding.
 */
export function htmlAnswer(
  request: IncomingMessage,
  status: number,
  headers: OutgoingHttpHeaders,
  hasBody: boolean,
): { headers: OutgoingHttpHeaders; coding?: HtmlCoding } {
  const result: OutgoingHttpHeaders = { ...headers };
  if (!isHtml(header(result, 'content-type'))) return { headers: result };
  result['Cache-Control'] = withNoTransform(take(result, 'cache-control'));
  result.Vary = withVaryAcceptEncoding(take(result, 'vary'));
  const encoding = joined(header(result, 'content-encoding')).toLowerCase();
  const whole = status >= 200 && status !== 204 && status !== 206 && status !== 304 && header(result, 'content-range') === undefined;
  const coding = hasBody && whole && (!encoding || encoding === 'identity') ? negotiatedCoding(request.headers['accept-encoding']) : undefined;
  if (!coding) return { headers: result };
  for (const name of IDENTITY_ONLY_HEADERS) take(result, name);
  take(result, 'content-encoding');
  result['Content-Encoding'] = coding;
  // The ETag named the unencoded bytes: a weak one still names the page, as nginx's gzip does.
  const etag = take(result, 'etag');
  if (typeof etag === 'string') result.ETag = etag.startsWith('W/') ? etag : `W/${etag}`;
  return { headers: result, coding };
}

/** Sends a whole answer, HTML marked and encoded as {@link htmlAnswer} says; anything else exactly as given. */
export function writeWhole(request: IncomingMessage, response: ServerResponse, status: number, headers: OutgoingHttpHeaders, body: Buffer): void {
  const answer = htmlAnswer(request, status, headers, body.length > 0);
  const sent = answer.coding ? encoded(body, answer.coding) : body;
  if (answer.coding) {
    take(answer.headers, 'transfer-encoding');
    answer.headers['Content-Length'] = String(sent.length);
  }
  response.writeHead(status, answer.headers);
  response.end(request.method === 'HEAD' ? undefined : sent);
}

/**
 * Writes the head of a streamed answer (HTML marked as {@link htmlAnswer} says) and returns where its body is to be
 * written: the response itself, or an encoder that writes to it. An encoder that fails ends the response, and one is
 * never left behind when the response closes early.
 */
export function writeStreamedHead(request: IncomingMessage, response: ServerResponse, status: number, headers: OutgoingHttpHeaders): Writable {
  const answer = htmlAnswer(request, status, headers, request.method !== 'HEAD');
  response.writeHead(status, answer.headers);
  if (!answer.coding) return response;
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
