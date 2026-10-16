import { BlockList, isIP } from 'node:net';

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Canonical form of an address from a socket or a forwarding header: brackets, a port and the `::ffff:` prefix of an
 * IPv4-mapped IPv6 address are removed. Returns undefined for anything that is not an IP address.
 */
export function normaliseIp(value: string | undefined): string | undefined {
  let address = value?.trim();
  if (!address) return undefined;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1] as string;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(':'));
  const mapped = MAPPED_IPV4.exec(address);
  if (mapped) address = mapped[1] as string;
  return isIP(address) ? address.toLowerCase() : undefined;
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
  let address = rawAddress.toLowerCase();
  const family = isIP(address);
  if (!family) return undefined;
  let prefix: number | undefined;
  if (rawPrefix !== undefined) {
    if (!/^\d{1,3}$/.test(rawPrefix)) return undefined;
    prefix = Number(rawPrefix);
    if (prefix > (family === 6 ? 128 : 32)) return undefined;
  }
  // Peers are compared in normalised form, so an IPv4-mapped entry is stored as the plain IPv4 address or range.
  const mapped = MAPPED_IPV4.exec(address);
  if (mapped && (prefix === undefined || prefix >= 96)) {
    address = mapped[1] as string;
    if (prefix !== undefined) prefix -= 96;
  }
  return prefix === undefined ? { address } : { address, prefix };
}
