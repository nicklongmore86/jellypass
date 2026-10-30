/**
 * Household addresses: which public origin (scheme, host and optional port) belongs to which household. The member
 * listener selects a household from the request's Host alone through {@link HouseholdAddresses.resolve}, for HTTP and
 * WebSocket requests alike, and a Host it does not know is no household's (never the admin site's).
 *
 * Two sources, joined: the address map administrators keep in the state file (a canonical origin and aliases per
 * household; any hostname, no naming rule), and the legacy HOUSEHOLD_DOMAIN + HOUSEHOLD_HOST_PREFIX rule, under which
 * `https://<prefix><household>.<domain>` is an alias of every household. An address both would give, to the same
 * household or another, is a configuration error, never a precedence question.
 */

/** A household's own entry in the address map (see GrantState.householdAddresses). */
export interface HouseholdAddressEntry {
  /** The canonical public origin, as `scheme://host[:port]`: the household's links and its URL in the admin site. */
  origin: string;
  /** More origins that select the same household; links made on one of them keep using it. */
  aliases: string[];
}

/** The legacy rule: `<prefix><household>.<domain>` is the household's address (HOUSEHOLD_DOMAIN, HOUSEHOLD_HOST_PREFIX). */
export interface LegacyAddressRule {
  domain: string;
  prefix: string;
}

/** What {@link HouseholdAddresses.resolve} found for a Host: the household, and the origin its links use. */
export interface ResolvedHousehold {
  householdId: string;
  origin: string;
}

/** An address that is not an origin JellyPass can serve, or that another household (or the legacy rule) has. */
export class HouseholdAddressError extends Error {
  public constructor(message: string, public readonly code: 'address_invalid' | 'address_conflict') {
    super(message);
  }
}

const HOUSEHOLD_ID = /^[a-z0-9_-]{1,128}$/;
/** A household ID that can be a DNS label, so the legacy rule gives it an address (as householdUrl did before 4.0.0). */
const DNS_LABEL_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };
/** The most aliases one household has; the map is read on every request, so it stays small. */
export const MAX_ALIASES = 16;

/**
 * Normalises an origin an administrator gave: lower case, punycode, no default port, no trailing slash. Only `http` and
 * `https` with a DNS hostname (or an IPv4 address) and no credentials, path, query or fragment.
 */
export function normalizeOrigin(input: unknown, name = 'origin'): string {
  if (typeof input !== 'string' || !input.trim()) throw new HouseholdAddressError(`${name} must be a non-empty string`, 'address_invalid');
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new HouseholdAddressError(`${name} must be an origin such as https://media.example.com`, 'address_invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HouseholdAddressError(`${name} must use https (or http)`, 'address_invalid');
  if (url.username || url.password) throw new HouseholdAddressError(`${name} must not contain credentials`, 'address_invalid');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || /[?#]$/.test(input.trim())) {
    throw new HouseholdAddressError(`${name} must be an origin only, with no path, query or fragment`, 'address_invalid');
  }
  const hostname = url.hostname.replace(/\.$/, '');
  if (!DNS_NAME.test(hostname)) throw new HouseholdAddressError(`${name} must have a DNS hostname or IPv4 address`, 'address_invalid');
  // The other scheme's default port would make a Host without a port ambiguous between two origins.
  const otherDefault = url.protocol === 'https:' ? '80' : '443';
  if (url.port === otherDefault) throw new HouseholdAddressError(`${name} must not use port ${otherDefault} with ${url.protocol.slice(0, -1)}`, 'address_invalid');
  return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}`;
}

/** The authority an origin is reached at, as Host would name it: the hostname, with the port unless it is a default one. */
function originKey(origin: string): string {
  const url = new URL(origin);
  return url.port && url.port !== DEFAULT_PORTS[url.protocol] ? `${url.hostname}:${url.port}` : url.hostname;
}

/**
 * The authority a Host header names, normalised as {@link originKey} does (an explicit :80 or :443 is the default port),
 * or undefined for anything that is not a plain `host[:port]`. Nothing but Host is ever read: X-Forwarded-Host is the
 * client's to write, even through a trusted proxy.
 */
export function hostKey(hostHeader: string | undefined): string | undefined {
  if (!hostHeader || hostHeader.length > 260) return undefined;
  const match = /^([^:/?#@\s[\]]+?)\.?(?::(\d{1,5}))?$/.exec(hostHeader.trim().toLowerCase());
  if (!match) return undefined;
  const [, hostname, port] = match as unknown as [string, string, string | undefined];
  if (!DNS_NAME.test(hostname)) return undefined;
  if (port === undefined || port === '80' || port === '443') return hostname;
  const number = Number(port);
  return number >= 1 && number <= 65535 ? `${hostname}:${number}` : undefined;
}

/**
 * Normalises one household's entry, or throws {@link HouseholdAddressError}: a valid canonical origin, valid aliases
 * (none the canonical one or another alias again).
 */
export function normalizeEntry(input: { origin: unknown; aliases?: unknown }): HouseholdAddressEntry {
  const origin = normalizeOrigin(input.origin);
  const rawAliases = input.aliases ?? [];
  if (!Array.isArray(rawAliases)) throw new HouseholdAddressError('aliases must be an array of origins', 'address_invalid');
  if (rawAliases.length > MAX_ALIASES) throw new HouseholdAddressError(`aliases must be at most ${MAX_ALIASES}`, 'address_invalid');
  const aliases = rawAliases.map((alias) => normalizeOrigin(alias, 'alias'));
  const keys = new Set<string>();
  for (const address of [origin, ...aliases]) {
    const key = originKey(address);
    if (keys.has(key)) throw new HouseholdAddressError(`${address} is listed twice for the household`, 'address_conflict');
    keys.add(key);
  }
  return { origin, aliases };
}

/** The household the legacy rule gives a host (`<prefix><household>.<domain>`), if any. */
function legacyHouseholdId(key: string, rule: LegacyAddressRule): string | undefined {
  if (key.includes(':')) return undefined;
  const suffix = `.${rule.domain}`;
  if (!key.endsWith(suffix)) return undefined;
  const label = key.slice(0, -suffix.length);
  if (!label.startsWith(rule.prefix)) return undefined;
  const householdId = label.slice(rule.prefix.length);
  return HOUSEHOLD_ID.test(householdId) ? householdId : undefined;
}

/**
 * The address map and the legacy rule together. Built from a snapshot of the map; {@link HouseholdAddresses.check}
 * refuses a map that conflicts with itself or with the rule, and the constructor runs it, so an instance always holds a
 * consistent map.
 */
export class HouseholdAddresses {
  readonly #legacy: LegacyAddressRule | undefined;
  readonly #entries: Readonly<Record<string, HouseholdAddressEntry>>;
  /** Authority → household and the origin it was configured as (canonical or alias). */
  readonly #byKey = new Map<string, ResolvedHousehold>();

  public constructor(entries: Readonly<Record<string, HouseholdAddressEntry>>, legacy?: LegacyAddressRule) {
    this.#legacy = legacy ? { domain: legacy.domain.toLowerCase(), prefix: legacy.prefix.toLowerCase() } : undefined;
    // Normalised again, so a hand-edited state file is held to the same rules as the admin API.
    this.#entries = Object.fromEntries(Object.entries(entries).map(([householdId, entry]) => {
      if (!HOUSEHOLD_ID.test(householdId)) throw new HouseholdAddressError(`${householdId} is not a household ID`, 'address_invalid');
      return [householdId, normalizeEntry(entry)];
    }));
    for (const [householdId, entry] of Object.entries(this.#entries)) {
      for (const origin of [entry.origin, ...entry.aliases]) {
        const key = originKey(origin);
        const taken = this.#byKey.get(key);
        if (taken) {
          throw new HouseholdAddressError(taken.householdId === householdId
            ? `${origin} is listed twice for household ${householdId}`
            : `${origin} is an address of both household ${taken.householdId} and household ${householdId}`, 'address_conflict');
        }
        const legacyId = this.#legacy ? legacyHouseholdId(key, this.#legacy) : undefined;
        if (legacyId !== undefined) {
          throw new HouseholdAddressError(legacyId === householdId
            ? `${origin} is already household ${householdId}'s legacy address (HOUSEHOLD_DOMAIN and HOUSEHOLD_HOST_PREFIX); remove it from the map`
            : `${origin} is household ${legacyId}'s legacy address (HOUSEHOLD_DOMAIN and HOUSEHOLD_HOST_PREFIX), so it cannot be household ${householdId}'s`, 'address_conflict');
        }
        this.#byKey.set(key, { householdId, origin });
      }
    }
  }

  /** Whether the legacy rule is on (HOUSEHOLD_DOMAIN set). */
  public get legacy(): LegacyAddressRule | undefined {
    return this.#legacy ? { ...this.#legacy } : undefined;
  }

  /** This map with one household's entry replaced (or removed, for undefined); throws as the constructor does. */
  public with(householdId: string, entry: HouseholdAddressEntry | undefined): HouseholdAddresses {
    const { [householdId]: _, ...others } = this.#entries;
    return new HouseholdAddresses(entry ? { ...others, [householdId]: entry } : others, this.#legacy);
  }

  /**
   * The household a Host header selects, exactly (case and default ports aside), with the origin it matched; undefined
   * for any other Host, which the member listener refuses.
   */
  public resolve(hostHeader: string | undefined): ResolvedHousehold | undefined {
    const key = hostKey(hostHeader);
    if (key === undefined) return undefined;
    const mapped = this.#byKey.get(key);
    if (mapped) return { ...mapped };
    const legacyId = this.#legacy ? legacyHouseholdId(key, this.#legacy) : undefined;
    return legacyId === undefined ? undefined : { householdId: legacyId, origin: `https://${key}` };
  }

  /** The household's canonical origin: its mapped one, else its legacy one, else none. */
  public householdUrl(householdId: string): string | undefined {
    return this.#entries[householdId]?.origin ?? this.#legacyUrl(householdId);
  }

  /** Every origin that selects the household: the canonical one first, then its aliases, then its legacy address. */
  public addresses(householdId: string): { origin?: string; aliases: string[]; legacy?: string } {
    const entry = this.#entries[householdId];
    const legacy = this.#legacyUrl(householdId);
    return {
      ...(entry ? { origin: entry.origin } : {}),
      aliases: [...(entry?.aliases ?? [])],
      ...(legacy ? { legacy } : {}),
    };
  }

  #legacyUrl(householdId: string): string | undefined {
    if (!this.#legacy || !DNS_LABEL_ID.test(householdId)) return undefined;
    return `https://${this.#legacy.prefix}${householdId}.${this.#legacy.domain}`;
  }
}
