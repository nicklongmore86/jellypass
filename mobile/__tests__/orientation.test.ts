// Phones portrait, tablets free: iOS from Info.plist (app-config.test.ts), Android phones locked at launch.
import { DeviceType } from 'expo-device';
import { OrientationLock } from 'expo-screen-orientation';

import { applyOrientation, locksToPortrait } from '../src/orientation';

describe('orientation', () => {
  it('locks only an Android phone', () => {
    expect(locksToPortrait('android', DeviceType.PHONE)).toBe(true);
    expect(locksToPortrait('android', DeviceType.TABLET)).toBe(false);
    expect(locksToPortrait('android', DeviceType.UNKNOWN)).toBe(false);
    expect(locksToPortrait('android', null)).toBe(false);
    // iOS: Info.plist already keeps the iPhone portrait and lets the iPad turn.
    expect(locksToPortrait('ios', DeviceType.PHONE)).toBe(false);
    expect(locksToPortrait('ios', DeviceType.TABLET)).toBe(false);
  });

  it('locks an Android phone to portrait-up, and leaves everything else alone', async () => {
    const lock = jest.fn(async () => undefined);
    await applyOrientation({ os: 'android', deviceType: DeviceType.PHONE, lock });
    expect(lock).toHaveBeenCalledWith(OrientationLock.PORTRAIT_UP);
    lock.mockClear();
    await applyOrientation({ os: 'android', deviceType: DeviceType.TABLET, lock });
    await applyOrientation({ os: 'ios', deviceType: DeviceType.PHONE, lock });
    expect(lock).not.toHaveBeenCalled();
  });

  it('never fails the launch', async () => {
    const lock = jest.fn(() => Promise.reject(new Error('unsupported')));
    await expect(applyOrientation({ os: 'android', deviceType: DeviceType.PHONE, lock })).resolves.toBeUndefined();
  });
});
