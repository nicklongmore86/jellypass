import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { applyOrientation } from '@/orientation';
import { SessionProvider } from '@/session/SessionProvider';
import { colors } from '@/theme';

export default function RootLayout() {
  useEffect(() => {
    void applyOrientation();
  }, []);
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
