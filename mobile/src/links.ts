// The store-listing links the owner hosts (app.config.ts, `extra`): the privacy policy, a support page and a "What is
// JellyPass?" page. Each is optional. A link is offered only when its configured URL is a plain https URL, and only
// those URLs are ever handed to the system browser: no token, address or other member data goes with them.
import Constants from 'expo-constants';

export type StoreLink = 'privacyPolicyUrl' | 'supportUrl' | 'aboutUrl';

export const STORE_LINK_KEYS: readonly StoreLink[] = ['privacyPolicyUrl', 'supportUrl', 'aboutUrl'];

/** The URL as it may be opened (https, a host, no credentials, no whitespace), or null. */
export function cleanStoreUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || /\s/.test(text) || text.length > 500) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return text;
}

/** The configured link's URL, or null (so the link is hidden) when unset or not an https URL. */
export function storeLink(key: StoreLink, extra: Record<string, unknown> | undefined = Constants.expoConfig?.extra): string | null {
  return cleanStoreUrl(extra?.[key]);
}

/** Every link the app may open from its own screens, for the allow-list. */
export function storeLinks(extra: Record<string, unknown> | undefined = Constants.expoConfig?.extra): string[] {
  return STORE_LINK_KEYS.flatMap((key) => storeLink(key, extra) ?? []);
}
