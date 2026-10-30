// The two ways in: a typed address and a setup link's `address` parameter, both through readHouseholdAddress.
import { parseLinkAddress, parseTypedAddress, readTypedAddress } from '../src/signin/address-input';

describe('a typed address', () => {
  it.each([
    ['https://media.example.com', 'https://media.example.com'],
    ['  media.example.com  ', 'https://media.example.com'],
    ['Media.Example.COM/', 'https://media.example.com'],
    ['HTTPS://media.example.com', 'https://media.example.com'],
    ['films.example.net:8443', 'https://films.example.net:8443'],
    ['https://films.example.net:8443/', 'https://films.example.net:8443'],
    ['media.example.com:443', 'https://media.example.com'],
    ['jellyfin.example.test', 'https://jellyfin.example.test'],
    ['jelly-demo.jellypass.app', 'https://jelly-demo.jellypass.app'],
    // An address an older app version took still works.
    ['jelly-home.example.test', 'https://jelly-home.example.test'],
    // Pasted from notes or chat, with a newline or a tab at an end.
    ['media.example.com\n', 'https://media.example.com'],
    ['media.example.com\r\n', 'https://media.example.com'],
    ['\tmedia.example.com', 'https://media.example.com'],
    ['\thttps://media.example.com\r\n', 'https://media.example.com'],
  ])('takes %j', (typed, origin) => {
    expect(parseTypedAddress(typed)?.origin).toBe(origin);
  });

  it.each([
    ['', 'invalid'],
    ['http://media.example.com', 'http'],
    ['media.example.com:0', 'invalid'],
    ['media.example.com:99999', 'invalid'],
    ['media.example.com/web', 'extra'],
    ['media.example.com?x=1', 'extra'],
    ['media.example.com#x', 'extra'],
    ['user@media.example.com', 'extra'],
    ['user:pw@media.example.com', 'extra'],
    ['media', 'invalid'],
    ['media .example.com', 'invalid'],
    ['bücher.example', 'unicode'],
    ['192.168.1.10', 'local'],
    ['192.168.1.10:8920', 'local'],
    ['[::1]', 'local'],
    ['nas.local', 'local'],
    ['ftp://media.example.com', 'invalid'],
    ['mailto:someone@media.example.com', 'extra'],
    ['javascript:alert(1)', 'invalid'],
    ['jellypass://connect?address=https://media.example.com', 'invalid'],
    ['\u212aitchen.example.com', 'unicode'],
    ['\u0130mages.example.com', 'unicode'],
    ['media.example.co\u017f', 'unicode'],
  ])('refuses %j (%s)', (typed, problem) => {
    expect(parseTypedAddress(typed)).toBeUndefined();
    expect(readTypedAddress(typed)).toEqual({ problem });
  });

  it.each(['\u0000', '\u0085', '\u00a0', '\u2028', '\u2029', '\ufeff', '\u200b', '\u200e', '\u202e', '\u2066'])(
    'refuses %j at the start, the end or in the middle',
    (character) => {
      for (const typed of [`${character}media.example.com`, `media.example.com${character}`, `media.${character}example.com`]) {
        expect(readTypedAddress(typed)).toEqual({ problem: 'invalid' });
      }
    },
  );
});

describe("a setup link's address", () => {
  it('takes exactly one household address', () => {
    expect(parseLinkAddress('https://media.example.com')?.host).toBe('media.example.com');
    expect(parseLinkAddress('https://films.example.net:8443')?.origin).toBe('https://films.example.net:8443');
    expect(parseLinkAddress('https://jelly-demo.jellypass.app')?.host).toBe('jelly-demo.jellypass.app');
  });

  it('refuses none, several, a bare host or anything else', () => {
    expect(parseLinkAddress(undefined)).toBeUndefined();
    expect(parseLinkAddress(['https://media.example.com', 'https://films.example.net:8443'])).toBeUndefined();
    expect(parseLinkAddress('media.example.com')).toBeUndefined();
    expect(parseLinkAddress('http://media.example.com')).toBeUndefined();
    expect(parseLinkAddress('https://media.example.com/Users/Public')).toBeUndefined();
    expect(parseLinkAddress('https://token@media.example.com')).toBeUndefined();
    expect(parseLinkAddress('https://media.example.com/?token=x')).toBeUndefined();
    expect(parseLinkAddress('https://192.168.1.10')).toBeUndefined();
  });

  it('takes a newline or tab at its ends, and nothing else invisible anywhere', () => {
    expect(parseLinkAddress('https://media.example.com\n')?.origin).toBe('https://media.example.com');
    expect(parseLinkAddress('\thttps://media.example.com\r\n')?.origin).toBe('https://media.example.com');
    for (const character of ['\u0000', '\u00a0', '\u2028', '\u2029', '\ufeff', '\u200b', '\u200f', '\u202a', '\u2069']) {
      expect(parseLinkAddress(`${character}https://media.example.com`)).toBeUndefined();
      expect(parseLinkAddress(`https://media.example.com${character}`)).toBeUndefined();
      expect(parseLinkAddress(`https://media.${character}example.com`)).toBeUndefined();
    }
    expect(parseLinkAddress('https://\u212a.com')).toBeUndefined();
  });
});
