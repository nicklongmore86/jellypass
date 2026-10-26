// Who the sign-in says is signing in: the four fields the gateway requires, all non-empty, and the device ID made once.
import { clientIdentity } from '../src/session/identity';
import { store } from './support/household';

jest.mock('expo-crypto', () => ({ randomUUID: () => '0b9c2c1e-4a6f-4f53-9a43-1f3d9b8f0a11' }));
jest.mock('expo-device', () => ({ modelName: 'Pixel 9', DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2 } }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '0.1.0' } } }));

beforeEach(() => store.__items.clear());

describe('the client identity', () => {
  it('names the app, the device model, a kept device ID and the version', async () => {
    const identity = await clientIdentity();
    expect(identity).toEqual({
      client: expect.stringMatching(/^JellyPass (iOS|Android)$/),
      device: 'Pixel 9',
      deviceId: '0b9c2c1e-4a6f-4f53-9a43-1f3d9b8f0a11',
      version: '0.1.0',
    });
    expect((await clientIdentity()).deviceId).toBe(identity.deviceId);
    expect([...store.__items.keys()]).toEqual(['jellypass.device-id']);
  });
});
