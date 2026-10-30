// A household's address: the one thing that says which household the app talks to. The server decides the household
// from the Host header alone, so the app keeps exactly one origin per sign-in and builds every URL from it. There is
// no list of households anywhere: a member gives the app their own address. Any HTTPS name works: the app has no
// naming rule of its own (1.2.1 and earlier took only `https://jelly-<household>.<domain>`).
//
// Parsed by hand rather than with URL: React Native's URL (react-native/Libraries/Blob/URL.js) is a few regular
// expressions over the string as given. It validates nothing, does not lower-case or IDNA-map the host, keeps
// `:443`, and reads `hostname` up to the first `:`, so it would take what a browser refuses and the other way round.

/** A household address: `https://<host>[:<port>]`, lower case, no default port, path, query or credentials. */
export interface HouseholdAddress {
  /** `https://<host>` or `https://<host>:<port>`, with no trailing slash and never `:443`. */
  readonly origin: string;
  /** The host as the member sees it, with the port when there is one (`films.example.net:8443`). */
  readonly host: string;
}

/**
 * Why an address was refused, for the address screen's message:
 * - `http`: an `http://` address (the app only connects over HTTPS);
 * - `local`: an IP address or a `.local` name, which the app does not connect to (see mobile/README.md);
 * - `unicode`: a name with non-ASCII letters, which the app takes only in its `xn--` form;
 * - `extra`: a name, password, path, query or fragment around the address;
 * - `invalid`: anything else.
 */
export type AddressProblem = 'http' | 'local' | 'unicode' | 'extra' | 'invalid';

export type AddressReading = { readonly address: HouseholdAddress } | { readonly problem: AddressProblem };

/** One DNS label: letters, digits and inner hyphens, at most 63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOST_LENGTH = 253;
/** What a paste from notes or chat leaves around an address: ASCII space, tab, CR and LF at either end, and nothing else. */
const PASTE_ENDS = /^[ \t\r\n]+|[ \t\r\n]+$/g;
/**
 * Whitespace, control and invisible characters, anywhere (the ends included, once PASTE_ENDS is gone): C0 and C1
 * controls, DEL, every Unicode space (U+00A0, U+2028, U+2029, U+FEFF among them), zero-width characters and the
 * bidirectional marks, embeddings, overrides and isolates (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069).
 */
const BLANK_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
/** The last label of an IPv4 address in any form a resolver takes (`10.0.0.1`, `0x7f.1`, `2130706433`). */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;

/**
 * Reads `input` as a household address: `https://` only, a DNS name of at least two labels, an optional port from 1
 * to 65535 (`:443` is dropped), and nothing after the host but an optional `/`. Only ASCII space, tab, CR and LF are
 * ignored, and only at the ends (trimPasteEnds); any other control or invisible character is refused wherever it is.
 * A non-ASCII character is refused before anything is lower-cased, so `K` (U+212A, KELVIN SIGN) never becomes `k`.
 */
export function readHouseholdAddress(input: string): AddressReading {
  const trimmed = trimPasteEnds(input);
  if (BLANK_OR_CONTROL.test(trimmed)) return { problem: 'invalid' };
  if (/[^\x00-\x7f]/.test(trimmed)) return { problem: 'unicode' };
  const scheme = asciiLowerCase(/^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1] ?? '');
  if (scheme === 'http') return { problem: 'http' };
  if (scheme !== 'https') return { problem: 'invalid' };

  const rest = trimmed.slice('https://'.length);
  const end = rest.search(/[/?#\\]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const after = end === -1 ? '' : rest.slice(end);
  if (authority.includes('@')) return { problem: 'extra' };
  if (authority.startsWith('[')) return { problem: 'local' };
  if (after !== '' && after !== '/') return { problem: 'extra' };

  const colon = authority.lastIndexOf(':');
  const name = asciiLowerCase(colon === -1 ? authority : authority.slice(0, colon));
  const port = colon === -1 ? undefined : readPort(authority.slice(colon + 1));
  if (port === null) return { problem: 'invalid' };
  if (name.includes(':')) return { problem: /^[0-9a-f:.]+$/.test(name) ? 'local' : 'invalid' };

  const labels = name.split('.');
  const last = labels[labels.length - 1] ?? '';
  if (NUMERIC_LABEL.test(last) || last === 'local') return { problem: 'local' };
  if (name.length > MAX_HOST_LENGTH || labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return { problem: 'invalid' };
  }

  const host = port === undefined || port === 443 ? name : `${name}:${port}`;
  return { address: Object.freeze({ origin: `https://${host}`, host }) };
}

/** `input` without the ASCII space, tab, CR and LF a paste leaves at its ends (not String.prototype.trim: no Unicode spaces). */
export function trimPasteEnds(input: string): string {
  return input.replace(PASTE_ENDS, '');
}

/** `text` with A to Z lower-cased and every other character as it is (never toLowerCase, which maps beyond ASCII). */
function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/** A port's digits as a number from 1 to 65535, or null for anything else (an empty port included). */
function readPort(digits: string): number | null {
  if (!/^\d{1,5}$/.test(digits)) return null;
  const port = Number(digits);
  return port >= 1 && port <= 65535 ? port : null;
}

/** The household address `input` names, or undefined if it is not one (readHouseholdAddress says why). */
export function parseHouseholdAddress(input: string): HouseholdAddress | undefined {
  const reading = readHouseholdAddress(input);
  return 'address' in reading ? reading.address : undefined;
}
