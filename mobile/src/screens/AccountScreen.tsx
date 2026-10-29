// The Account tab, the PWA's accountView: who is signed in, to which household, with Sign out and Change household
// (which signs out first), then "About & credits": what JellyPass is, TMDB's logo and its exact notice, JustWatch's
// credit, the app's version and build, and the API revision the household speaks. It makes no call of its own: the
// member card is the /me the sign-in checked.
import { useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Me } from '../api/types';
import { ABOUT_TEXT, allowedUrls, apiVersionText, JUSTWATCH_CREDIT, TMDB_NOTICE, TMDB_SOURCE, TMDB_URL, UNOFFICIAL_TEXT, versionText, type LinkedSentence } from '../credits';
import { storeLink } from '../links';
import { useSession } from '../session/SessionProvider';
import { colors, layout, radii, spacing, typography } from '../theme';
import { TmdbLogo } from '../TmdbLogo';
import { Button, Screen } from '../ui';

/** "name · household", as the PWA's Account card shows it. */
export function accountText(me: Pick<Me, 'name' | 'household'>): string {
  return [me.name, me.household].filter(Boolean).join(' · ') || 'Signed in';
}

/** Opens one of the credits' or the owner's configured links in the system browser; nothing else is ever opened. */
export function openCredit(url: string): void {
  if (!allowedUrls().includes(url)) return;
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

// The whole sentence is the link's target, a thumb's height at least: the link's words alone, inline, are shorter than
// one. Screen readers read the sentence as the link's name, so its words stay with it.
function Sentence({ sentence, muted = true }: { sentence: LinkedSentence; muted?: boolean }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${sentence.before}${sentence.link}${sentence.after}`}
      onPress={() => openCredit(sentence.url)}
      style={({ pressed }) => [styles.sentenceLink, pressed && styles.pressed]}
    >
      <Text style={muted ? styles.muted : styles.text}>
        {sentence.before}
        <Text style={styles.link}>{sentence.link}</Text>
        {sentence.after}
      </Text>
    </Pressable>
  );
}

// A plain link a thumb's height tall, its words as its name. Shown only when the app config sets its URL.
function PageLink({ label, url }: { label: string; url: string | null }) {
  if (!url) return null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => openCredit(url)}
      style={({ pressed }) => [styles.sentenceLink, pressed && styles.pressed]}
    >
      <Text style={styles.link}>{label}</Text>
    </Pressable>
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
        <Text style={styles.muted}>{UNOFFICIAL_TEXT}</Text>
        <PageLink label="Privacy policy" url={storeLink('privacyPolicyUrl')} />
        <PageLink label="Support" url={storeLink('supportUrl')} />
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
  logoLink: { minHeight: layout.touchTarget, justifyContent: 'center', alignSelf: 'flex-start', borderRadius: radii.chip },
  sentenceLink: { minHeight: layout.touchTarget, justifyContent: 'center', borderRadius: radii.chip },
  pressed: { opacity: 0.6 },
});
