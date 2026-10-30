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
  ])('refuses %j (%s)', (typed, problem) => {
    expect(parseTypedAddress(typed)).toBeUndefined();
    expect(readTypedAddress(typed)).toEqual({ problem });
  });
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
});
