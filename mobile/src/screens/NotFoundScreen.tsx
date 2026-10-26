// A title page whose address names no title: the fixed Not found, with no call made.
import { Stack } from 'expo-router';

import { DetailFailure } from '../title/components';
import { Screen } from '../ui';

export function NotFoundScreen() {
  return (
    <Screen>
      <Stack.Screen options={{ title: '' }} />
      <DetailFailure error="not_found" onRetry={() => undefined} />
    </Screen>
  );
}
