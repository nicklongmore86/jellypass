// Phones stay portrait; tablets turn freely. iOS does it from Info.plist (app.config.ts): the iPhone portrait, the
// iPad all four ways. Android has no per-form-factor manifest setting, so the app starts unlocked
// (`orientation: 'default'`) and locks an Android phone to portrait here, once, at launch.

import * as Device from 'expo-device';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Platform } from 'react-native';

export interface OrientationDeps {
  os: string;
  deviceType: Device.DeviceType | null;
  lock: (orientation: ScreenOrientation.OrientationLock) => Promise<void>;
}

/** Whether this device is held to portrait at run time: an Android phone, and nothing else (a tablet, a TV or unknown). */
export function locksToPortrait(os: string, deviceType: Device.DeviceType | null): boolean {
  return os === 'android' && deviceType === Device.DeviceType.PHONE;
}

export async function applyOrientation(
  deps: OrientationDeps = { os: Platform.OS, deviceType: Device.deviceType, lock: ScreenOrientation.lockAsync },
): Promise<void> {
  if (!locksToPortrait(deps.os, deps.deviceType)) return;
  try {
    // PORTRAIT_UP: many Android phones refuse upside-down, which makes PORTRAIT invalid on them.
    await deps.lock(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  } catch {
    // The phone just turns, as before.
  }
}
