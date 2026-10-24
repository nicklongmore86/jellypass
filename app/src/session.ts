/**
 * The Jellyfin web client's access token for this origin, from the `jellyfin_credentials` it keeps in localStorage on
 * the same origin (the household host serves both). This is how "Add to my library" signs in too: the app never asks
 * for a password and never stores the token anywhere itself.
 */
export function jellyfinToken(storage: Pick<Storage, 'getItem'>, origin: string): string | undefined {
  try {
    const stored: unknown = JSON.parse(storage.getItem('jellyfin_credentials') ?? '{}');
    const servers = (isRecord(stored) && Array.isArray(stored['Servers']) ? stored['Servers'] : []).filter(
      (server): server is Record<string, unknown> =>
        isRecord(server) && typeof server['AccessToken'] === 'string' && server['AccessToken'] !== '' && Boolean(server['UserId']),
    );
    const here = origin.toLowerCase();
    const matching = servers.filter((server) =>
      ['ManualAddress', 'LocalAddress', 'RemoteAddress'].some((key) => {
        const address = server[key];
        return typeof address === 'string' && address.replace(/\/+$/, '').toLowerCase() === here;
      }),
    );
    const token = (matching[0] ?? servers[0])?.['AccessToken'];
    return typeof token === 'string' ? token : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
