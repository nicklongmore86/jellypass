// A placeholder until sign-in lands: the Tidepool theme on a real screen, and nothing that talks to a network.
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, layout, radii, spacing, typography } from '@/theme';

export default function Welcome() {
  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.column}>
        <View style={styles.heading}>
          <Text accessibilityRole="header" style={styles.title}>
            JellyPass
          </Text>
          <View style={styles.waterline} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={styles.waterlineAccent} />
            <View style={styles.waterlineCap} />
          </View>
        </View>
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>Coming soon</Text>
          <Text style={styles.body}>
            Sign in to your household&apos;s JellyPass to browse its library and find more to watch.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: layout.maxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.md,
    gap: spacing.xl,
  },
  heading: { paddingBottom: spacing.md },
  title: { ...typography.screenTitle, color: colors.text },
  // A cyan line, a gap, then a short purple cap: two separate segments, never a gradient.
  waterline: { flexDirection: 'row', marginTop: spacing.sm, height: layout.waterline.height },
  waterlineAccent: { width: layout.waterline.accentWidth, borderRadius: layout.waterline.height, backgroundColor: colors.accent },
  waterlineCap: {
    width: layout.waterline.capWidth,
    marginLeft: layout.waterline.capOffset - layout.waterline.accentWidth,
    borderRadius: layout.waterline.height,
    backgroundColor: colors.purple,
  },
  notice: {
    padding: spacing.lg,
    gap: spacing.md,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  noticeTitle: { ...typography.label, color: colors.text },
  body: { ...typography.body, color: colors.muted },
});
