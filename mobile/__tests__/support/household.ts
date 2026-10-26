// The sign-in tests' household: a fake gateway on one synthetic address (example.test only), the credential store
// (the in-memory mock in __mocks__/expo-secure-store.ts), and small queries that never print the component tree when
// they fail (a printed tree has run the test runner out of memory before).
import * as SecureStore from 'expo-secure-store';
import { act, fireEvent, screen } from '@testing-library/react-native';

import type { ClientIdentity } from '../../src/api/auth';
import type { FetchLike, RequestInitLike, ResponseLike } from '../../src/api/client';
import { answer } from './app-api';

export { answer, fixture, ORIGIN, TOKEN, ADDRESS } from './app-api';

export const OTHER_ORIGIN = 'https://jelly-elsewhere.example.test';
export const PASSWORD = 'synthetic-password-do-not-log';

export const IDENTITY: ClientIdentity = { client: 'JellyPass iOS', device: 'Test Phone', deviceId: 'synthetic-device-0001', version: '0.1.0' };

export const PROFILES = [
  { Id: 'u-ana', Name: 'Ana Lima', HasPassword: false },
  { Id: 'u-ben', Name: 'ben', HasPassword: true },
];

export function signedInAnswer(name: string, token = 'synthetic-new-token-0001'): ResponseLike {
  return answer(200, { AccessToken: token, ServerId: 'server-1', User: { Id: `u-${name.toLowerCase()}`, Name: name } });
}

export interface Call {
  url: string;
  init: RequestInitLike;
  /** `METHOD path` on whichever origin it went to. */
  route: string;
}

type Responder = (call: Call) => ResponseLike | Promise<ResponseLike>;

/** A fake gateway: `routes` answers `METHOD /path`; anything else is a 404. Every call is recorded. */
export function fakeGateway(routes: Record<string, Responder>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const pathname = url.replace(/^https:\/\/[^/]+/, '').replace(/[?#].*$/, '');
    const call: Call = { url, init, route: `${init.method} ${pathname}` };
    calls.push(call);
    const respond = routes[call.route];
    return respond ? respond(call) : answer(404, { error: 'not_found' });
  };
  return { fetch, calls, routes: () => calls.map((call) => call.route) };
}

export const offline: Responder = () => Promise.reject(new TypeError('Network request failed'));

export interface FakeStore {
  __items: Map<string, { value: string; options: unknown }>;
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
}
export const store = SecureStore as unknown as FakeStore;

export function storedSession(): Record<string, unknown> | undefined {
  const item = store.__items.get('jellypass.session');
  return item ? (JSON.parse(item.value) as Record<string, unknown>) : undefined;
}

export function keepSession(token: string, origin: string, name = 'Ana Lima'): void {
  store.__items.set('jellypass.session', {
    value: JSON.stringify({ address: origin, token, userId: 'u-ana', name }),
    options: { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  });
}

/** Whether some text on screen is (or matches) `text`; `hidden` counts text hidden from screen readers too. */
export function shows(text: string | RegExp, { hidden = false } = {}): boolean {
  return screen.queryAllByText(text, { includeHiddenElements: hidden }).length > 0;
}

function only<T>(found: T[], what: string): T {
  if (found.length !== 1) throw new Error(`expected one ${what}, found ${found.length}`);
  return found[0]!;
}

export function button(label: string) {
  return only(screen.queryAllByRole('button', { name: label }), `button "${label}"`);
}

export function isDisabled(label: string): boolean {
  return button(label).props.accessibilityState?.disabled === true;
}

export async function press(label: string): Promise<void> {
  await fireEvent.press(button(label));
}

export async function type(label: string, text: string): Promise<void> {
  await fireEvent.changeText(only(screen.queryAllByLabelText(label), `field "${label}"`), text);
}

/** Lets every pending promise settle (fake fetches answer in microtasks). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
}
