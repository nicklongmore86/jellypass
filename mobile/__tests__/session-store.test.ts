// The credential store: only the address, token, user ID and name, always with WHEN_UNLOCKED_THIS_DEVICE_ONLY, and a
// malformed item is dropped. expo-secure-store is the in-memory mock (__mocks__/expo-secure-store.ts).
import * as SecureStore from 'expo-secure-store';

import { clearSession, deviceId, readSession, writeSession, DEVICE_ID_KEY, SESSION_KEY } from '../src/session/store';
import { ADDRESS, TOKEN, store } from './support/household';

const THIS_DEVICE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

beforeEach(() => {
  store.__items.clear();
  jest.clearAllMocks();
});

describe('the session', () => {
  it('is written with this-device-only access, holding the four fields and nothing else', async () => {
    await writeSession({ address: ADDRESS, token: TOKEN, userId: 'u-ana', name: 'Ana Lima' });
    const item = store.__items.get(SESSION_KEY)!;
    expect(item.options).toEqual(THIS_DEVICE);
    expect(JSON.parse(item.value)).toEqual({ address: ADDRESS.origin, token: TOKEN, userId: 'u-ana', name: 'Ana Lima' });
    expect([...store.__items.keys()]).toEqual([SESSION_KEY]);
  });

  it('reads back what was written, asking with the same options', async () => {
    await writeSession({ address: ADDRESS, token: TOKEN, userId: 'u-ana', name: 'Ana Lima' });
    const session = await readSession();
    expect(session?.address.origin).toBe(ADDRESS.origin);
    expect(session?.token).toBe(TOKEN);
    expect(store.getItemAsync).toHaveBeenCalledWith(SESSION_KEY, THIS_DEVICE);
  });

  it('is none when nothing is stored', async () => {
    expect(await readSession()).toBeUndefined();
  });

  it.each([
    ['not json', '{'],
    ['a list', '[]'],
    ['no token', JSON.stringify({ address: 'https://jelly-home.example.test', userId: 'u', name: 'n' })],
    ['a foreign address', JSON.stringify({ address: 'https://evil.example.test', token: 't', userId: 'u', name: 'n' })],
    ['an address with a path', JSON.stringify({ address: 'https://jelly-home.example.test/x', token: 't', userId: 'u', name: 'n' })],
    ['a number for a name', JSON.stringify({ address: 'https://jelly-home.example.test', token: 't', userId: 'u', name: 1 })],
  ])('drops %s', async (_what, value) => {
    store.__items.set(SESSION_KEY, { value, options: THIS_DEVICE });
    expect(await readSession()).toBeUndefined();
    expect(store.__items.has(SESSION_KEY)).toBe(false);
  });

  it('is cleared, and clearing never throws', async () => {
    await writeSession({ address: ADDRESS, token: TOKEN, userId: 'u-ana', name: 'Ana Lima' });
    await clearSession();
    expect(store.__items.has(SESSION_KEY)).toBe(false);
    expect(store.deleteItemAsync).toHaveBeenCalledWith(SESSION_KEY, THIS_DEVICE);
    store.deleteItemAsync.mockRejectedValueOnce(new Error('keychain'));
    await expect(clearSession()).resolves.toBeUndefined();
  });
});

describe('the device ID', () => {
  it('is made once, kept with this-device-only access, and reused', async () => {
    const make = jest.fn(() => '0b9c2c1e-4a6f-4f53-9a43-1f3d9b8f0a11');
    expect(await deviceId(make)).toBe('0b9c2c1e-4a6f-4f53-9a43-1f3d9b8f0a11');
    expect(await deviceId(make)).toBe('0b9c2c1e-4a6f-4f53-9a43-1f3d9b8f0a11');
    expect(make).toHaveBeenCalledTimes(1);
    expect(store.__items.get(DEVICE_ID_KEY)?.options).toEqual(THIS_DEVICE);
  });

  it('is kept by sign-out', async () => {
    await deviceId(() => 'synthetic-device-0001');
    await writeSession({ address: ADDRESS, token: TOKEN, userId: 'u-ana', name: 'Ana Lima' });
    await clearSession();
    expect([...store.__items.keys()]).toEqual([DEVICE_ID_KEY]);
  });
});
