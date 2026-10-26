import { TabStack } from '@/navigation/TabStack';

// A screen opened from elsewhere with `withAnchor` (or by a link) gets the tab's first screen under it, for Back.
export const unstable_settings = { anchor: 'index' };

export default function RequestsLayout() {
  return <TabStack name="requests" />;
}
