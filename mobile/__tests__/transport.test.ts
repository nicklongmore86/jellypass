// The default transport: with no fetch passed, both clients go through expo/fetch (not React Native's fetch, which
// cannot refuse a redirect: src/api/transport.ts) and every call says `redirect: 'manual'`.
import { fetch as expoFetch } from 'expo/fetch';

import { createApiClient } from '../src/api';
import { createSignInApi } from '../src/signin/signin-api';
import { ADDRESS, TOKEN, answer, fixture } from './support/app-api';
import { IDENTITY, PASSWORD, signedInAnswer } from './support/household';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const sent = expoFetch as unknown as jest.Mock;
const platformFetch = jest.fn();

beforeEach(() => {
  sent.mockReset();
  platformFetch.mockReset();
  globalThis.fetch = platformFetch as unknown as typeof globalThis.fetch;
});

it('the API client sends through expo/fetch, never following a redirect', async () => {
  sent.mockResolvedValue(answer(200, fixture('me')));
  await createApiClient({ address: ADDRESS, token: () => TOKEN }).me();
  expect(sent).toHaveBeenCalledTimes(1);
  expect(sent.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
  expect(platformFetch).not.toHaveBeenCalled();
});

it('sign-in, the profiles and sign-out send through expo/fetch, never following a redirect', async () => {
  const api = createSignInApi({ address: ADDRESS, identity: async () => IDENTITY });
  sent.mockResolvedValueOnce(answer(200, [])).mockResolvedValueOnce(signedInAnswer('Ben', TOKEN)).mockResolvedValueOnce(answer(204));
  await api.profiles();
  await api.signIn('ben', PASSWORD);
  await api.signOut(TOKEN);
  expect(sent).toHaveBeenCalledTimes(3);
  for (const [, init] of sent.mock.calls) expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit' });
  expect(platformFetch).not.toHaveBeenCalled();
});
