import { BlockList, isIP } from 'node:net';

// After WHATWG serialisation every IPv4-mapped spelling (dotted, hex, expanded, upper-case) has exactly this form.
const MAPPED_IPV4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const ZONE_ID = /^%[A-Za-z0-9._~-]+$/;
const PORT = /^[1-9]\d{0,4}$/;

/**
 * Canonical form of a bare IP address, or undefined if it is not one. IPv4 stays dotted-decimal; every IPv4-mapped IPv6
 * spelling becomes the IPv4 address; other IPv6 addresses are serialised per RFC 5952 (lower case, longest zero run
 * compressed). An IPv6 zone ID (`fe80::1%eth0`) only names a local interface and is stripped.
 */
export function canonicalIp(value: string): string | undefined {
  let address = value.trim();
  const zone = address.indexOf('%');
  if (zone !== -1) {
    if (!ZONE_ID.test(address.slice(zone))) return undefined;
    address = address.slice(0, zone);
    if (isIP(address) !== 6) return undefined;
  }
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return undefined;
  let serialised: string;
  try {
    serialised = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const mapped = MAPPED_IPV4.exec(serialised);
  if (!mapped) return serialised;
  const high = Number.parseInt(mapped[1] as string, 16);
  const low = Number.parseInt(mapped[2] as string, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * Canonical address (see {@link canonicalIp}) from a socket or a forwarding-header entry, which may also be written as
 * `[ipv6]`, `[ipv6]:port` or `ipv4:port`. Returns undefined for anything else, including an invalid port.
 */
export function normaliseIp(value: string | undefined): string | undefined {
  const address = value?.trim();
  if (!address) return undefined;
  const bracketed = /^\[([^\]]+)\](?::([^:]*))?$/.exec(address);
  if (bracketed) {
    const [, inner, port] = bracketed;
    if (port !== undefined && !validPort(port)) return undefined;
    return isIP((inner as string).split('%')[0] as string) === 6 ? canonicalIp(inner as string) : undefined;
  }
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):([^:]*)$/.exec(address);
  if (withPort) return validPort(withPort[2] as string) ? canonicalIp(withPort[1] as string) : undefined;
  return canonicalIp(address);
}

/**
 * Parses a comma-separated list of IP addresses and CIDR ranges (IPv4 and IPv6). Empty entries are ignored; any other
 * invalid entry throws. Returns the entries in canonical form.
 */
export function parseTrustedProxies(input: string | undefined, name = 'TRUSTED_PROXIES'): string[] {
  const entries = (input ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.map((entry) => {
    const parsed = parseEntry(entry);
    if (!parsed) {
      throw new Error(`${name} must be a comma-separated list of IP addresses or CIDR ranges; "${entry}" is not valid`);
    }
    return parsed.prefix === undefined ? parsed.address : `${parsed.address}/${parsed.prefix}`;
  });
}

/**
 * Determines the real client address for a request that may have passed through reverse proxies.
 *
 * When the TCP peer is not a trusted proxy, its address is the client and X-Forwarded-For is ignored, so a client
 * cannot choose its own address. Otherwise X-Forwarded-For is walked right to left, skipping trusted proxies, and the
 * first untrusted address is the client. If every hop is trusted, the leftmost one is used.
 */
export class ClientIpResolver {
  readonly #trusted = new BlockList();
  readonly #enabled: boolean;

  public constructor(trustedProxies: readonly string[] = []) {
    for (const entry of trustedProxies) {
      const parsed = parseEntry(entry);
      if (!parsed) throw new Error(`invalid trusted proxy "${entry}"`);
      const family = isIP(parsed.address) === 6 ? 'ipv6' : 'ipv4';
      if (parsed.prefix === undefined) this.#trusted.addAddress(parsed.address, family);
      else this.#trusted.addSubnet(parsed.address, parsed.prefix, family);
    }
    this.#enabled = trustedProxies.length > 0;
  }

  public isTrusted(address: string): boolean {
    return this.#enabled && this.#trusted.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
  }

  public resolve(peerAddress: string | undefined, forwardedFor: string | string[] | undefined): string {
    const peer = normaliseIp(peerAddress);
    if (!peer) return 'unknown';
    if (!this.isTrusted(peer)) return peer;
    const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '').split(',');
    let client = peer;
    for (let index = hops.length - 1; index >= 0; index -= 1) {
      const hop = normaliseIp(hops[index]);
      // A malformed entry was written by the trusted proxy to its right; stop at that proxy rather than guess.
      if (!hop) break;
      client = hop;
      if (!this.isTrusted(hop)) break;
    }
    return client;
  }
}

function parseEntry(entry: string): { address: string; prefix?: number } | undefined {
  const [rawAddress, rawPrefix, extra] = entry.trim().split('/');
  if (extra !== undefined || !rawAddress) return undefined;
  const family = isIP(rawAddress.split('%')[0] as string);
  const address = canonicalIp(rawAddress);
  if (!family || !address) return undefined;
  let prefix: number | undefined;
  if (rawPrefix !== undefined) {
    if (!/^\d{1,3}$/.test(rawPrefix)) return undefined;
    prefix = Number(rawPrefix);
    if (prefix > (family === 6 ? 128 : 32)) return undefined;
  }
  // Peers are compared in canonical form, where IPv4-mapped addresses are plain IPv4, so a mapped entry is stored as the
  // IPv4 address or range it covers. A mapped range wider than ::ffff:0:0/96 would also cover IPv6 that is not mapped,
  // which a canonical peer can never match, so it is rejected rather than silently matching less than it says.
  if (family === 6 && isIP(address) === 4 && prefix !== undefined) {
    if (prefix < 96) return undefined;
    prefix -= 96;
  }
  return prefix === undefined ? { address } : { address, prefix };
}

function validPort(port: string): boolean {
  return PORT.test(port) && Number(port) <= 65_535;
}
