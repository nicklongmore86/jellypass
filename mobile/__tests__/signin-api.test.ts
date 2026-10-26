// The sign-in calls: what they send (by name only, the four client fields, the household address and nothing else),
// how the gateway's answers map to the app's fixed kinds, and that sign-out never fails. No network: a fake gateway.
import { parseHouseholdAddress } from '../src/api/address';
import { createSignInApi, SignInError, SIGN_OUT_TIMEOUT_MS, type SignInApi } from '../src/signin/signin-api';
import { IDENTITY, ORIGIN, PASSWORD, PROFILES, TOKEN, answer, fakeGateway, offline, signedInAnswer } from './support/household';

const ADDRESS = parseHouseholdAddress(ORIGIN)!;

function apiWith(routes: Parameters<typeof fakeGateway>[0], now = () => Date.parse('2026-10-26T12:00:00Z')) {
  const gateway = fakeGateway(routes);
  const api: SignInApi = createSignInApi({ address: ADDRESS, identity: async () => IDENTITY, fetch: gateway.fetch, now });
  return { api, gateway };
}

async function kindOf(promise: Promise<unknown>): Promise<{ kind: string; retryAfter: number | undefined; message: string }> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof SignInError)) throw new Error('expected a SignInError');
  return { kind: error.kind, retryAfter: error.retryAfterSeconds, message: error.message };
}

describe('profiles', () => {
  it('asks the household address for /Users/Public with Accept only, and keeps visible, well-formed members', async () => {
    const { api, gateway } = apiWith({
      'GET /Users/Public': () =>
        answer(200, [...PROFILES, { Id: '', Name: 'blank id' }, { Id: 'u-x', Name: 42 }, 'junk', { Id: 'u-long', Name: 'x'.repeat(257) }, { Id: 'u-c', Name: 'Cy' }]),
    });
    expect(await api.profiles()).toEqual([
      { id: 'u-ana', name: 'Ana Lima', hasPassword: false },
      { id: 'u-ben', name: 'ben', hasPassword: true },
      // No HasPassword at all: a password step, as Jellyfin web would.
      { id: 'u-c', name: 'Cy', hasPassword: true },
    ]);
    const [call] = gateway.calls;
    expect(call!.url).toBe(`${ORIGIN}/Users/Public`);
    expect(call!.init.headers).toEqual({ Accept: 'application/json' });
    expect(call!.init.credentials).toBe('omit');
  });

  it.each([
    [404, { error: 'household_not_found' }, 'not_found'],
    [404, { error: 'not_found' }, 'unavailable'],
    [429, { error: 'too_many_requests' }, 'rate_limited'],
    [502, { error: 'jellyfin_unavailable' }, 'unavailable'],
    [500, 'oops', 'unavailable'],
    [200, { not: 'a list' }, 'unavailable'],
    [200, 'not json', 'unavailable'],
  ])('maps %i %j to %s', async (status, body, kind) => {
    const { api } = apiWith({ 'GET /Users/Public': () => answer(status, body) });
    expect((await kindOf(api.profiles())).kind).toBe(kind);
  });

  it('is offline when there is no answer', async () => {
    const { api } = apiWith({ 'GET /Users/Public': offline });
    expect((await kindOf(api.profiles())).kind).toBe('offline');
  });

  it('reads nothing from an answer redirected off the household', async () => {
    const { api } = apiWith({ 'GET /Users/Public': () => answer(200, PROFILES, {}, 'https://elsewhere.example.test/Users/Public') });
    expect((await kindOf(api.profiles())).kind).toBe('unavailable');
  });
});

describe('sign-in', () => {
  it('signs in by name with the four client fields and the password only in the body', async () => {
    const { api, gateway } = apiWith({ 'POST /Users/AuthenticateByName': () => signedInAnswer('Ben', TOKEN) });
    expect(await api.signIn('ben', PASSWORD)).toEqual({ token: TOKEN, userId: 'u-ben', name: 'Ben' });
    expect(gateway.calls).toHaveLength(1);
    const [{ url, init }] = gateway.calls as [(typeof gateway.calls)[number]];
    expect(url).toBe(`${ORIGIN}/Users/AuthenticateByName`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'MediaBrowser Client="JellyPass%20iOS", Device="Test%20Phone", DeviceId="synthetic-device-0001", Version="0.1.0"',
    });
    expect(JSON.parse(init.body!)).toEqual({ Username: 'ben', Pw: PASSWORD });
    expect(url).not.toContain(PASSWORD);
    expect(JSON.stringify(init.headers)).not.toContain(PASSWORD);
  });

  it('never signs in by user ID', async () => {
    const { api, gateway } = apiWith({ 'POST /Users/AuthenticateByName': () => signedInAnswer('Ana') });
    await api.signIn('Ana Lima', '');
    expect(gateway.routes()).toEqual(['POST /Users/AuthenticateByName']);
    expect(gateway.calls.some((call) => /\/Users\/[^/]+\/Authenticate/i.test(call.url))).toBe(false);
  });

  it.each([
    [400, 'unavailable'],
    [401, 'invalid'],
    [403, 'invalid'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
  ])('maps a %i refusal to %s, and the error says nothing else', async (status, kind) => {
    const { api } = apiWith({ 'POST /Users/AuthenticateByName': () => answer(status, { error: 'invalid_credentials', detail: 'ben' }) });
    const failure = await kindOf(api.signIn('ben', PASSWORD));
    expect(failure).toEqual({ kind, retryAfter: undefined, message: kind });
  });

  it('reads Retry-After on a 429, in seconds or as a date', async () => {
    const seconds = apiWith({ 'POST /Users/AuthenticateByName': () => answer(429, { error: 'too_many_login_attempts' }, { 'Retry-After': '42' }) });
    expect((await kindOf(seconds.api.signIn('ben', PASSWORD))).retryAfter).toBe(42);
    const date = apiWith({
      'POST /Users/AuthenticateByName': () => answer(429, {}, { 'Retry-After': 'Mon, 26 Oct 2026 12:01:30 GMT' }),
    });
    expect((await kindOf(date.api.signIn('ben', PASSWORD))).retryAfter).toBe(90);
    const junk = apiWith({ 'POST /Users/AuthenticateByName': () => answer(429, {}, { 'Retry-After': 'soon' }) });
    expect((await kindOf(junk.api.signIn('ben', PASSWORD))).retryAfter).toBeUndefined();
  });

  it('is offline with no answer, and unavailable for a 200 without a token or user', async () => {
    expect((await kindOf(apiWith({ 'POST /Users/AuthenticateByName': offline }).api.signIn('ben', PASSWORD))).kind).toBe('offline');
    for (const body of [{}, { AccessToken: TOKEN }, { User: { Id: 'u' } }, { AccessToken: '', User: { Id: 'u' } }, 'nope']) {
      const { api } = apiWith({ 'POST /Users/AuthenticateByName': () => answer(200, body) });
      expect((await kindOf(api.signIn('ben', PASSWORD))).kind).toBe('unavailable');
    }
  });

  it('falls back to the typed name when the answer has none', async () => {
    const { api } = apiWith({ 'POST /Users/AuthenticateByName': () => answer(200, { AccessToken: TOKEN, User: { Id: 'u-ben' } }) });
    expect((await api.signIn('ben', PASSWORD)).name).toBe('ben');
  });

  it('is a storage failure, with no call, when the device ID cannot be had', async () => {
    const gateway = fakeGateway({});
    const api = createSignInApi({ address: ADDRESS, identity: () => Promise.reject(new Error('keychain locked')), fetch: gateway.fetch });
    expect((await kindOf(api.signIn('ben', PASSWORD))).kind).toBe('storage');
    expect(gateway.calls).toEqual([]);
  });
});

describe('sign-out', () => {
  it('POSTs /Sessions/Logout on the household with the token, so the gateway forgets the session', async () => {
    const { api, gateway } = apiWith({ 'POST /Sessions/Logout': () => answer(204) });
    await api.signOut(TOKEN);
    expect(gateway.calls.map(({ url, init }) => [url, init.method, init.headers])).toEqual([
      [`${ORIGIN}/Sessions/Logout`, 'POST', { Authorization: `MediaBrowser Token="${TOKEN}"` }],
    ]);
  });

  it('never throws: offline, refused or unavailable', async () => {
    for (const respond of [offline, () => answer(401), () => answer(502)]) {
      const { api } = apiWith({ 'POST /Sessions/Logout': respond });
      await expect(api.signOut(TOKEN)).resolves.toBeUndefined();
    }
  });

  it('gives up after five seconds', async () => {
    jest.useFakeTimers();
    try {
      let aborted = false;
      const api = createSignInApi({
        address: ADDRESS,
        identity: async () => IDENTITY,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
      });
      const done = api.signOut(TOKEN);
      jest.advanceTimersByTime(SIGN_OUT_TIMEOUT_MS - 1);
      expect(aborted).toBe(false);
      jest.advanceTimersByTime(1);
      await expect(done).resolves.toBeUndefined();
      expect(aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
