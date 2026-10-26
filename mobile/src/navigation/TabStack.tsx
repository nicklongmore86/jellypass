// One tab's stack: its first screen, and the screens pushed on it (title pages and the like, from 3.2 on), each under
// the app's own header. A pushed screen has a Back button; Android's back button and the iOS edge swipe pop it too.
import { Stack } from 'expo-router';

import { colors } from '../theme';
import { Header } from './Header';
import { tab, type TabSpec } from './tabs';

export function TabStack({ name }: { name: TabSpec['name'] }) {
  const spec = tab(name);
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: colors.bg },
        header: ({ options, back, navigation }) => <Header title={options.title} onBack={back ? () => navigation.goBack() : undefined} />,
      }}
    >
      <Stack.Screen name="index" options={{ title: spec.headerTitle ? spec.title : '' }} />
    </Stack>
  );
}
