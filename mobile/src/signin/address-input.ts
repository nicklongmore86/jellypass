// The two ways a member gives the app their household's address: typing (or pasting) it, or opening a setup link
// `jellypass://connect?address=https://media.example.com` that the household hands out. Both go through
// readHouseholdAddress, and neither ever signs anyone in: a typed address goes to the profile picker, and a link is
// shown for the member to confirm first. A link carries only the address, never a token or a name.

import { parseHouseholdAddress, readHouseholdAddress, type AddressReading, type HouseholdAddress } from '../api/address';

/**
 * A typed or pasted address: `https://` is added when no scheme was given; anything else is as the parser takes it.
 * Only `<scheme>://` counts as a scheme, so `films.example.net:8443` is a host and port, not a `films.example.net:` URL.
 */
export function readTypedAddress(input: string): AddressReading {
  const trimmed = input.trim();
  return readHouseholdAddress(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
}

/** readTypedAddress's address, or undefined when it refused one. */
export function parseTypedAddress(input: string): HouseholdAddress | undefined {
  const reading = readTypedAddress(input);
  return 'address' in reading ? reading.address : undefined;
}

/**
 * The address a setup link's `address` parameter names (as Expo Router hands it over, already decoded), or undefined
 * when there is none, there are several, or it is not exactly a household address (with its `https://`).
 */
export function parseLinkAddress(param: string | string[] | undefined): HouseholdAddress | undefined {
  return typeof param === 'string' ? parseHouseholdAddress(param) : undefined;
}
