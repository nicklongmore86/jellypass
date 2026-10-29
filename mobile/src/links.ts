// The store-listing links the owner hosts (app.config.ts, `extra`): the privacy policy, a support page and a "What is
// JellyPass?" page. Each is optional. A link is offered only when its configured URL is a plain https URL, and only
// those URLs are ever handed to the system browser: no token, address or other member data goes with them.
import Constants from 'expo-constants';

export type StoreLink = 'privacyPolicyUrl' | 'supportUrl' | 'aboutUrl';

export const STORE_LINK_KEYS: readonly StoreLink[] = ['privacyPolicyUrl', 'supportUrl', 'aboutUrl'];

/** Whitespace, control and invisible format characters (zero-width, BOM, bidi marks, NBSP, ...) anywhere in the text. */
const UNSAFE = /[\p{White_Space}\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The URL as it may be opened, or null. The text is judged as written, never trimmed: it must start exactly with
 * `https://` (lower case), hold no whitespace, control or format character, parse to a host (a dotted name, or an
 * IP literal) with no credentials, and serialize back to itself, so the allow-list holds the exact string the config
 * says. Non-ASCII hosts and unnormalised forms (`HTTPS://`, a missing path, an explicit default port) are refused;
 * write the punycode, normalised form in the config.
 */
export function cleanStoreUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === '' || value.length > 500 || UNSAFE.test(value) || !value.startsWith('https://')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const host = url.hostname;
  if (host === '' || !(host.includes('.') || host.startsWith('['))) return null;
  return url.href === value ? value : null;
}

/** The configured link's URL, or null (so the link is hidden) when unset or not an https URL. */
export function storeLink(key: StoreLink, extra: Record<string, unknown> | undefined = Constants.expoConfig?.extra): string | null {
  return cleanStoreUrl(extra?.[key]);
}

/** Every link the app may open from its own screens, for the allow-list. */
export function storeLinks(extra: Record<string, unknown> | undefined = Constants.expoConfig?.extra): string[] {
  return STORE_LINK_KEYS.flatMap((key) => storeLink(key, extra) ?? []);
}
