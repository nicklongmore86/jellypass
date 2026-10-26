// The two ways in: a typed address and a setup link's `address` parameter, both through parseHouseholdAddress.
import { parseLinkAddress, parseTypedAddress } from '../src/signin/address-input';

describe('a typed address', () => {
  it.each([
    ['https://jelly-home.example.test', 'https://jelly-home.example.test'],
    ['  jelly-home.example.test  ', 'https://jelly-home.example.test'],
    ['JELLY-Home.Example.TEST/', 'https://jelly-home.example.test'],
    ['HTTPS://jelly-home.example.test', 'https://jelly-home.example.test'],
  ])('takes %j', (typed, origin) => {
    expect(parseTypedAddress(typed)?.origin).toBe(origin);
  });

  it.each([
    '',
    'jellyfin.example.test',
    'http://jelly-home.example.test',
    'jelly-home.example.test:8443',
    'jelly-home.example.test/web',
    'jelly-home.example.test?x=1',
    'user@jelly-home.example.test',
    'jelly-home',
    'ftp://jelly-home.example.test',
    'jellypass://connect?address=https://jelly-home.example.test',
  ])('refuses %j', (typed) => {
    expect(parseTypedAddress(typed)).toBeUndefined();
  });
});

describe("a setup link's address", () => {
  it('takes exactly one household address', () => {
    expect(parseLinkAddress('https://jelly-home.example.test')?.host).toBe('jelly-home.example.test');
  });

  it('refuses none, several, a bare host or anything else', () => {
    expect(parseLinkAddress(undefined)).toBeUndefined();
    expect(parseLinkAddress(['https://jelly-a.example.test', 'https://jelly-b.example.test'])).toBeUndefined();
    expect(parseLinkAddress('jelly-home.example.test')).toBeUndefined();
    expect(parseLinkAddress('https://jelly-home.example.test/Users/Public')).toBeUndefined();
    expect(parseLinkAddress('https://evil.example.test')).toBeUndefined();
  });
});
