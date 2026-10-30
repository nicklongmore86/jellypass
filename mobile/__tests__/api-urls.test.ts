// The household address the client is made for, the URLs it lets an answer name (ported from the PWA's tests in
// test/app-pwa.test.mjs), and the two Authorization headers.
import {
  backdropSources,
  parseHouseholdAddress,
  readHouseholdAddress,
  safeImageUrl,
  safeLogoUrl,
  safePlayUrl,
  signInAuthorization,
  tokenAuthorization,
} from '../src/api';

const origin = 'https://media.example.com';
const itemId = '0123456789abcdef0123456789abcdef';

/** Control and invisible characters an address never holds, not even at its ends. */
const INVISIBLE = [
  '\u0000', '\u0001', '\u000b', '\u000c', '\u001b', '\u001f', '\u007f', '\u0080', '\u0085', '\u009f', '\u00a0',
  '\u1680', '\u2000', '\u200a', '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u2028', '\u2029', '\u202a',
  '\u202b', '\u202c', '\u202d', '\u202e', '\u202f', '\u205f', '\u2060', '\u2066', '\u2067', '\u2068', '\u2069',
  '\u3000', '\ufeff',
];
const codeOf = (character: string) => `U+${character.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`;

describe('a household address', () => {
  it.each([
    ['https://media.example.com', 'media.example.com'],
    ['https://media.example.com/', 'media.example.com'],
    ['  HTTPS://Media.Example.COM  ', 'media.example.com'],
    ['https://films.example.net:8443', 'films.example.net:8443'],
    ['https://films.example.net:8443/', 'films.example.net:8443'],
    ['https://media.example.com:443', 'media.example.com'],
    ['https://media.example.com:0443/', 'media.example.com'],
    ['https://media.example.com:1', 'media.example.com:1'],
    ['https://media.example.com:65535', 'media.example.com:65535'],
    ['https://example.com', 'example.com'],
    ['https://a.b.c.example.co.uk', 'a.b.c.example.co.uk'],
    ['https://my-house-2.example.com', 'my-house-2.example.com'],
    ['https://xn--bcher-kva.example', 'xn--bcher-kva.example'],
    [`https://${'a'.repeat(63)}.example.com`, `${'a'.repeat(63)}.example.com`],
    // Neutral example addresses with a household subdomain and the legacy jelly- prefix.
    ['https://grove.example.org', 'grove.example.org'],
    ['https://jelly-household.example.test', 'jelly-household.example.test'],
    // A paste from notes or chat: ASCII space, tab, CR and LF at the ends only.
    ['https://media.example.com\n', 'media.example.com'],
    ['https://media.example.com\r\n', 'media.example.com'],
    ['\thttps://media.example.com', 'media.example.com'],
    [' \r\n\thttps://media.example.com/ \t\r\n', 'media.example.com'],
  ])('takes %j as %s', (input, host) => {
    expect(parseHouseholdAddress(input)).toEqual({ origin: `https://${host}`, host });
    expect(readHouseholdAddress(input)).toEqual({ address: { origin: `https://${host}`, host } });
  });

  it.each([
    ['http://media.example.com', 'http'],
    ['HTTP://media.example.com:8080/', 'http'],
    ['media.example.com', 'invalid'],
    ['//media.example.com', 'invalid'],
    ['ftp://media.example.com', 'invalid'],
    ['jellypass://connect?address=https://media.example.com', 'invalid'],
    ['https:media.example.com', 'invalid'],
    ['https:/media.example.com', 'invalid'],
    ['https://user:pw@media.example.com', 'extra'],
    ['https://user@media.example.com', 'extra'],
    ['https://media.example.com@evil.example.net', 'extra'],
    ['https://media.example.com/jellypass/app/', 'extra'],
    ['https://media.example.com//', 'extra'],
    ['https://media.example.com/?households=all', 'extra'],
    ['https://media.example.com?', 'extra'],
    ['https://media.example.com#x', 'extra'],
    ['https://media.example.com\\evil.example.net', 'extra'],
    ['https://films.example.net:8443/web', 'extra'],
    ['https://media.example.com:', 'invalid'],
    ['https://media.example.com:0', 'invalid'],
    ['https://media.example.com:65536', 'invalid'],
    ['https://media.example.com:100000', 'invalid'],
    ['https://media.example.com:+80', 'invalid'],
    ['https://media.example.com:http', 'invalid'],
    ['https://media.example.com:8443:8443', 'invalid'],
    ['https://media', 'invalid'],
    ['https://localhost', 'invalid'],
    ['https://-media.example.com', 'invalid'],
    ['https://media-.example.com', 'invalid'],
    ['https://me_dia.example.com', 'invalid'],
    ['https://media.example.com.', 'invalid'],
    ['https://media..example.com', 'invalid'],
    ['https://.example.com', 'invalid'],
    ['https://*.example.com', 'invalid'],
    ['https://med ia.example.com', 'invalid'],
    ['https://media\t.example.com', 'invalid'],
    ['https://media.example\u0000.com', 'invalid'],
    ['https://media.example.com\n/', 'invalid'],
    ['https://media.exam\u00adple.com', 'unicode'],
    ['https://bücher.example', 'unicode'],
    ['https://BÜCHER.example', 'unicode'],
    ['https://192.168.1.10', 'local'],
    ['https://192.168.1.10:8920', 'local'],
    ['https://10.0.0.1/', 'local'],
    ['https://0x7f.1', 'local'],
    ['https://2130706433', 'local'],
    ['https://[::1]', 'local'],
    ['https://[2001:db8::1]:8443', 'local'],
    ['https://::1', 'local'],
    ['https://nas.local', 'local'],
    [`https://${'a'.repeat(64)}.example.com`, 'invalid'],
    // Over 253 characters in all.
    [`https://media.${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.test`, 'invalid'],
    ['', 'invalid'],
    ['https://', 'invalid'],
  ])('refuses %j (%s)', (input, problem) => {
    expect(parseHouseholdAddress(input)).toBeUndefined();
    expect(readHouseholdAddress(input)).toEqual({ problem });
  });

  it.each(INVISIBLE.map((character) => [codeOf(character), character]))('refuses %s at the start, the end or in the middle', (_, character) => {
    for (const input of [
      `${character}https://media.example.com`,
      `\n${character}https://media.example.com`,
      `https://media.example.com${character}`,
      `https://media.example.com/${character}\r\n`,
      `https://media.${character}example.com`,
      `https://media.example.com${character}:8443`,
      `htt${character}ps://media.example.com`,
    ]) {
      expect(readHouseholdAddress(input)).toEqual({ problem: 'invalid' });
    }
  });

  it.each([
    // Characters that lower-case or upper-case to ASCII: refused before any case is folded.
    ['https://\u212a.com', 'U+212A KELVIN SIGN'],
    ['https://media.\u212axample.com', 'U+212A KELVIN SIGN'],
    ['https://\u0130mages.example.com', 'U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE'],
    ['https://media.example.co\u017f', 'U+017F LATIN SMALL LETTER LONG S'],
    ['https://med\u0131a.example.com', 'U+0131 LATIN SMALL LETTER DOTLESS I'],
    ['https://\ufb01lms.example.net', 'U+FB01 LATIN SMALL LIGATURE FI'],
    ['https://\u212bngstrom.example.com', 'U+212B ANGSTROM SIGN'],
    ['http\u017f://media.example.com', 'U+017F in the scheme'],
    ['HTTP\u017f://media.example.com', 'U+017F in an upper-case scheme'],
  ])('refuses %j (%s) as unicode', (input) => {
    expect(readHouseholdAddress(input)).toEqual({ problem: 'unicode' });
  });

  it('refuses every character that case-folds to ASCII, wherever it is', () => {
    const folding: string[] = [];
    for (let code = 0x80; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const character = String.fromCharCode(code);
      if (/[a-z]/i.test(character.toLowerCase() + character.toUpperCase())) folding.push(character);
    }
    expect(folding.length).toBeGreaterThan(5);
    for (const character of folding) {
      expect(readHouseholdAddress(`https://media${character}.example.com`)).toEqual({ problem: 'unicode' });
      expect(readHouseholdAddress(`https://media.example.co${character}`)).toEqual({ problem: 'unicode' });
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(parseHouseholdAddress(origin))).toBe(true);
  });

  it('gives an origin that reads back as itself', () => {
    for (const input of ['HTTPS://Films.Example.NET:8443/', 'https://media.example.com:443', 'https://grove.example.org/']) {
      const { origin: canonical } = parseHouseholdAddress(input)!;
      expect(parseHouseholdAddress(canonical)?.origin).toBe(canonical);
    }
  });
});

describe('TMDB images', () => {
  it('accepts posters and backdrops at w342, w780 and w1280 only', () => {
    for (const size of ['w342', 'w780', 'w1280']) {
      const url = `https://image.tmdb.org/t/p/${size}/synthetic-a_B-1.jpg`;
      expect(safeImageUrl(url)).toBe(url);
    }
    for (const bad of ['w500', 'w185', 'w300', 'w1920', 'w12800', 'w128', 'original', 'w1280x', 'W1280', '1280']) {
      expect([bad, safeImageUrl(`https://image.tmdb.org/t/p/${bad}/a.jpg`)]).toEqual([bad, undefined]);
    }
  });

  it.each([
    'https://evil.example.test/p.jpg',
    'http://image.tmdb.org/t/p/w342/a.jpg',
    'https://image.tmdb.org/t/p/original/a.jpg',
    'https://image.tmdb.org/t/p/w342/a.jpg?x=1',
    'https://image.tmdb.org.evil.test/t/p/w342/a.jpg',
    'https://image.tmdb.org/t/p/w1280/a/b.jpg',
    'https://image.tmdb.org/t/p/w1280/a.gif',
    'https://evil.test/t/p/w1280/a.jpg',
    'data:image/png;base64,AAAA',
    'javascript:1',
    '',
    null,
    7,
  ])('refuses %j', (bad) => {
    expect(safeImageUrl(bad)).toBeUndefined();
    expect(safeLogoUrl(bad)).toBeUndefined();
  });

  it('accepts logos at w300 only', () => {
    const logo = 'https://image.tmdb.org/t/p/w300/wwemzKWzjKYJFfCeiB57q3r4Bcm.png';
    expect(safeLogoUrl(logo)).toBe(logo);
    expect(safeLogoUrl('https://image.tmdb.org/t/p/w342/wwemzKWzjKYJFfCeiB57q3r4Bcm.png')).toBeUndefined();
    expect(safeImageUrl(logo)).toBeUndefined();
  });

  it('gives a backdrop its w780 and w1280 copies, and nothing for anything else', () => {
    expect(backdropSources('https://image.tmdb.org/t/p/w780/b_1.jpg')).toEqual({
      small: 'https://image.tmdb.org/t/p/w780/b_1.jpg',
      large: 'https://image.tmdb.org/t/p/w1280/b_1.jpg',
    });
    expect(backdropSources('https://image.tmdb.org/t/p/w1280/b_1.jpg')?.small).toBe('https://image.tmdb.org/t/p/w780/b_1.jpg');
    expect(backdropSources('https://image.tmdb.org/t/p/w342/b_1.jpg')).toBeUndefined();
    expect(backdropSources('https://evil.example.test/t/p/w780/b_1.jpg')).toBeUndefined();
    expect(backdropSources(null)).toBeUndefined();
  });
});

describe('Play', () => {
  it('takes only the household\'s own Jellyfin page for the item named', () => {
    const play = { itemId, url: `${origin}/web/#/details?id=${itemId}` };
    expect(safePlayUrl(play, origin)).toBe(play.url);
    for (const bad of [
      { itemId, url: `https://evil.example.test/web/#/details?id=${itemId}` },
      { itemId, url: `${origin}/web/#/details?id=other` },
      { itemId, url: 'javascript:alert(1)' },
      { itemId: '../x', url: `${origin}/web/#/details?id=../x` },
      { itemId, url: `http://media.example.com/web/#/details?id=${itemId}` },
      { itemId, url: `https://media.example.com:8443/web/#/details?id=${itemId}` },
      { itemId, url: `https://media.example.com.evil.example.net/web/#/details?id=${itemId}` },
      { itemId, url: `https://films.example.net:8443/web/#/details?id=${itemId}` },
      { itemId, url: `${origin}/web/#/details?id=${itemId}&x=1` },
      { itemId: 7, url: 'x' },
      null,
      'x',
    ]) {
      expect([bad, safePlayUrl(bad, origin)]).toEqual([bad, undefined]);
    }
  });

  it('keeps a household port, and only that one', () => {
    const withPort = 'https://films.example.net:8443';
    const play = { itemId, url: `${withPort}/web/#/details?id=${itemId}` };
    expect(safePlayUrl(play, withPort)).toBe(play.url);
    for (const url of [`https://films.example.net/web/#/details?id=${itemId}`, `https://films.example.net:8444/web/#/details?id=${itemId}`]) {
      expect(safePlayUrl({ itemId, url }, withPort)).toBeUndefined();
    }
  });
});

describe('Authorization headers', () => {
  it('sends the token alone for API calls', () => {
    expect(tokenAuthorization('0123abcd')).toBe('MediaBrowser Token="0123abcd"');
  });

  it('names the client, device, device ID and version for sign-in, encoded, and needs all four', () => {
    const identity = { client: 'JellyPass', device: 'iPhone 17 "Pro"', deviceId: 'b5c1-device', version: '1.0.0' };
    expect(signInAuthorization(identity)).toBe('MediaBrowser Client="JellyPass", Device="iPhone%2017%20%22Pro%22", DeviceId="b5c1-device", Version="1.0.0"');
    for (const key of ['client', 'device', 'deviceId', 'version'] as const) {
      expect(() => signInAuthorization({ ...identity, [key]: '  ' })).toThrow(`${key} is required`);
    }
  });
});
