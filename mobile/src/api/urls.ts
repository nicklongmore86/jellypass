// The only URLs the app ever loads or opens from an API answer, ported from the PWA's app/src/render.ts: TMDB's own
// image files at the exact widths the API sends, and a Play link to the household's own Jellyfin. Anything else in an
// answer is refused by decode.ts (a Play link is dropped), so a bad answer can never point the app at another host.

/** Posters (w342) and backdrops (w780, and w1280 for the sharper copy), as the PWA's TMDB_IMAGE. */
const TMDB_IMAGE = /^https:\/\/image\.tmdb\.org\/t\/p\/(?:w342|w780|w1280)\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
/** Network and studio logos: TMDB's own files at the one width the API sends, and nothing else. */
const TMDB_LOGO = /^https:\/\/image\.tmdb\.org\/t\/p\/w300\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
const BACKDROP_URL = /^(https:\/\/image\.tmdb\.org\/t\/p\/)w(?:780|1280)(\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp))$/;
const ITEM_ID = /^[A-Za-z0-9-]{1,64}$/;

/** An image URL the API returned, only if it is one of TMDB's allowlisted poster or backdrop URLs. */
export function safeImageUrl(url: unknown): string | undefined {
  return typeof url === 'string' && TMDB_IMAGE.test(url) ? url : undefined;
}

/** A logo URL the API returned, only if it is one of TMDB's allowlisted logo URLs. */
export function safeLogoUrl(url: unknown): string | undefined {
  return typeof url === 'string' && TMDB_LOGO.test(url) ? url : undefined;
}

/** A backdrop's two widths, as the PWA draws it: w780 first, w1280 the sharper candidate. */
export function backdropSources(url: unknown): { small: string; large: string } | undefined {
  const parts = BACKDROP_URL.exec(safeImageUrl(url) ?? '');
  return parts ? { small: `${parts[1]}w780${parts[2]}`, large: `${parts[1]}w1280${parts[2]}` } : undefined;
}

/**
 * A Play link, only if it is exactly the household's own Jellyfin details page for the item the API named. The API
 * builds it the same way; checking again here means a link can never point anywhere else.
 */
export function safePlayUrl(play: unknown, origin: string): string | undefined {
  if (typeof play !== 'object' || play === null) return undefined;
  const { itemId, url } = play as Record<string, unknown>;
  if (typeof itemId !== 'string' || !ITEM_ID.test(itemId)) return undefined;
  const expected = `${origin}/web/#/details?id=${itemId}`;
  return url === expected ? expected : undefined;
}
