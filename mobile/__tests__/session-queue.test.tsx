// The stored credentials are read, written and deleted through one queue, and a delete is a compare-and-delete by
// household and token: another sign-in's write that lands before, between or after is never erased.
import * as SecureStore from 'expo-secure-store';

import { parseHouseholdAddress } from '../src/api/address';
import { clearSessionIf, readSession, writeSession, SESSION_KEY, type StoredSession } from '../src/session/store';
import { OTHER_ORIGIN, ORIGIN, store } from './support/household';

const mk = (origin: string, token: string): StoredSession => ({ address: parseHouseholdAddress(origin)!, token, userId: 'synthetic-user-0001', name: 'Ana' });
const A = mk(ORIGIN, 'synthetic-token-a-0001');
const B = mk(OTHER_ORIGIN, 'synthetic-token-b-0002');
const tokenKept = () => {
  const text = store.__items.get(SESSION_KEY)?.value;
  return text === undefined ? undefined : (JSON.parse(text) as { token: string }).token;
};

/** Holds the next read of the store until `release()`, as a slow credential store would. */
function slowRead() {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = (SecureStore.getItemAsync as jest.Mock).getMockImplementation()!;
  (SecureStore.getItemAsync as jest.Mock).mockImplementationOnce(async (...args: unknown[]) => {
    const text = await (real as (...a: unknown[]) => Promise<string | null>)(...args);
    await held;
    return text;
  });
  return release;
}

beforeEach(() => store.__items.clear());

describe('A compares and deletes while B writes', () => {
  it('A\'s read in flight, then B written: B survives (the delete waits its turn)', async () => {
    await writeSession(A);
    const release = slowRead();
    const deleting = clearSessionIf(A);
    const writing = writeSession(B);
    release();
    await Promise.all([deleting, writing]);
    expect(tokenKept()).toBe(B.token);
  });

  it('B written first, then A\'s delete: B survives', async () => {
    await writeSession(A);
    await writeSession(B);
    await clearSessionIf(A);
    expect(tokenKept()).toBe(B.token);
  });

  it('A\'s delete first, then B written: B is kept', async () => {
    await writeSession(A);
    await clearSessionIf(A);
    await writeSession(B);
    expect(tokenKept()).toBe(B.token);
  });

  it('the same household with a newer token is not erased either', async () => {
    await writeSession(A);
    await writeSession({ ...A, token: 'synthetic-token-a-0003' });
    await clearSessionIf(A);
    expect(tokenKept()).toBe('synthetic-token-a-0003');
  });

  it('deletes A\'s own credentials when nothing newer is kept', async () => {
    await writeSession(A);
    await clearSessionIf(A);
    expect(tokenKept()).toBeUndefined();
    expect(await readSession()).toBeUndefined();
  });
});
