// The sign-in, kept only in the platform's credential store (expo-secure-store): the iOS Keychain, readable only
// while the device is unlocked and never synced or migrated to another device (WHEN_UNLOCKED_THIS_DEVICE_ONLY), and on
// Android values encrypted with a Keystore key (Android backup is off in app.config.ts). Nothing goes to
// AsyncStorage, plain files or logs.
//
// One item holds the session: the household address, the token, the user ID and the member's name, and nothing else.
// A second holds the device ID Jellyfin's sign-in asks for: random, generated once, and not a secret, but kept here so
// it never leaves the device either. Sign-out deletes the session and keeps the device ID.

import * as SecureStore from 'expo-secure-store';

import { parseHouseholdAddress, type HouseholdAddress } from '../api/address';

export interface StoredSession {
  address: HouseholdAddress;
  token: string;
  userId: string;
  /** The member's name, until /me says it afresh. */
  name: string;
}

export const SESSION_KEY = 'jellypass.session';
export const DEVICE_ID_KEY = 'jellypass.device-id';

export const STORE_OPTIONS: SecureStore.SecureStoreOptions = Object.freeze({
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
});

const MAX_FIELD_LENGTH = 4096;

function field(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= MAX_FIELD_LENGTH ? value : undefined;
}

// Every read, write and delete of the stored session goes through this one queue, so a compare-and-delete can never
// interleave with another sign-in's write: one operation finishes before the next starts.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const run = queue.then(operation, operation);
  queue = run.catch(() => undefined);
  return run;
}

/** The stored session, or undefined when there is none. One that is not the shape written below is deleted. */
export function readSession(): Promise<StoredSession | undefined> {
  return serialized(readNow);
}

async function readNow(): Promise<StoredSession | undefined> {
  const text = await SecureStore.getItemAsync(SESSION_KEY, STORE_OPTIONS);
  if (text === null) return undefined;
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) value = parsed as Record<string, unknown>;
  } catch {
    // Unreadable: deleted below.
  }
  const origin = field(value['address']);
  const address = origin === undefined ? undefined : parseHouseholdAddress(origin);
  const token = field(value['token']);
  const userId = field(value['userId']);
  const name = field(value['name']);
  if (!address || address.origin !== origin || !token || !userId || !name) {
    await deleteNow();
    return undefined;
  }
  return { address, token, userId, name };
}

export function writeSession(session: StoredSession): Promise<void> {
  const { address, token, userId, name } = session;
  return serialized(() => SecureStore.setItemAsync(SESSION_KEY, JSON.stringify({ address: address.origin, token, userId, name }), STORE_OPTIONS));
}

async function deleteNow(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SESSION_KEY, STORE_OPTIONS);
  } catch {
    // Nothing more can be done; the next start finds the old token and /me answers 401 for it.
  }
}

/** Deletes the session. Never throws: a failure here must not keep the app signed in on screen. */
export function clearSession(): Promise<void> {
  return serialized(deleteNow);
}

/**
 * Deletes the stored session only if it is `session`'s own (same household and token), read and deleted as one step in
 * the queue: a newer sign-in's write comes before or after it, never between. Never throws; if the store cannot be
 * read nothing is deleted (it may be a newer sign-in's).
 */
export function clearSessionIf(session: Pick<StoredSession, 'address' | 'token'>): Promise<void> {
  return serialized(async () => {
    let kept: StoredSession | undefined;
    try {
      kept = await readNow();
    } catch {
      return;
    }
    if (kept && kept.token === session.token && kept.address.origin === session.address.origin) await deleteNow();
  });
}

/** This install's device ID, made the first time it is asked for. */
export async function deviceId(makeId: () => string): Promise<string> {
  const stored = await SecureStore.getItemAsync(DEVICE_ID_KEY, STORE_OPTIONS);
  if (stored && /^[A-Za-z0-9-]{8,64}$/.test(stored)) return stored;
  const made = makeId();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, made, STORE_OPTIONS);
  return made;
}
