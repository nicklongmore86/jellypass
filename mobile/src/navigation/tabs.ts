// The four tabs of the signed-in app, in the PWA's order with its labels (app/static/index.html's tab bar). Each is a
// route group under src/app/(tabs) with its own stack, so a pushed screen keeps its tab and gets a Back button.
import type { IconName } from '../icons';

export interface TabSpec {
  /** The route under src/app/(tabs). */
  name: 'home' | 'search' | 'requests' | 'account';
  /** The tab's label and its screen's title. */
  title: string;
  icon: IconName;
  /** Whether the header shows the title on the tab's first screen. Home's header is bare, as in the PWA. */
  headerTitle: boolean;
}

export const TABS: readonly TabSpec[] = [
  { name: 'home', title: 'Home', icon: 'home', headerTitle: false },
  { name: 'search', title: 'Search', icon: 'search', headerTitle: true },
  { name: 'requests', title: 'My requests', icon: 'requests', headerTitle: true },
  { name: 'account', title: 'Account', icon: 'account', headerTitle: true },
];

export function tab(name: TabSpec['name']): TabSpec {
  return TABS.find((spec) => spec.name === name)!;
}
