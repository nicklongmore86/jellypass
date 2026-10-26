// The PWA's `.app-header`: solid, one colour with the page, a hairline under it, below the status bar. It carries the
// Back button (on a pushed screen) and the screen's title, nothing else; with neither (Home) it shrinks to the status
// bar's safe area. The title wraps rather than clips at large text sizes, and the header grows with it.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../icons';
import { colors, layout, radii, spacing, typography } from '../theme';

export function Header({ title, onBack }: { title: string | undefined; onBack: (() => void) | undefined }) {
  const insets = useSafeAreaInsets();
  const paddingLeft = Math.max(spacing.gutter, insets.left);
  const paddingRight = Math.max(spacing.gutter, insets.right);
  if (!title && !onBack) return <View testID="header" style={[styles.bare, { paddingTop: insets.top }]} />;
  return (
    <View testID="header" style={[styles.header, { paddingTop: spacing.sm + insets.top, paddingLeft, paddingRight }]}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          hitSlop={4}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <Icon name="back" color={colors.text} />
        </Pressable>
      ) : null}
      {title ? (
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bare: { backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: layout.headerHeight,
    paddingBottom: spacing.sm,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  back: {
    minWidth: layout.touchTarget,
    minHeight: layout.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.chip,
    backgroundColor: colors.surface,
  },
  pressed: { backgroundColor: colors.surfaceRaised },
  title: { ...typography.headerTitle, flex: 1, color: colors.text },
});
