// The signed-in app: four docked tabs (src/navigation/TabBar.tsx), each with its own stack. Shown only while signed in
// with no setup link waiting; otherwise back to the one sign-in screen (src/app/index.tsx). Android's back button pops
// the tab's stack, then goes to Home, then leaves the app. Every tab shares "Not interested" (src/hidden/HideProvider.tsx):
// its sheet, and its toast just over the tab bar.
import { Redirect, Tabs } from 'expo-router';

import { HideProvider, HideToast } from '@/hidden/HideProvider';
import { TabBar } from '@/navigation/TabBar';
import { TABS } from '@/navigation/tabs';
import { useSession } from '@/session/SessionProvider';
import { colors } from '@/theme';

export default function TabsLayout() {
  const { phase, link } = useSession();
  if (phase.kind !== 'signedIn' || link) return <Redirect href="/" />;
  return (
    <HideProvider>
      <Tabs
        backBehavior="firstRoute"
        tabBar={(props) => (
          <>
            <HideToast />
            <TabBar {...props} />
          </>
        )}
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
      >
        {TABS.map((spec) => (
          <Tabs.Screen key={spec.name} name={spec.name} options={{ title: spec.title }} />
        ))}
      </Tabs>
    </HideProvider>
  );
}
