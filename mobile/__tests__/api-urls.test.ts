// The household address the client is made for, the URLs it lets an answer name (ported from the PWA's tests in
// test/app-pwa.test.mjs), and the two Authorization headers.
import {
  backdropSources,
  parseHouseholdAddress,
  safeImageUrl,
  safeLogoUrl,
  safePlayUrl,
  signInAuthorization,
  tokenAuthorization,
} from '../src/api';

const origin = 'https://jelly-household.example.test';
const itemId = '0123456789abcdef0123456789abcdef';

describe('a household address', () => {
  it.each([
    ['https://jelly-household.example.test', 'jelly-household.example.test'],
    ['https://jelly-household.example.test/', 'jelly-household.example.test'],
    ['  HTTPS://Jelly-Farm-House.Example.Test  ', 'jelly-farm-house.example.test'],
    ['https://jelly-a.home.example.test', 'jelly-a.home.example.test'],
    ['https://jelly-0.example.test', 'jelly-0.example.test'],
  ])('takes %j as %s', (input, host) => {
    expect(parseHouseholdAddress(input)).toEqual({ origin: `https://${host}`, host });
  });

  it.each([
    'http://jelly-household.example.test',
    'jelly-household.example.test',
    'https://household.example.test',
    'https://jelly-.example.test',
    'https://jelly--x.example.test',
    'https://jelly-x-.example.test',
    'https://jelly-household.test',
    'https://jelly-household',
    'https://jelly-household.example.test:8443',
    'https://user:pw@jelly-household.example.test',
    'https://jelly-household.example.test/jellypass/app/',
    'https://jelly-household.example.test/?households=all',
    'https://jelly-household.example.test#x',
    'https://jelly-house_hold.example.test',
    'https://jelly-household.example.test.',
    'https://jelly-household..example.test',
    'https://192.168.1.10',
    'https://[::1]',
    `https://jelly-${'a'.repeat(58)}.example.test`,
    // Over 253 characters in all.
    `https://jelly-household.${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.test`,
    '',
    'https://',
  ])('refuses %j', (input) => {
    expect(parseHouseholdAddress(input)).toBeUndefined();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(parseHouseholdAddress(origin))).toBe(true);
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
      { itemId, url: `http://jelly-household.example.test/web/#/details?id=${itemId}` },
      { itemId, url: `https://jelly-other.example.test/web/#/details?id=${itemId}` },
      { itemId, url: `${origin}/web/#/details?id=${itemId}&x=1` },
      { itemId: 7, url: 'x' },
      null,
      'x',
    ]) {
      expect([bad, safePlayUrl(bad, origin)]).toEqual([bad, undefined]);
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
