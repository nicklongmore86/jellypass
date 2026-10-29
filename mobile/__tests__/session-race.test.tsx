// A sign-out (or a household change) that is slow to finish must not undo what the member did meanwhile: the
// household chosen and the sign-in kept after it. Every move has a generation; a sign-out's end only deletes its own
// session's credentials, and only changes the screen if nothing moved the app since. Queries read single fields.
import { act, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SessionProvider, useSession, type Session } from '../src/session/SessionProvider';
import { Root } from '../src/screens/Root';
import { OTHER_ORIGIN, ORIGIN, TOKEN, answer, fakeGateway, fixture, IDENTITY, keepSession, METRICS, settle, shows, store, storedSession } from './support/household';
import { parseHouseholdAddress } from '../src/api/address';

jest.setTimeout(30_000);

const B_TOKEN = 'synthetic-household-b-token-0002';
let session: Session | undefined;
function Probe() {
  session = useSession();
  return null;
}

/** Signed in at ORIGIN; the first sign-out is held until `release()`. */
async function start(withRoot = false) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let logouts = 0;
  const fake = fakeGateway({
    'GET /jellypass/app/v1/me': () => answer(200, fixture('me')),
    'GET /Users/Public': () => answer(200, []),
    'POST /Sessions/Logout': async () => {
      logouts += 1;
      if (logouts === 1) await held;
      return answer(204);
    },
  });
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionProvider deps={{ fetch: fake.fetch, identity: async () => IDENTITY }}>
        <Probe />
        {withRoot ? <Root signedIn={() => null} /> : null}
      </SessionProvider>
    </SafeAreaProvider>,
  );
  await settle();
  return { release: () => act(async () => release()) };
}

/** Picks household B and signs in there, as the screens would. */
async function signInToB() {
  await act(async () => session!.chooseAddress(parseHouseholdAddress(OTHER_ORIGIN)!));
  await act(async () => session!.completeSignIn(session!.household!, { token: B_TOKEN, userId: 'synthetic-user-0002', name: 'Ben' }, session!.epoch()));
  await settle();
}

/** Signs out of A, letting the held sign-out finish. */
async function signOutA(gate: { release: () => Promise<void> }) {
  let out!: Promise<void>;
  await act(async () => {
    out = session!.signOut();
  });
  await gate.release();
  await act(async () => out);
  await settle();
}

beforeEach(() => {
  session = undefined;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
});

describe('a slow sign-out', () => {
  it.each(['signOut', 'changeHousehold'] as const)('(%s) does not erase the household and sign-in chosen while it was out', async (move) => {
    const gate = await start();
    expect(session!.phase.kind).toBe('signedIn');
    let out!: Promise<void>;
    await act(async () => {
      out = session![move]();
    });
    expect(session!.phase.kind).toBe('signingOut');
    await signInToB();
    expect(session!.phase.kind).toBe('signedIn');
    session!.hideHeld.set(false);
    const hide = session!.hideHeld;
    await gate.release();
    await act(async () => out);
    await settle();
    expect([session!.phase.kind, session!.household?.origin, storedSession()?.['token']]).toEqual(['signedIn', OTHER_ORIGIN, B_TOKEN]);
    expect([session!.hideHeld === hide, session!.hideHeld.get()]).toEqual([true, false]);
  });

  it('accepting a setup link while signing out, then signing in there, keeps the new sign-in', async () => {
    const gate = await start();
    let out!: Promise<void>;
    await act(async () => {
      out = session!.signOut();
    });
    await act(async () => session!.offerLink(OTHER_ORIGIN));
    await act(async () => session!.acceptLink());
    expect([session!.phase.kind, session!.household?.origin]).toEqual(['signin', OTHER_ORIGIN]);
    await act(async () => session!.completeSignIn(session!.household!, { token: B_TOKEN, userId: 'synthetic-user-0002', name: 'Ben' }, session!.epoch()));
    await settle();
    await gate.release();
    await act(async () => out);
    await settle();
    expect([session!.phase.kind, storedSession()?.['token']]).toEqual(['signedIn', B_TOKEN]);
  });

  it('still deletes its own credentials when nothing newer was kept, and does not move a newer screen', async () => {
    const gate = await start();
    let out!: Promise<void>;
    await act(async () => {
      out = session!.changeHousehold();
    });
    await act(async () => session!.chooseAddress(parseHouseholdAddress(OTHER_ORIGIN)!));
    await gate.release();
    await act(async () => out);
    await settle();
    expect([session!.phase.kind, session!.household?.origin, storedSession()]).toEqual(['signin', OTHER_ORIGIN, undefined]);
  });

  it("a stale 401 (A's callback, fired after B signed in) leaves B's credentials, phase and Hide choice alone", async () => {
    const gate = await start();
    const staleExpire = session!.expire;
    await signOutA(gate);
    await signInToB();
    session!.hideHeld.set(false);
    await act(async () => staleExpire());
    await settle();
    expect([session!.phase.kind, session!.household?.origin, storedSession()?.['token'], session!.hideHeld.get()]).toEqual(['signedIn', OTHER_ORIGIN, B_TOKEN, false]);
  });

  it("B's own 401 expires B", async () => {
    const gate = await start();
    await signOutA(gate);
    await signInToB();
    await act(async () => session!.expire());
    await settle();
    expect([session!.phase.kind, storedSession()]).toEqual(['signin', undefined]);
  });

  it("a held sign-out of A, then B's 401, then B signed in again: B's sign-in survives A's late end", async () => {
    const gate = await start();
    let out!: Promise<void>;
    await act(async () => {
      out = session!.signOut();
    });
    await signInToB();
    await act(async () => session!.expire());
    await settle();
    expect(session!.phase.kind).toBe('signin');
    await signInToB();
    await gate.release();
    await act(async () => out);
    await settle();
    expect([session!.phase.kind, storedSession()?.['token']]).toEqual(['signedIn', B_TOKEN]);
  });

  it('keeps a setup link waiting while signing out, shown once that is done', async () => {
    const gate = await start(true);
    let out!: Promise<void>;
    await act(async () => {
      out = session!.signOut();
    });
    await act(async () => session!.offerLink(OTHER_ORIGIN));
    await settle();
    expect(screen.queryAllByLabelText('Signing out…').length).toBe(1);
    expect(shows('Continue')).toBe(false);
    await gate.release();
    await act(async () => out);
    await settle();
    expect(shows('Continue')).toBe(true);
  });
});
