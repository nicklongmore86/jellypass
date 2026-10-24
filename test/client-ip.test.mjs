import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClientIpResolver, canonicalIp, normaliseIp, parseTrustedProxies } from '../dist/client-ip.js';

describe('normaliseIp', () => {
  it('strips the IPv4-mapped IPv6 prefix, brackets and ports', () => {
    assert.equal(normaliseIp('::ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(normaliseIp('::FFFF:192.0.2.1'), '192.0.2.1');
    assert.equal(normaliseIp(' 192.0.2.1 '), '192.0.2.1');
    assert.equal(normaliseIp('192.0.2.1:51234'), '192.0.2.1');
    assert.equal(normaliseIp('[2001:DB8::1]:443'), '2001:db8::1');
    assert.equal(normaliseIp('[2001:db8::1]'), '2001:db8::1');
    assert.equal(normaliseIp('2001:db8::1'), '2001:db8::1');
  });

  it('maps every IPv4-mapped IPv6 spelling to the IPv4 address', () => {
    for (const value of [
      '::ffff:203.0.113.5',
      '::ffff:cb00:7105',
      '::FFFF:CB00:7105',
      '0:0:0:0:0:ffff:cb00:7105',
      '0000:0000:0000:0000:0000:FFFF:CB00:7105',
      '0:0:0:0:0:ffff:203.0.113.5',
      '[::ffff:cb00:7105]:443',
    ]) {
      assert.equal(normaliseIp(value), '203.0.113.5', value);
    }
    assert.equal(normaliseIp('::ffff:0:0'), '0.0.0.0');
    // IPv4-compatible (deprecated) and NAT64 addresses are not mapped and stay IPv6.
    assert.equal(normaliseIp('::cb00:7105'), '::cb00:7105');
    assert.equal(normaliseIp('64:ff9b::203.0.113.5'), '64:ff9b::cb00:7105');
  });

  it('serialises IPv6 per RFC 5952 so equivalent spellings are equal', () => {
    for (const value of ['2001:DB8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8:0:0::1', '[2001:Db8::0:1]']) {
      assert.equal(normaliseIp(value), '2001:db8::1', value);
    }
    // The longest zero run is compressed; on a tie, the first one; a single zero group is not compressed.
    assert.equal(normaliseIp('2001:db8:0:0:1:0:0:1'), '2001:db8::1:0:0:1');
    assert.equal(normaliseIp('2001:db8:0:1:0:0:0:1'), '2001:db8:0:1::1');
    assert.equal(normaliseIp('2001:db8:0:1:1:1:1:1'), '2001:db8:0:1:1:1:1:1');
    assert.equal(normaliseIp('0:0:0:0:0:0:0:0'), '::');
  });

  it('strips IPv6 zone IDs', () => {
    assert.equal(normaliseIp('fe80::1%eth0'), 'fe80::1');
    assert.equal(normaliseIp('[FE80::1%en0]:8080'), 'fe80::1');
    assert.equal(canonicalIp('fe80:0::1%2'), 'fe80::1');
    for (const value of ['fe80::1%', 'fe80::1%eth 0', 'fe80::1%a%b', '192.0.2.1%eth0']) {
      assert.equal(normaliseIp(value), undefined, value);
    }
  });

  it('accepts only valid ports on [ipv6]:port and ipv4:port', () => {
    assert.equal(normaliseIp('[2001:db8::1]:1'), '2001:db8::1');
    assert.equal(normaliseIp('192.0.2.1:65535'), '192.0.2.1');
    for (const value of [
      '[2001:db8::1]:', '[2001:db8::1]:0', '[2001:db8::1]:65536', '[2001:db8::1]:http', '[2001:db8::1]:-1', '[2001:db8::1]:08',
      '192.0.2.1:', '192.0.2.1:0', '192.0.2.1:65536', '192.0.2.1:99999', '192.0.2.1:http', '192.0.2.1:1:2',
      '[192.0.2.1]', '[192.0.2.1]:80', '[2001:db8::1', '2001:db8::1]', '[]', '[]:80',
    ]) {
      assert.equal(normaliseIp(value), undefined, value);
    }
  });

  it('rejects values that are not IP addresses', () => {
    for (const value of [
      undefined, '', ' ', 'unknown', 'proxy.example.test', '192.0.2.300', '192.0.2', '010.0.0.1', '_hidden', 'obfuscated',
      '2001:db8::1::1', '2001:db8:::1', 'gggg::1', '1.2.3.4.5', '::ffff:999.0.0.1', '\u0000',
    ]) {
      assert.equal(normaliseIp(value), undefined, String(value));
    }
  });
});

describe('ClientIpResolver', () => {
  const trusted = new ClientIpResolver(parseTrustedProxies('192.0.2.10, 198.51.100.0/24, 2001:db8:ff::/48'));

  it('uses the peer and ignores X-Forwarded-For when no proxies are trusted', () => {
    const none = new ClientIpResolver();
    assert.equal(none.resolve('203.0.113.5', '198.51.100.1'), '203.0.113.5');
    assert.equal(none.resolve('::ffff:203.0.113.5', undefined), '203.0.113.5');
    assert.equal(none.resolve(undefined, '198.51.100.1'), 'unknown');
  });

  it('ignores a spoofed X-Forwarded-For from an untrusted peer', () => {
    assert.equal(trusted.resolve('203.0.113.5', '198.51.100.1'), '203.0.113.5');
    assert.equal(trusted.resolve('203.0.113.5', '203.0.113.11, 192.0.2.10'), '203.0.113.5');
  });

  it('takes the first untrusted address walking right to left from a trusted peer', () => {
    assert.equal(trusted.resolve('192.0.2.10', '203.0.113.5'), '203.0.113.5');
    // A client-supplied entry left of the real client is never reached.
    assert.equal(trusted.resolve('192.0.2.10', '203.0.113.66, 203.0.113.5'), '203.0.113.5');
  });

  it('skips several trusted hops, including CIDR members', () => {
    assert.equal(trusted.resolve('192.0.2.10', '203.0.113.66, 203.0.113.5, 198.51.100.7, 198.51.100.200'), '203.0.113.5');
    assert.equal(trusted.resolve('198.51.100.3', ['203.0.113.66, 203.0.113.5', '192.0.2.10']), '203.0.113.5');
  });

  it('handles IPv6 peers, IPv6 hops and IPv4-mapped peers', () => {
    assert.equal(trusted.resolve('2001:db8:ff::9', '2001:db8:1::5'), '2001:db8:1::5');
    assert.equal(trusted.resolve('2001:db8:ff::9', '[2001:db8:1::5]:6000, 2001:db8:ff:1::1'), '2001:db8:1::5');
    assert.equal(trusted.resolve('2001:db8:fe::9', '203.0.113.5'), '2001:db8:fe::9');
    assert.equal(trusted.resolve('::ffff:192.0.2.10', '::ffff:203.0.113.5'), '203.0.113.5');
    assert.equal(trusted.resolve('::ffff:198.51.100.9', '203.0.113.5'), '203.0.113.5');
  });

  it('matches trusted entries and peers written in any equivalent spelling', () => {
    const spelled = new ClientIpResolver(parseTrustedProxies('2001:0DB8:00FF:0000::/48, 0:0:0:0:0:FFFF:C000:020A'));
    assert.equal(spelled.resolve('2001:db8:ff::9', '203.0.113.5'), '203.0.113.5');
    assert.equal(spelled.resolve('2001:DB8:FF:0:0:0:0:9', '203.0.113.5'), '203.0.113.5');
    assert.equal(spelled.resolve('192.0.2.10', '203.0.113.5'), '203.0.113.5');
    assert.equal(spelled.resolve('::ffff:c000:20a', '203.0.113.5'), '203.0.113.5');
    assert.equal(spelled.resolve('fe80::1%eth0', '203.0.113.5'), 'fe80::1');
  });

  it('returns one canonical key for a client however its address is spelled', () => {
    for (const hop of ['203.0.113.5', '::ffff:203.0.113.5', '::ffff:cb00:7105', '0:0:0:0:0:FFFF:CB00:7105', '203.0.113.5:4711']) {
      assert.equal(trusted.resolve('192.0.2.10', hop), '203.0.113.5', hop);
    }
    for (const hop of ['2001:db8:1::5', '2001:DB8:1:0:0:0:0:5', '[2001:db8:1::5]:443', '2001:db8:1::5%eth0']) {
      assert.equal(trusted.resolve('192.0.2.10', hop), '2001:db8:1::5', hop);
    }
  });

  it('stops at the trusted proxy when a hop is garbage or has an invalid port', () => {
    for (const hop of ['garbage', '203.0.113.5:0', '203.0.113.5:65536', '[2001:db8:1::5]:', '[203.0.113.5]:80', 'fe80::1%']) {
      assert.equal(trusted.resolve('192.0.2.10', `203.0.113.66, ${hop}`), '192.0.2.10', hop);
    }
  });

  it('accepts IPv4-mapped trusted entries', () => {
    const mapped = new ClientIpResolver(parseTrustedProxies('::ffff:192.0.2.10, ::ffff:198.51.100.0/120'));
    assert.equal(mapped.resolve('192.0.2.10', '203.0.113.5'), '203.0.113.5');
    assert.equal(mapped.resolve('::ffff:198.51.100.77', '203.0.113.6'), '203.0.113.6');
  });

  it('falls back to the trusted peer when X-Forwarded-For is missing or malformed', () => {
    assert.equal(trusted.resolve('192.0.2.10', undefined), '192.0.2.10');
    assert.equal(trusted.resolve('192.0.2.10', ''), '192.0.2.10');
    assert.equal(trusted.resolve('192.0.2.10', 'garbage'), '192.0.2.10');
    assert.equal(trusted.resolve('192.0.2.10', '203.0.113.5, unknown, 198.51.100.4'), '198.51.100.4');
  });

  it('uses the leftmost hop when every hop is trusted', () => {
    assert.equal(trusted.resolve('192.0.2.10', '198.51.100.1, 198.51.100.2'), '198.51.100.1');
  });

  it('rejects invalid entries passed directly', () => {
    assert.throws(() => new ClientIpResolver(['not-an-ip']), /invalid trusted proxy "not-an-ip"/);
  });
});
