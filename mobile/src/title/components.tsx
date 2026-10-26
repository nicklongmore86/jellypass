// The title pages' pieces, the PWA's detail page (app/src/render.ts) in the Tidepool look: the inset rounded backdrop
// card, the facts and genre pills, the one full-width action, Get this with its fixed outcomes, the season cards with
// their round selection circles, the skeleton and the page's failure.
//
// - Images are TMDB's only, through the API client's allowlist; nothing is ever drawn over a picture.
// - The title, year, rating and status are each said once: the backdrop and poster are hidden, the status chip is
//   spoken here (a season card's link says its own status, and its chip is hidden).
// - Text grows with the system font size with no line limit, cap or fixed height. Every control is a thumb's size.
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { HouseholdState, Movie, Series } from '../api/types';
import { safeImageUrl } from '../api/urls';
import { backdropUri, StatusChip, TmdbImage } from '../home/components';
import { ERROR_TEXT, RETRY_TEXT, ratingLabel, ratingText, REQUEST_LABELS, stateLabel, type ErrorText } from '../home/text';
import { Icon } from '../icons';
import { colors, layout, radii, spacing, typography } from '../theme';
import { Button } from '../ui';
import type { GetThisState } from './useTitle';
import { GET_THIS_TEXT, lengthText, PLAY_TEXT, playLabel, STATE_NOTES } from './text';

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

/** From this width the poster shows as a thumbnail beside the title (the stylesheet's 48rem), and seasons go two a row. */
export const DETAIL_TABLET_WIDTH = 768;
/** The page stops widening here (the stylesheet's 960px detail column). */
export const DETAIL_MAX_WIDTH = 960;
/** The poster thumbnail's width on a tablet (9rem). */
export const DETAIL_POSTER_WIDTH = 144;

/** Opens a Play link: only ever one the API client's allowlist passed (safePlayUrl), in the system browser. */
export function openPlay(url: string | undefined): void {
  if (!url) return;
  Linking.openURL(url).catch(() => {
    // No browser to open it in: nothing to do, and nothing to log.
  });
}

/** The inset rounded 16:9 backdrop card; a plain navy card when there is none. */
export function DetailBackdrop({ url, width }: { url: string | null | undefined; width: number }) {
  return (
    <View testID="detail-backdrop" style={styles.backdrop} {...hidden}>
      <TmdbImage uri={backdropUri(url ?? null, width)} style={styles.fillImage} />
    </View>
  );
}

/** The poster thumbnail beside the title on a tablet; hidden from screen readers (the title says it). */
export function DetailPoster({ url }: { url: string | null }) {
  return (
    <View testID="detail-poster" style={[styles.poster, !safeImageUrl(url) && styles.frameEmpty]} {...hidden}>
      <TmdbImage uri={url} style={styles.fillImage} />
    </View>
  );
}

function Pill({ text, label }: { text: string; label?: string }) {
  return (
    <View style={styles.pill} {...(label ? { accessible: true, accessibilityLabel: label } : {})}>
      <Text style={styles.pillText}>{text}</Text>
    </View>
  );
}

/** The facts under a title: its year, run time or "N seasons", and "★ 7.5 TMDB" (said as words). */
export function Facts({ title }: { title: Movie | Series }) {
  const length = lengthText(title);
  const facts = [
    title.year ? <Pill key="year" text={String(title.year)} /> : null,
    length ? <Pill key="length" text={length} /> : null,
    typeof title.rating === 'number' ? <Pill key="rating" text={ratingText(title.rating)} label={ratingLabel(title.rating)} /> : null,
  ].filter(Boolean);
  return facts.length ? (
    <View testID="detail-facts" style={styles.pills}>
      {facts}
    </View>
  ) : null;
}

/** A plain line of fact pills (a season's episode count). */
export function FactLine({ facts }: { facts: readonly string[] }) {
  return facts.length ? (
    <View testID="detail-facts" style={styles.pills}>
      {facts.map((fact) => (
        <Pill key={fact} text={fact} />
      ))}
    </View>
  ) : null;
}

export function Genres({ genres }: { genres: readonly string[] }) {
  if (genres.length === 0) return null;
  return (
    <View testID="detail-genres" style={styles.pills}>
      {genres.map((genre) => (
        <View key={genre} style={styles.genre}>
          <Text style={styles.genreText}>{genre}</Text>
        </View>
      ))}
    </View>
  );
}

/** The status chip (spoken), and the one muted note a state without a button has. */
export function DetailStatus({ state, failed, failedNote }: { state: HouseholdState; failed: boolean; failedNote: boolean }) {
  const note = state === 'unavailable' || state === 'requested' ? STATE_NOTES[state] : undefined;
  return (
    <View style={styles.status}>
      <StatusChip state={state} failed={failed} spoken />
      {note ? <Text style={styles.muted}>{note}</Text> : null}
      {failedNote ? <Text style={styles.muted}>{GET_THIS_TEXT.failedNote}</Text> : null}
    </View>
  );
}

/** The full-width action: cyan, or outlined when it steps back for Play. */
export function ActionButton({
  label,
  name,
  onPress,
  disabled = false,
  busy = false,
  secondary = false,
}: {
  label: string;
  name: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.action, secondary && styles.actionSecondary, (pressed || disabled || busy) && styles.dimmed]}
    >
      {busy ? <ActivityIndicator color={secondary ? colors.text : colors.onAccent} {...hidden} /> : null}
      <Text style={[styles.actionText, secondary && styles.actionTextSecondary]}>{label}</Text>
    </Pressable>
  );
}

export function PlayButton({ title, url }: { title: string; url: string }) {
  return <ActionButton label={PLAY_TEXT} name={playLabel(title)} onPress={() => openPlay(url)} />;
}

/**
 * Get this: the button (with "Choose the seasons you want below." while a series has none chosen), and the line that
 * says what happened, read out when it changes. While the call is out the button says "Sending…" and nothing can send
 * again; once accepted the button goes, and the one fixed confirmation stays whatever reading the screen again does.
 */
export function GetThisBox({
  subject,
  offered,
  picking,
  chosen,
  get,
  secondary,
  onSend,
  onReload,
}: {
  subject: string;
  /** Whether there is anything to ask for. */
  offered: boolean;
  picking: boolean;
  chosen: number;
  get: GetThisState;
  secondary: boolean;
  onSend: () => void;
  onReload: () => void;
}) {
  const controls = offered && !get.reloading && !get.refreshFailed;
  const message = get.error ? GET_THIS_TEXT[get.error] : get.confirmed ? GET_THIS_TEXT.confirmation : '';
  if (!controls && !message) return null;
  return (
    <View testID="get-this" style={styles.getThis}>
      {controls ? (
        <ActionButton
          label={get.sending ? GET_THIS_TEXT.sending : GET_THIS_TEXT.button}
          name={`${GET_THIS_TEXT.button}: ${subject}`}
          onPress={onSend}
          disabled={picking && chosen === 0}
          busy={get.sending}
          secondary={secondary}
        />
      ) : null}
      {controls && picking && chosen === 0 ? <Text style={styles.muted}>{GET_THIS_TEXT.chooseBelow}</Text> : null}
      <Text testID="get-message" accessibilityLiveRegion="polite" style={styles.getMessage}>
        {message}
      </Text>
      {get.refreshFailed ? (
        <>
          <Text style={styles.muted}>{ERROR_TEXT.unavailable.body}</Text>
          <Button label={RETRY_TEXT} onPress={onReload} secondary />
        </>
      ) : null}
    </View>
  );
}

/** A round selection circle that is a real checkbox, a thumb's size, named for its season. */
export function SelectCircle({ name, checked, disabled, onToggle }: { name: string; checked: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={name}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onToggle}
      style={({ pressed }) => [styles.choice, (pressed || disabled) && styles.dimmed]}
    >
      <View style={[styles.circle, checked && styles.circleChecked]}>
        {checked ? <Icon name="check" color={colors.onAccent} size={18} strokeWidth={2.8} /> : null}
      </View>
    </Pressable>
  );
}

/**
 * A season card: one link (its name, episode count and status, said once) to the season's page, the status chip, and,
 * where the household can ask, the round selection circle.
 */
export function SeasonCard({
  name,
  episodes,
  state,
  failed,
  wide,
  onOpen,
  choice,
}: {
  name: string;
  episodes: string;
  state: HouseholdState;
  failed: boolean;
  wide: boolean;
  onOpen: () => void;
  choice?: { checked: boolean; disabled: boolean; onToggle: () => void } | undefined;
}) {
  const status = failed ? REQUEST_LABELS.failed : stateLabel(state);
  return (
    <View testID="season-card" style={[styles.season, wide && styles.seasonWide]}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={[name, episodes, status].filter(Boolean).join(', ')}
        onPress={onOpen}
        style={({ pressed }) => [styles.seasonLink, pressed && styles.pressed]}
      >
        <Text style={styles.seasonName}>{name}</Text>
        {episodes ? <Text style={styles.meta}>{episodes}</Text> : null}
        <StatusChip state={state} failed={failed} />
      </Pressable>
      {choice ? <SelectCircle name={name} {...choice} /> : null}
    </View>
  );
}

export function SectionHeading({ title }: { title: string }) {
  return (
    <View style={styles.sectionHeading}>
      <Text accessibilityRole="header" style={styles.sectionHeadingText}>
        {title}
      </Text>
      <View style={styles.waterline} {...hidden}>
        <View style={styles.waterlineAccent} />
        <View style={styles.waterlineCap} />
      </View>
    </View>
  );
}

/** A title page while it loads: the backdrop card, then the title, the pills, the one action and the overview. */
export function DetailSkeleton() {
  return (
    <View testID="detail-skeleton" style={styles.skeletonPage} {...hidden}>
      <View style={[styles.backdrop, styles.skeleton]} />
      <View style={[styles.skeleton, styles.skeletonTitle]} />
      <View style={[styles.skeleton, styles.skeletonLine]} />
      <View style={[styles.skeleton, styles.skeletonAction]} />
      <View style={[styles.skeleton, styles.skeletonBlock]} />
    </View>
  );
}

/** The page could not be read: the fixed words for the kind of failure, and Try again (not for Not found). */
export function DetailFailure({ error, onRetry }: { error: ErrorText; onRetry: () => void }) {
  const text = ERROR_TEXT[error];
  return (
    <View accessibilityRole="alert" style={styles.notice}>
      <Text accessibilityRole="header" style={styles.noticeTitle}>
        {text.title}
      </Text>
      <Text style={styles.noticeBody}>{text.body}</Text>
      {error === 'not_found' ? null : <Button label={RETRY_TEXT} onPress={onRetry} secondary />}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.75 },
  dimmed: { opacity: 0.6 },
  muted: { ...typography.body, color: colors.muted },
  meta: { ...typography.meta, color: colors.muted },
  fillImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radii.sheet },

  backdrop: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: radii.sheet,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surfaceRaised,
  },
  poster: { width: DETAIL_POSTER_WIDTH, aspectRatio: 2 / 3, borderRadius: radii.poster, backgroundColor: colors.surface },
  frameEmpty: { borderWidth: 1, borderColor: colors.hairline },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: {
    paddingVertical: spacing.xxs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.chip,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  pillText: { ...typography.label, color: colors.text },
  genre: { paddingVertical: spacing.xxs, paddingHorizontal: spacing.md, borderRadius: radii.chip, backgroundColor: colors.surfaceRaised },
  genreText: { ...typography.chip, color: colors.text },
  status: { gap: spacing.sm },

  action: {
    width: '100%',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: layout.touchTarget,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionSecondary: { backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.accent },
  actionText: { ...typography.button, color: colors.onAccent, flexShrink: 1, textAlign: 'center' },
  actionTextSecondary: { color: colors.text },
  getThis: { gap: spacing.sm },
  getMessage: { ...typography.label, color: colors.text },

  choice: { minWidth: layout.touchTarget, minHeight: layout.touchTarget, alignItems: 'center', justifyContent: 'center' },
  circle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleChecked: { borderColor: colors.accent, backgroundColor: colors.accent },

  season: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  seasonWide: { flexBasis: '48%', flexGrow: 1 },
  seasonLink: { flex: 1, minHeight: layout.touchTarget, justifyContent: 'center', gap: spacing.xxs },
  seasonName: { ...typography.label, color: colors.text },

  sectionHeading: { gap: spacing.sm, alignSelf: 'flex-start' },
  sectionHeadingText: { ...typography.rowHeading, color: colors.text },
  waterline: { flexDirection: 'row', height: layout.waterline.height },
  waterlineAccent: { width: layout.waterline.accentWidth, borderRadius: layout.waterline.height, backgroundColor: colors.accent },
  waterlineCap: {
    width: layout.waterline.capWidth,
    marginLeft: layout.waterline.capOffset - layout.waterline.accentWidth,
    borderRadius: layout.waterline.height,
    backgroundColor: colors.purple,
  },

  skeletonPage: { gap: spacing.lg },
  skeleton: { backgroundColor: colors.surface, borderWidth: 0, borderRadius: radii.chip },
  skeletonTitle: { width: '70%', minHeight: 35 },
  skeletonLine: { width: '50%', minHeight: 28 },
  skeletonAction: { width: '100%', minHeight: layout.touchTarget, borderRadius: radii.card },
  skeletonBlock: { width: '100%', minHeight: 96 },

  notice: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  noticeTitle: { ...typography.label, color: colors.text },
  noticeBody: { ...typography.body, color: colors.muted },
});
