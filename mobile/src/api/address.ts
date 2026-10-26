// A household's address: the one thing that says which household the app talks to. The server decides the household
// from the Host header alone, so the app keeps exactly one origin per sign-in and builds every URL from it. There is
// no list of households anywhere: a member gives the app their own address.
//
// Parsed by hand rather than with URL: React Native's URL does not implement `hostname` and friends.

/** A household address: `https://jelly-<household>.<domain>`, lower case, no port, path, query or credentials. */
export interface HouseholdAddress {
  /** `https://<host>`, with no trailing slash. */
  readonly origin: string;
  readonly host: string;
}

/** One DNS label: letters, digits and inner hyphens, at most 63 characters. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** `jelly-` and the household ID make one label; the domain is at least two more (HOUSEHOLD_DOMAIN). */
const HOUSEHOLD_HOST = new RegExp(`^jelly-[a-z0-9](?:[a-z0-9-]{0,55}[a-z0-9])?(?:\\.${LABEL}){2,}$`);
const MAX_HOST_LENGTH = 253;

/**
 * The household address `input` names, or undefined if it is not one: `https://` only, a household host
 * (`jelly-<household>.<domain>`), and nothing after the host but an optional `/`.
 */
export function parseHouseholdAddress(input: string): HouseholdAddress | undefined {
  const match = /^https:\/\/([^/?#]*)\/?$/i.exec(input.trim());
  const host = match?.[1]?.toLowerCase();
  if (!host || host.length > MAX_HOST_LENGTH || !HOUSEHOLD_HOST.test(host)) return undefined;
  return Object.freeze({ origin: `https://${host}`, host });
}
