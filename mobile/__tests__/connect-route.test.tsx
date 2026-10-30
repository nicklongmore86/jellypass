// The `jellypass://connect?address=...` route: it hands the address to the session as an offer (shown for the member
// to confirm) and goes on to the one screen. It makes no call and keeps nothing.
import { render } from '@testing-library/react-native';

import Connect from '../src/app/connect';
import { SessionProvider } from '../src/session/SessionProvider';
import { Root } from '../src/screens/Root';
import { IDENTITY, ORIGIN, fakeGateway, settle, shows, store, storedSession } from './support/household';

const mockParams: { address?: string | string[] } = {};
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  router: { replace: (href: string) => mockReplace(href) },
}));

beforeEach(() => {
  store.__items.clear();
  mockReplace.mockClear();
  delete mockParams.address;
});

async function open() {
  const gateway = fakeGateway({});
  await render(
    <SessionProvider deps={{ fetch: gateway.fetch, identity: async () => IDENTITY }}>
      <Connect />
      <Root />
    </SessionProvider>,
  );
  await settle();
  return gateway;
}

describe('the connect link', () => {
  it('offers its address for confirmation, then goes to the app', async () => {
    mockParams.address = ORIGIN;
    const gateway = await open();
    expect(shows('Connect to this household?')).toBe(true);
    expect(shows('media.example.com')).toBe(true);
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(gateway.calls).toEqual([]);
    expect(storedSession()).toBeUndefined();
  });

  it('without a household address says it cannot be used', async () => {
    for (const address of ['https://media.example.com/web', 'http://media.example.com', 'https://token@media.example.com', 'https://media.example.com/?token=x']) {
      mockParams.address = address;
      const gateway = await open();
      expect([address, shows("Can't use this link")]).toEqual([address, true]);
      expect(gateway.calls).toEqual([]);
      expect(storedSession()).toBeUndefined();
    }
  });

  it('offers any HTTPS household address, with its port, for confirmation', async () => {
    mockParams.address = 'https://films.example.net:8443';
    const gateway = await open();
    expect(shows('Connect to this household?')).toBe(true);
    expect(shows('films.example.net:8443')).toBe(true);
    expect(gateway.calls).toEqual([]);
    expect(storedSession()).toBeUndefined();
  });
});
