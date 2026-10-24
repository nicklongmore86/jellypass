/**
 * The app's sign-in is Jellyfin web's own: the `jellyfin_credentials` it keeps in localStorage on this origin (the
 * household host serves both the app and /web/). The app reads the access token from it, and signing in from the app
 * writes the same entry in the same format, so the app and Jellyfin web recognise one session and neither asks again.
 * Nothing else is stored but a random device ID (see {@link deviceId}); the token is never put in a URL, a log or a cache.
 */
const CREDENTIALS_KEY = 'jellyfin_credentials';
const DEVICE_ID_KEY = 'jellypass_device_id';
/** Jellyfin web's ConnectionMode.Manual: the server is reached at the address that was typed or, here, the page's own. */
const CONNECTION_MODE_MANUAL = 2;
const ADDRESS_KEYS = ['ManualAddress', 'LocalAddress', 'RemoteAddress'] as const;

/** A sign-in as Jellyfin's AuthenticateByName reports it. */
export interface StoredSignIn {
  serverId: string;
  serverName?: string;
  userId: string;
  token: string;
}

export function jellyfinToken(storage: Pick<Storage, 'getItem'>, origin: string): string | undefined {
  try {
    const servers = readServers(storage).filter(
      (server) => typeof server['AccessToken'] === 'string' && server['AccessToken'] !== '' && Boolean(server['UserId']),
    );
    const matching = servers.filter((server) => matchesOrigin(server, origin));
    const token = (matching[0] ?? servers[0])?.['AccessToken'];
    return typeof token === 'string' ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records a sign-in the way Jellyfin web does: this server's entry in `Servers` gets the user and token (with the server's
 * ID, the page's own address as its manual address and the time), and anything else in the entry or the file is kept.
 * Another entry for the same address (a server that has since been replaced) is dropped, so the app and Jellyfin web
 * cannot pick different sessions. Returns whether the sign-in can be read back; false when storage is unavailable.
 */
export function storeSignIn(storage: Pick<Storage, 'getItem' | 'setItem'>, origin: string, signIn: StoredSignIn, now = Date.now()): boolean {
  try {
    const file = readFile(storage);
    const servers = recordsOf(file['Servers']);
    const same = servers.filter((server) => server['Id'] === signIn.serverId);
    const kept = servers.filter((server) => server['Id'] !== signIn.serverId && !matchesOrigin(server, origin));
    const entry: Record<string, unknown> = {
      ...(signIn.serverName ? { Name: signIn.serverName } : {}),
      ...(same[0] ?? {}),
      Id: signIn.serverId,
      ManualAddress: origin,
      LastConnectionMode: CONNECTION_MODE_MANUAL,
      DateLastAccessed: now,
      UserId: signIn.userId,
      AccessToken: signIn.token,
    };
    storage.setItem(CREDENTIALS_KEY, JSON.stringify({ ...file, Servers: [entry, ...kept] }));
    return jellyfinToken(storage, origin) === signIn.token;
  } catch {
    return false;
  }
}

/**
 * Signs out the way Jellyfin web does: the user and token are taken out of the server entries and the entries stay.
 * Jellyfin web reads this same entry, so it is signed out too. Returns whether no sign-in is left.
 */
export function clearSignIn(storage: Pick<Storage, 'getItem' | 'setItem'>, origin: string): boolean {
  try {
    const file = readFile(storage);
    const servers = recordsOf(file['Servers']).map((server) => {
      const { AccessToken: _token, UserId: _user, ...rest } = server;
      return rest;
    });
    storage.setItem(CREDENTIALS_KEY, JSON.stringify({ ...file, Servers: servers }));
    return jellyfinToken(storage, origin) === undefined;
  } catch {
    return false;
  }
}

/**
 * This browser's device ID for Jellyfin: random, made on first use and kept, and its own (Jellyfin web keeps another),
 * so signing in here never replaces the session Jellyfin web holds for its own device ID.
 */
export function deviceId(storage: Pick<Storage, 'getItem' | 'setItem'>, random: () => string = randomId): string {
  try {
    const stored = storage.getItem(DEVICE_ID_KEY);
    if (stored && /^[A-Za-z0-9-]{16,80}$/.test(stored)) return stored;
  } catch {
    // Unreadable storage: a fresh ID for this page is still a valid one.
  }
  const fresh = `jellypass-${random()}`;
  try {
    storage.setItem(DEVICE_ID_KEY, fresh);
  } catch {
    // Not kept: the next page makes another, which Jellyfin simply sees as another device.
  }
  return fresh;
}

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readFile(storage: Pick<Storage, 'getItem'>): Record<string, unknown> {
  try {
    const stored: unknown = JSON.parse(storage.getItem(CREDENTIALS_KEY) ?? '{}');
    return isRecord(stored) ? stored : {};
  } catch {
    return {};
  }
}

function readServers(storage: Pick<Storage, 'getItem'>): Array<Record<string, unknown>> {
  return recordsOf(readFile(storage)['Servers']);
}

function recordsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function matchesOrigin(server: Record<string, unknown>, origin: string): boolean {
  const here = origin.toLowerCase();
  return ADDRESS_KEYS.some((key) => {
    const address = server[key];
    return typeof address === 'string' && address.replace(/\/+$/, '').toLowerCase() === here;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
