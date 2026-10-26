// The docked tab bar, the PWA's `.tabbar`: full width on the screen's foot, rounded at the top, over the home
// indicator's safe area, four tabs of equal width. The active tab is a cyan-tint squircle with a cyan outline (3:1
// against the bar) behind its icon and label, and a heavier icon stroke: shape and weight, not colour alone. Labels wrap
// rather than clip at large text sizes, and the bar grows with them.
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../icons';
import { colors, layout, radii, spacing } from '../theme';
import { tab, type TabSpec } from './tabs';

/** The stylesheet's `.tabbar .icon`, 1.5rem, and the active tab's 2.4 stroke. */
const TAB_ICON = 24;
const ACTIVE_STROKE = 2.4;

export function TabBar({ state, descriptors, emitter, navigateToTab, insets }: BottomTabBarProps) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="Main"
      testID="tabbar"
      style={[
        styles.bar,
        {
          paddingBottom: spacing.sm + insets.bottom,
          paddingLeft: Math.max(spacing.md, insets.left),
          paddingRight: Math.max(spacing.md, insets.right),
        },
      ]}
    >
      {state.routes.map((route, index) => {
        const spec = tab(route.name as TabSpec['name']);
        const focused = index === state.index;
        const title = descriptors[route.key]?.options.title ?? spec.title;
        const onPress = () => {
          const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigateToTab(route.key);
        };
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityLabel={title}
            accessibilityHint={`Tab ${index + 1} of ${state.routes.length}`}
            accessibilityState={{ selected: focused }}
            testID={`tab-${route.name}`}
            onPress={onPress}
            onLongPress={() => emitter.emit({ type: 'tabLongPress', target: route.key })}
            style={({ pressed }) => [styles.tab, focused && styles.tabActive, pressed && !focused && styles.pressed]}
          >
            <Icon name={spec.icon} color={focused ? colors.accentText : colors.muted} size={TAB_ICON} strokeWidth={focused ? ACTIVE_STROKE : undefined} />
            <Text style={[styles.label, focused && styles.labelActive]}>{title}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    gap: 6,
    paddingTop: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderColor: colors.hairline,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
  },
  tab: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: Math.max(layout.touchTarget, 56),
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 3,
    paddingTop: 6,
    paddingHorizontal: 2,
    paddingBottom: spacing.xxs,
    borderWidth: 1.5,
    borderColor: 'transparent',
    borderRadius: radii.card,
  },
  tabActive: { backgroundColor: colors.accentTint, borderColor: colors.accent },
  pressed: { backgroundColor: colors.surfaceRaised },
  label: { fontSize: 12, lineHeight: 13.2, fontWeight: '700', textAlign: 'center', color: colors.muted },
  labelActive: { color: colors.accentText },
});
