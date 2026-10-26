// Who is signing in, as Jellyfin lists the session (Dashboard → Devices): the four fields the gateway requires.

import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import type { ClientIdentity } from '../api/auth';
import { deviceId } from './store';

export async function clientIdentity(): Promise<ClientIdentity> {
  return {
    client: Platform.OS === 'ios' ? 'JellyPass iOS' : 'JellyPass Android',
    device: Device.modelName?.trim() || (Platform.OS === 'ios' ? 'iPhone' : 'Android'),
    deviceId: await deviceId(randomUUID),
    version: Constants.expoConfig?.version ?? '0.0.0',
  };
}
