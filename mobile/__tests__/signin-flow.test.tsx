// The sign-in as a member goes through it: the address step, a setup link's confirmation, the profile picker (one tap
// for a passwordless member, a password step for the others, a name for a hidden member), every fixed failure, a 429's
// Retry-After, the start-up check of a kept sign-in, and sign-out. A fake gateway answers; the credential store is the
// in-memory mock. Queries never print the component tree (support/household.ts).
import { act, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AccountScreen } from '../src/screens/AccountScreen';
import { SessionProvider, useSession } from '../src/session/SessionProvider';
import { Root } from '../src/screens/Root';
import { ADDRESS_TEXT, SIGNIN_ERROR_TEXT, SIGNIN_NAME_TEXT, STALLED_TEXT } from '../src/signin/wording';
import {
  IDENTITY,
  METRICS,
  ORIGIN,
  OTHER_ORIGIN,
  PASSWORD,
  PROFILES,
  TOKEN,
  answer,
  button,
  fakeGateway,
  fixture,
  isDisabled,
  keepSession,
  offline,
  press,
  settle,
  shows,
  signedInAnswer,
  store,
  storedSession,
  type,
} from './support/household';

type Routes = Parameters<typeof fakeGateway>[0];

const ME = () => answer(200, fixture('me'));
const HOUSEHOLD = { 'GET /Users/Public': () => answer(200, PROFILES), 'GET /jellypass/app/v1/me': ME, 'POST /Sessions/Logout': () => answer(204) };

let offer: ((param: string | string[] | undefined) => void) | undefined;
function LinkProbe() {
  offer = useSession().offerLink;
  return null;
}

async function start(routes: Routes, now = () => Date.parse('2026-10-26T12:00:00Z')) {
  const gateway = fakeGateway(routes);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionProvider deps={{ fetch: gateway.fetch, identity: async () => IDENTITY, now }}>
        <LinkProbe />
        <Root signedIn={(me) => <AccountScreen me={me} />} />
      </SessionProvider>
    </SafeAreaProvider>,
  );
  await settle();
  return gateway;
}

async function openLink(param: string | string[] | undefined) {
  await act(async () => offer!(param));
  await settle();
}

async function toPicker(routes: Routes) {
  const gateway = await start(routes);
  await type('Household address', 'jelly-household.example.test');
  await press('Continue');
  await settle();
  return gateway;
}

beforeEach(() => {
  store.__items.clear();
  jest.clearAllMocks();
  offer = undefined;
});

describe('the address step', () => {
  it('starts there with nothing kept, and suggests no household', async () => {
    const gateway = await start(HOUSEHOLD);
    expect(shows('Connect to your household')).toBe(true);
    expect(shows(/jelly-[a-z]/)).toBe(false);
    expect(gateway.calls).toEqual([]);
  });

  it('refuses an address that is not a household one, without a call', async () => {
    const gateway = await start(HOUSEHOLD);
    for (const typed of ['jellyfin.example.test', 'http://jelly-household.example.test', 'jelly-household.example.test:8096']) {
      await type('Household address', typed);
      await press('Continue');
      expect(shows(ADDRESS_TEXT.invalid)).toBe(true);
    }
    expect(gateway.calls).toEqual([]);
  });

  it('goes on to the household picker on that address only', async () => {
    const gateway = await toPicker(HOUSEHOLD);
    expect(shows('Choose your profile to sign in.')).toBe(true);
    expect(shows('jelly-household.example.test')).toBe(true);
    expect(gateway.calls.map((call) => call.url)).toEqual([`${ORIGIN}/Users/Public`]);
  });
});

describe('a setup link', () => {
  it('is confirmed before it is used, and never signs anyone in by itself', async () => {
    const gateway = await start(HOUSEHOLD);
    await openLink(ORIGIN);
    expect(shows('Connect to this household?')).toBe(true);
    expect(shows('jelly-household.example.test')).toBe(true);
    expect(gateway.calls).toEqual([]);
    expect(storedSession()).toBeUndefined();
    await press('Continue');
    await settle();
    expect(shows('Choose your profile to sign in.')).toBe(true);
    expect(gateway.routes()).toEqual(['GET /Users/Public']);
    expect(storedSession()).toBeUndefined();
  });

  it('can be cancelled', async () => {
    const gateway = await start(HOUSEHOLD);
    await openLink(ORIGIN);
    await press('Cancel');
    expect(shows('Connect to your household')).toBe(true);
    expect(gateway.calls).toEqual([]);
  });

  it('that names no household address is refused', async () => {
    const gateway = await start(HOUSEHOLD);
    for (const param of [undefined, 'https://evil.example.test', 'jelly-household.example.test', [ORIGIN, OTHER_ORIGIN]]) {
      await openLink(param);
      expect(shows(ADDRESS_TEXT.badLink)).toBe(true);
      await press('OK');
      expect(shows('Connect to your household')).toBe(true);
    }
    expect(gateway.calls).toEqual([]);
  });

  it('to another household while signed in says so, and signs out first', async () => {
    keepSession(TOKEN, ORIGIN);
    const gateway = await start(HOUSEHOLD);
    expect(shows('Synthetic Member · Synthetic Household')).toBe(true);
    await openLink(OTHER_ORIGIN);
    expect(shows(/signed in to jelly-household\.example\.test.*signs you out/)).toBe(true);
    await press('Continue');
    await settle();
    expect(gateway.calls.map((call) => call.url)).toEqual([
      `${ORIGIN}/jellypass/app/v1/me`,
      `${ORIGIN}/Sessions/Logout`,
      `${OTHER_ORIGIN}/Users/Public`,
    ]);
    expect(storedSession()).toBeUndefined();
  });

  it('to the household already signed in to is let be', async () => {
    keepSession(TOKEN, ORIGIN);
    const gateway = await start(HOUSEHOLD);
    await openLink(ORIGIN);
    expect(shows('Synthetic Member · Synthetic Household')).toBe(true);
    expect(gateway.routes()).toEqual(['GET /jellypass/app/v1/me']);
  });
});

describe('the profile picker', () => {
  it('lists the members the gateway lists, with initials, and always a way in by name', async () => {
    await toPicker(HOUSEHOLD);
    expect(shows('Ana Lima')).toBe(true);
    expect(shows('ben')).toBe(true);
    // The initials are decoration, hidden from screen readers: the button's name is the member's name.
    expect(shows('AL', { hidden: true })).toBe(true);
    expect(shows('B', { hidden: true })).toBe(true);
    expect(shows('AL')).toBe(false);
    expect(button('Sign in with a different name')).toBeTruthy();
  });

  it('signs a passwordless member in with one tap, keeps the sign-in and shows /me', async () => {
    const gateway = await toPicker({ ...HOUSEHOLD, 'POST /Users/AuthenticateByName': () => signedInAnswer('Ana Lima', TOKEN) });
    await press('Ana Lima');
    await settle();
    const signIn = gateway.calls.find((call) => call.route === 'POST /Users/AuthenticateByName')!;
    expect(JSON.parse(signIn.init.body!)).toEqual({ Username: 'Ana Lima', Pw: '' });
    expect(storedSession()).toEqual({ address: ORIGIN, token: TOKEN, userId: 'u-ana lima', name: 'Ana Lima' });
    expect(gateway.calls.at(-1)!.init.headers.Authorization).toBe(`MediaBrowser Token="${TOKEN}"`);
    expect(shows('Synthetic Member · Synthetic Household')).toBe(true);
    expect(button('Sign out')).toBeTruthy();
  });

  it('gives a passwordless member who now has a password the password step', async () => {
    await toPicker({ ...HOUSEHOLD, 'POST /Users/AuthenticateByName': () => answer(401, { error: 'invalid_credentials' }) });
    await press('Ana Lima');
    await settle();
    expect(shows('Sign in as Ana Lima')).toBe(true);
    expect(shows(SIGNIN_ERROR_TEXT.invalid)).toBe(true);
  });

  it('asks a member with a password for it, and refuses an empty one without a call', async () => {
    const gateway = await toPicker(HOUSEHOLD);
    await press('ben');
    expect(shows('Sign in as ben')).toBe(true);
    await press('Sign in');
    expect(shows(SIGNIN_ERROR_TEXT.invalid)).toBe(true);
    expect(gateway.routes()).toEqual(['GET /Users/Public']);
    await press('Choose another profile');
    expect(shows('Choose your profile to sign in.')).toBe(true);
  });

  it('signs in with the password, which goes only in that one request and leaves the field', async () => {
    let attempts = 0;
    const gateway = await toPicker({
      ...HOUSEHOLD,
      'POST /Users/AuthenticateByName': () => (++attempts === 1 ? answer(401, { error: 'invalid_credentials' }) : signedInAnswer('ben', TOKEN)),
    });
    await press('ben');
    await type('Password', 'wrong-one');
    await press('Sign in');
    await settle();
    expect(shows(SIGNIN_ERROR_TEXT.invalid)).toBe(true);
    await type('Password', PASSWORD);
    await press('Sign in');
    await settle();
    const bodies = gateway.calls.filter((call) => call.route === 'POST /Users/AuthenticateByName').map((call) => JSON.parse(call.init.body!));
    expect(bodies).toEqual([
      { Username: 'ben', Pw: 'wrong-one' },
      { Username: 'ben', Pw: PASSWORD },
    ]);
    expect(JSON.stringify(storedSession())).not.toContain(PASSWORD);
    expect(gateway.calls.filter((call) => JSON.stringify(call).includes(PASSWORD))).toHaveLength(1);
    expect(shows('Synthetic Member · Synthetic Household')).toBe(true);
  });
});

describe('sign-in with a different name', () => {
  it('is for a member the picker does not list, with its own fixed wording', async () => {
    let attempts = 0;
    const gateway = await toPicker({
      ...HOUSEHOLD,
      'POST /Users/AuthenticateByName': () => (++attempts === 1 ? answer(401, { error: 'invalid_credentials' }) : signedInAnswer('Hidden', TOKEN)),
    });
    await press('Sign in with a different name');
    await press('Sign in');
    expect(shows(SIGNIN_NAME_TEXT.missing)).toBe(true);
    await type('Name', '  hidden  ');
    await type('Password', 'nope');
    await press('Sign in');
    await settle();
    expect(shows(SIGNIN_NAME_TEXT.invalid)).toBe(true);
    await type('Password', PASSWORD);
    await press('Sign in');
    await settle();
    const bodies = gateway.calls.filter((call) => call.route === 'POST /Users/AuthenticateByName').map((call) => JSON.parse(call.init.body!));
    expect(bodies).toEqual([
      { Username: 'hidden', Pw: 'nope' },
      { Username: 'hidden', Pw: PASSWORD },
    ]);
    expect(storedSession()?.name).toBe('Hidden');
  });

  it('is the first screen when the picker lists nobody, with no way back to it', async () => {
    await toPicker({ ...HOUSEHOLD, 'GET /Users/Public': () => answer(200, []) });
    expect(shows('Enter your Jellyfin name and password.')).toBe(true);
    expect(shows('Choose a profile')).toBe(false);
  });

  it('goes back to the picker', async () => {
    await toPicker(HOUSEHOLD);
    await press('Sign in with a different name');
    await press('Choose a profile');
    expect(shows('Choose your profile to sign in.')).toBe(true);
  });
});

describe('failures', () => {
  it.each([
    ['400', () => answer(400, { error: 'invalid_request' }), SIGNIN_ERROR_TEXT.unavailable],
    ['401', () => answer(401, { error: 'invalid_credentials' }), SIGNIN_ERROR_TEXT.invalid],
    ['403', () => answer(403, {}), SIGNIN_ERROR_TEXT.invalid],
    ['429', () => answer(429, { error: 'too_many_login_attempts' }), SIGNIN_ERROR_TEXT.rate_limited],
    ['502', () => answer(502, { error: 'jellyfin_unavailable' }), SIGNIN_ERROR_TEXT.unavailable],
    ['500', () => answer(500, 'Internal error at ben'), SIGNIN_ERROR_TEXT.unavailable],
    ['no answer', offline, SIGNIN_ERROR_TEXT.offline],
  ])('a sign-in refused with %s shows the fixed message', async (_what, respond, text) => {
    await toPicker({ ...HOUSEHOLD, 'POST /Users/AuthenticateByName': respond });
    await press('ben');
    await type('Password', PASSWORD);
    await press('Sign in');
    await settle();
    expect(shows(text)).toBe(true);
    expect(shows(/invalid_|jellyfin_|too_many|Internal/)).toBe(false);
    expect(storedSession()).toBeUndefined();
  });

  it.each([
    ['no answer', offline, SIGNIN_ERROR_TEXT.offline],
    ['502', () => answer(502, { error: 'jellyfin_unavailable' }), SIGNIN_ERROR_TEXT.unavailable],
    ['429', () => answer(429, { error: 'too_many_requests' }), SIGNIN_ERROR_TEXT.rate_limited],
    ['an address no household has', () => answer(404, { error: 'household_not_found' }), SIGNIN_ERROR_TEXT.not_found],
  ])('profiles that cannot be loaded (%s) show the fixed message, a retry and the way to change household', async (_what, respond, text) => {
    let loads = 0;
    await toPicker({ ...HOUSEHOLD, 'GET /Users/Public': (call) => (++loads === 1 ? respond(call) : answer(200, PROFILES)) });
    expect(shows(text)).toBe(true);
    await press('Try again');
    await settle();
    expect(shows('Choose your profile to sign in.')).toBe(true);
  });

  it('a sign-in that cannot be kept on the device is revoked and says so', async () => {
    const gateway = await toPicker({ ...HOUSEHOLD, 'POST /Users/AuthenticateByName': () => signedInAnswer('Ana Lima', TOKEN) });
    store.setItemAsync.mockRejectedValueOnce(new Error('keychain'));
    await press('Ana Lima');
    await settle();
    expect(shows(SIGNIN_ERROR_TEXT.storage)).toBe(true);
    expect(gateway.calls.at(-1)!.route).toBe('POST /Sessions/Logout');
    expect(gateway.calls.at(-1)!.init.headers.Authorization).toBe(`MediaBrowser Token="${TOKEN}"`);
  });
});

describe("a 429's Retry-After", () => {
  afterEach(() => jest.useRealTimers());

  it('holds Sign in and the profiles for as long as it says, then lets the member try again', async () => {
    jest.useFakeTimers();
    await toPicker({ ...HOUSEHOLD, 'POST /Users/AuthenticateByName': () => answer(429, { error: 'too_many_login_attempts' }, { 'Retry-After': '30' }) });
    await press('Ana Lima');
    await settle();
    expect(shows(SIGNIN_ERROR_TEXT.rate_limited)).toBe(true);
    expect(isDisabled('Ana Lima')).toBe(true);
    expect(isDisabled('ben')).toBe(true);
    await act(async () => jest.advanceTimersByTime(29_000));
    expect(isDisabled('Ana Lima')).toBe(true);
    await act(async () => jest.advanceTimersByTime(1000));
    expect(isDisabled('Ana Lima')).toBe(false);
  });

  it('without one, holds nothing (as the PWA)', async () => {
    await toPicker({ ...HOUSEHOLD, 'POST /Users/AuthenticateByName': () => answer(429, { error: 'too_many_login_attempts' }) });
    await press('ben');
    await type('Password', PASSWORD);
    await press('Sign in');
    await settle();
    expect(shows(SIGNIN_ERROR_TEXT.rate_limited)).toBe(true);
    expect(isDisabled('Sign in')).toBe(false);
  });

  it('on the profiles holds Try again', async () => {
    jest.useFakeTimers();
    await toPicker({ ...HOUSEHOLD, 'GET /Users/Public': () => answer(429, { error: 'too_many_requests' }, { 'Retry-After': '5' }) });
    expect(isDisabled('Try again')).toBe(true);
    await act(async () => jest.advanceTimersByTime(5000));
    expect(isDisabled('Try again')).toBe(false);
  });
});

describe('a sign-in that finishes after the app moved on', () => {
  // A setup link to another household is accepted while a sign-in is out: the old household's answer must not sign the
  // app in there, nor start /me; its token is revoked at the household it came from.
  const STALE = 'synthetic-stale-token-0001';

  function deferred() {
    let resolve!: (response: ReturnType<typeof answer>) => void;
    const promise = new Promise<ReturnType<typeof answer>>((done) => (resolve = done));
    return { promise, resolve };
  }

  async function acceptOtherHousehold() {
    await openLink(OTHER_ORIGIN);
    await press('Continue');
    await settle();
    expect(shows('jelly-elsewhere.example.test')).toBe(true);
  }

  function expectRevokedOnly(gateway: Awaited<ReturnType<typeof start>>) {
    expect(storedSession()).toBeUndefined();
    expect(gateway.routes()).not.toContain('GET /jellypass/app/v1/me');
    const logouts = gateway.calls.filter((call) => call.route === 'POST /Sessions/Logout');
    expect(logouts.map((call) => [call.url, call.init.headers.Authorization])).toEqual([[`${ORIGIN}/Sessions/Logout`, `MediaBrowser Token="${STALE}"`]]);
    expect(shows('Choose your profile to sign in.')).toBe(true);
    expect(shows('jelly-elsewhere.example.test')).toBe(true);
    expect(shows('Synthetic Member · Synthetic Household')).toBe(false);
  }

  it('while the sign-in is out: not kept, no /me, revoked at the original household', async () => {
    const pending = deferred();
    const gateway = await toPicker({ ...HOUSEHOLD, 'POST /Users/AuthenticateByName': () => pending.promise });
    await press('Ana Lima');
    await settle();
    await acceptOtherHousehold();
    pending.resolve(signedInAnswer('Ana Lima', STALE));
    await settle();
    expectRevokedOnly(gateway);
    expect(store.setItemAsync).not.toHaveBeenCalledWith('jellypass.session', expect.anything(), expect.anything());
  });

  it('while the sign-in is being kept: forgotten again, no /me, revoked at the original household', async () => {
    const gateway = await toPicker({ ...HOUSEHOLD, 'POST /Users/AuthenticateByName': () => signedInAnswer('Ana Lima', STALE) });
    let written!: () => void;
    store.setItemAsync.mockImplementationOnce(
      (key: string, value: string, options: unknown) =>
        new Promise<void>((done) => {
          written = () => {
            store.__items.set(key, { value, options });
            done();
          };
        }),
    );
    await press('Ana Lima');
    await settle();
    await acceptOtherHousehold();
    written();
    await settle();
    expectRevokedOnly(gateway);
  });
});

describe('at start', () => {
  it('checks a kept sign-in with GET /me and shows who and which household', async () => {
    keepSession(TOKEN, ORIGIN);
    const gateway = await start(HOUSEHOLD);
    expect(gateway.calls.map((call) => [call.url, call.init.headers.Authorization])).toEqual([
      [`${ORIGIN}/jellypass/app/v1/me`, `MediaBrowser Token="${TOKEN}"`],
    ]);
    expect(shows('Synthetic Member · Synthetic Household')).toBe(true);
  });

  it('drops a sign-in /me refuses (401) and shows the picker, saying it expired', async () => {
    keepSession(TOKEN, ORIGIN);
    const gateway = await start({ ...HOUSEHOLD, 'GET /jellypass/app/v1/me': () => answer(401, { error: 'unauthorized' }) });
    expect(storedSession()).toBeUndefined();
    expect(shows('Your sign-in has expired. Choose your profile to sign in again.')).toBe(true);
    expect(gateway.routes()).toEqual(['GET /jellypass/app/v1/me', 'GET /Users/Public']);
  });

  it.each([
    ['no answer', offline, STALLED_TEXT.offline],
    ['502', () => answer(502, { error: 'unavailable' }), STALLED_TEXT.unavailable],
    ['429', () => answer(429, { error: 'too_many_requests' }), STALLED_TEXT.rate_limited],
    ['household_not_found', () => answer(404, { error: 'household_not_found' }), STALLED_TEXT.not_found],
  ])('keeps the sign-in when /me cannot answer (%s), and offers a retry', async (_what, respond, text) => {
    keepSession(TOKEN, ORIGIN);
    let checks = 0;
    await start({ ...HOUSEHOLD, 'GET /jellypass/app/v1/me': (call) => (++checks === 1 ? respond(call) : ME()) });
    expect(shows(text)).toBe(true);
    expect(storedSession()?.token).toBe(TOKEN);
    await press('Try again');
    await settle();
    expect(shows('Synthetic Member · Synthetic Household')).toBe(true);
  });
});

describe("a 429's Retry-After at start", () => {
  afterEach(() => jest.useRealTimers());

  it('holds Try again until it has passed, and never checks again by itself', async () => {
    jest.useFakeTimers();
    keepSession(TOKEN, ORIGIN);
    let checks = 0;
    const gateway = await start(
      { ...HOUSEHOLD, 'GET /jellypass/app/v1/me': () => (++checks === 1 ? answer(429, { error: 'too_many_requests' }, { 'Retry-After': '30' }) : ME()) },
      () => Date.now(),
    );
    expect(shows(STALLED_TEXT.rate_limited)).toBe(true);
    expect(isDisabled('Try again')).toBe(true);
    await press('Try again');
    await act(async () => jest.advanceTimersByTime(29_000));
    expect(isDisabled('Try again')).toBe(true);
    expect(gateway.routes()).toEqual(['GET /jellypass/app/v1/me']);
    await act(async () => jest.advanceTimersByTime(1000));
    expect(isDisabled('Try again')).toBe(false);
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(gateway.routes()).toEqual(['GET /jellypass/app/v1/me']);
    await press('Try again');
    await settle();
    expect(shows('Synthetic Member · Synthetic Household')).toBe(true);
    expect(gateway.routes()).toEqual(['GET /jellypass/app/v1/me', 'GET /jellypass/app/v1/me']);
  });

  it('without one, holds nothing', async () => {
    keepSession(TOKEN, ORIGIN);
    await start({ ...HOUSEHOLD, 'GET /jellypass/app/v1/me': () => answer(429, { error: 'too_many_requests' }) });
    expect(isDisabled('Try again')).toBe(false);
  });
});

describe('sign-out', () => {
  it('asks the gateway to forget the session, clears the device and shows the picker again', async () => {
    keepSession(TOKEN, ORIGIN);
    const gateway = await start(HOUSEHOLD);
    await press('Sign out');
    await settle();
    const logout = gateway.calls.find((call) => call.route === 'POST /Sessions/Logout')!;
    expect(logout.url).toBe(`${ORIGIN}/Sessions/Logout`);
    expect(logout.init.headers.Authorization).toBe(`MediaBrowser Token="${TOKEN}"`);
    expect(storedSession()).toBeUndefined();
    expect(shows('Choose your profile to sign in.')).toBe(true);
  });

  it.each([
    ['offline', offline],
    ['refused', () => answer(502, { error: 'jellyfin_unavailable' })],
  ])('clears the device even when the gateway cannot be told (%s)', async (_what, respond) => {
    keepSession(TOKEN, ORIGIN);
    await start({ ...HOUSEHOLD, 'POST /Sessions/Logout': respond });
    await press('Sign out');
    await settle();
    expect(storedSession()).toBeUndefined();
    expect(store.deleteItemAsync).toHaveBeenCalled();
  });

  it('from a sign-in that could not be checked still tells the gateway and clears the device', async () => {
    keepSession(TOKEN, ORIGIN);
    const gateway = await start({ ...HOUSEHOLD, 'GET /jellypass/app/v1/me': offline, 'POST /Sessions/Logout': offline });
    await press('Sign out');
    await settle();
    expect(gateway.routes()).toContain('POST /Sessions/Logout');
    expect(storedSession()).toBeUndefined();
  });

  it('Change household signs out first, then asks for an address', async () => {
    keepSession(TOKEN, ORIGIN);
    const gateway = await start(HOUSEHOLD);
    await press('Change household');
    await settle();
    expect(gateway.routes()).toEqual(['GET /jellypass/app/v1/me', 'POST /Sessions/Logout']);
    expect(storedSession()).toBeUndefined();
    expect(shows('Connect to your household')).toBe(true);
  });

  it('from the picker, Change household goes back to the address step', async () => {
    await toPicker(HOUSEHOLD);
    await press('Change household');
    await settle();
    expect(shows('Connect to your household')).toBe(true);
  });
});

describe('logs', () => {
  it('get no token and no password, through a whole sign-in and sign-out', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => jest.spyOn(console, method));
    try {
      await toPicker({ ...HOUSEHOLD, 'POST /Users/AuthenticateByName': () => signedInAnswer('ben', TOKEN) });
      await press('ben');
      await type('Password', PASSWORD);
      await press('Sign in');
      await settle();
      await press('Sign out');
      await settle();
      const logged = spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(' ')));
      expect(logged.filter((line) => line.includes(TOKEN) || line.includes(PASSWORD))).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
