// The few pieces every sign-in screen is built from, in the Tidepool look (src/theme): a page column, a heading with
// its waterline, buttons at least a thumb's size, a labelled field and a message line read out when it changes.
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, layout, radii, spacing, typography } from '@/theme';

export function Page({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView style={styles.page}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.column}>{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Heading({ title, intro }: { title: string; intro?: string }) {
  return (
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      <View style={styles.waterline} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={styles.waterlineAccent} />
        <View style={styles.waterlineCap} />
      </View>
      {intro ? <Text style={styles.intro}>{intro}</Text> : null}
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled = false,
  secondary = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.buttonSecondary, (pressed || disabled) && styles.dimmed]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, ...input }: { label: string } & TextInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} style={styles.input} {...input} />
    </View>
  );
}

/** A fixed-text message, read out by screen readers when it changes; nothing is drawn while it is empty. */
export function Message({ text }: { text: string }) {
  return (
    <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.message}>
      {text}
    </Text>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Body({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return <Text style={strong ? styles.strong : styles.body}>{children}</Text>;
}

export function Loading({ label }: { label: string }) {
  return (
    <SafeAreaView style={[styles.page, styles.centred]}>
      <ActivityIndicator color={colors.accent} size="large" accessibilityLabel={label} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  fill: { flex: 1 },
  centred: { alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 1 },
  column: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  heading: { paddingBottom: spacing.sm, gap: spacing.sm },
  title: { ...typography.screenTitle, color: colors.text },
  intro: { ...typography.body, color: colors.muted, marginTop: spacing.sm },
  // A cyan line, a gap, then a short purple cap: two separate segments, never a gradient.
  waterline: { flexDirection: 'row', height: layout.waterline.height },
  waterlineAccent: { width: layout.waterline.accentWidth, borderRadius: layout.waterline.height, backgroundColor: colors.accent },
  waterlineCap: {
    width: layout.waterline.capWidth,
    marginLeft: layout.waterline.capOffset - layout.waterline.accentWidth,
    borderRadius: layout.waterline.height,
    backgroundColor: colors.purple,
  },
  button: {
    minHeight: layout.touchTarget,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline },
  dimmed: { opacity: 0.6 },
  buttonText: { ...typography.button, color: colors.onAccent },
  buttonTextSecondary: { color: colors.text },
  field: { gap: spacing.xs },
  label: { ...typography.label, color: colors.text },
  input: {
    ...typography.body,
    minHeight: layout.touchTarget,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.chip,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  message: { ...typography.body, color: colors.text },
  card: {
    padding: spacing.lg,
    gap: spacing.md,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  body: { ...typography.body, color: colors.muted },
  strong: { ...typography.label, color: colors.text },
});
