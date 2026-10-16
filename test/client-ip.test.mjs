import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClientIpResolver, normaliseIp, parseTrustedProxies } from '../dist/client-ip.js';

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

  it('rejects values that are not IP addresses', () => {
    for (const value of [undefined, '', 'unknown', 'proxy.example.test', '192.0.2.300', '_hidden']) {
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
    assert.equal(trusted.resolve('203.0.113.5', '1.1.1.1, 192.0.2.10'), '203.0.113.5');
  });

  it('takes the first untrusted address walking right to left from a trusted peer', () => {
    assert.equal(trusted.resolve('192.0.2.10', '203.0.113.5'), '203.0.113.5');
    // A client-supplied entry left of the real client is never reached.
    assert.equal(trusted.resolve('192.0.2.10', '6.6.6.6, 203.0.113.5'), '203.0.113.5');
  });

  it('skips several trusted hops, including CIDR members', () => {
    assert.equal(trusted.resolve('192.0.2.10', '6.6.6.6, 203.0.113.5, 198.51.100.7, 198.51.100.200'), '203.0.113.5');
    assert.equal(trusted.resolve('198.51.100.3', ['6.6.6.6, 203.0.113.5', '192.0.2.10']), '203.0.113.5');
  });

  it('handles IPv6 peers, IPv6 hops and IPv4-mapped peers', () => {
    assert.equal(trusted.resolve('2001:db8:ff::9', '2001:db8:1::5'), '2001:db8:1::5');
    assert.equal(trusted.resolve('2001:db8:ff::9', '[2001:db8:1::5]:6000, 2001:db8:ff:1::1'), '2001:db8:1::5');
    assert.equal(trusted.resolve('2001:db8:fe::9', '203.0.113.5'), '2001:db8:fe::9');
    assert.equal(trusted.resolve('::ffff:192.0.2.10', '::ffff:203.0.113.5'), '203.0.113.5');
    assert.equal(trusted.resolve('::ffff:198.51.100.9', '203.0.113.5'), '203.0.113.5');
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
