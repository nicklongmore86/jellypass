// The Account tab, the PWA's accountView: who is signed in, to which household, with Sign out and Change household
// (which signs out first), then "About & credits": what JellyPass is, TMDB's logo and its exact notice, JustWatch's
// credit, the app's version and build, and the API revision the household speaks. It makes no call of its own: the
// member card is the /me the sign-in checked.
import { useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Me } from '../api/types';
import { ABOUT_TEXT, apiVersionText, CREDIT_URLS, JUSTWATCH_CREDIT, TMDB_NOTICE, TMDB_SOURCE, TMDB_URL, versionText, type LinkedSentence } from '../credits';
import { useSession } from '../session/SessionProvider';
import { colors, radii, spacing, typography } from '../theme';
import { TmdbLogo } from '../TmdbLogo';
import { Button, Screen } from '../ui';

/** "name · household", as the PWA's Account card shows it. */
export function accountText(me: Pick<Me, 'name' | 'household'>): string {
  return [me.name, me.household].filter(Boolean).join(' · ') || 'Signed in';
}

/** Opens one of the credits' own links in the system browser; nothing else is ever opened. */
export function openCredit(url: string): void {
  if (!CREDIT_URLS.includes(url)) return;
  Linking.openURL(url).catch(() => {
    // No browser to open it in: nothing to do, and nothing to log.
  });
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.group}>
      <Text accessibilityRole="header" style={styles.groupLabel}>
        {label.toUpperCase()}
      </Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Sentence({ sentence, muted = true }: { sentence: LinkedSentence; muted?: boolean }) {
  return (
    <Text style={muted ? styles.muted : styles.text}>
      {sentence.before}
      <Text accessibilityRole="link" onPress={() => openCredit(sentence.url)} style={styles.link}>
        {sentence.link}
      </Text>
      {sentence.after}
    </Text>
  );
}

export function AccountScreen({ me }: { me: Me }) {
  const { signOut, changeHousehold } = useSession();
  const [busy, setBusy] = useState(false);
  const leave = (how: () => Promise<void>) => {
    setBusy(true);
    void how();
  };
  return (
    <Screen maxWidth={640}>
      <Group label="Account">
        <Text style={styles.name}>{accountText(me)}</Text>
        <View style={styles.actions}>
          <Button label="Sign out" secondary disabled={busy} onPress={() => leave(signOut)} />
          <Button label="Change household" secondary disabled={busy} onPress={() => leave(changeHousehold)} />
        </View>
      </Group>
      <Group label="About & credits">
        <Text style={styles.text}>{ABOUT_TEXT}</Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="The Movie Database (TMDB)"
          onPress={() => openCredit(TMDB_URL)}
          style={({ pressed }) => [styles.logoLink, pressed && styles.pressed]}
        >
          <TmdbLogo />
        </Pressable>
        <Text style={styles.text}>{TMDB_NOTICE}</Text>
        <Sentence sentence={TMDB_SOURCE} />
        <Sentence sentence={JUSTWATCH_CREDIT} />
        <Text style={[styles.muted, styles.version]}>{versionText()}</Text>
        <Text style={[styles.muted, styles.version]}>{apiVersionText(me.apiVersion)}</Text>
      </Group>
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
  // The stylesheet's `.group-label`: small, muted, spaced capitals.
  groupLabel: { paddingHorizontal: spacing.xxs, fontSize: 12.8, lineHeight: 17, fontWeight: '600', letterSpacing: 0.77, color: colors.muted },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  name: { fontSize: 16.8, lineHeight: 24, fontWeight: '600', color: colors.text },
  actions: { gap: spacing.md, alignSelf: 'stretch' },
  text: { ...typography.body, color: colors.text },
  muted: { ...typography.body, color: colors.muted },
  link: { color: colors.accentText, textDecorationLine: 'underline' },
  version: { fontSize: 14.4, lineHeight: 20 },
  // At least a thumb's height around the logo, which is shorter.
  logoLink: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', borderRadius: radii.chip },
  pressed: { opacity: 0.6 },
});
