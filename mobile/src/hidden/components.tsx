// "Not interested"'s own controls: the title page's Not interested / Unhide button with its note, the Unhide button
// under a hidden title in Search and in the Hidden tab, My requests' Requests | Hidden tabs and the Hidden tab's
// entries. Each button is 44 pt, named with its title for screen readers, disabled while its one call is out, and shows
// its failure's one fixed message under it; nothing is retried by itself. No button is drawn where the household cannot
// hide. Text grows with the system font size with no line limit, cap or fixed height.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { HiddenTitle } from '../api/types';
import { safeImageUrl } from '../api/urls';
import { TmdbImage } from '../home/components';
import { requestMeta, requestTitleText, type RequestTitle } from '../requests/text';
import { colors, layout, radii, spacing, typography } from '../theme';
import { useHideActions } from './HideProvider';
import type { HideTarget } from './store';
import { HIDE_TEXT, HIDE_VIEWS, hiddenOnText, hideName, unhideName, type HideError, type HideView } from './text';

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

/** One hide or unhide at a time from this control: whether it is out, and its failure. */
function useToggle(target: HideTarget, onDone?: (hidden: boolean) => void) {
  const actions = useHideActions();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<HideError | undefined>(undefined);
  const send = (hidden: boolean) => {
    if (!actions || sending) return;
    setSending(true);
    setError(undefined);
    void actions.toggle(target, hidden).then((outcome) => {
      setSending(false);
      if (outcome.ok) onDone?.(hidden);
      else setError(outcome.error);
    });
  };
  return { available: actions !== undefined, sending, error, send };
}

function Failure({ error }: { error: HideError | undefined }) {
  if (!error) return null;
  return (
    <Text testID="hide-error" accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>
      {HIDE_TEXT[error]}
    </Text>
  );
}

/** Unhide, under a hidden title (Search, the Hidden tab). `onDone` runs once the server has accepted it. */
export function UnhideButton({ target, onDone }: { target: HideTarget; onDone?: () => void }) {
  const { available, sending, error, send } = useToggle(target, onDone);
  if (!available) return null;
  return (
    <View style={styles.block}>
      <Pressable
        testID="unhide"
        accessibilityRole="button"
        accessibilityLabel={unhideName(target)}
        accessibilityState={{ disabled: sending, busy: sending }}
        disabled={sending}
        onPress={() => send(false)}
        style={({ pressed }) => [styles.button, (pressed || sending) && styles.pressed]}
      >
        <Text style={styles.buttonText}>{sending ? HIDE_TEXT.unhiding : HIDE_TEXT.unhide}</Text>
      </Pressable>
      <Failure error={error} />
    </View>
  );
}

/** The title page's Not interested, or Unhide once hidden, with what it does (and does not do) beside it. */
export function HideTitleButton({ target, hidden }: { target: HideTarget; hidden: boolean }) {
  const { available, sending, error, send } = useToggle(target);
  if (!available) return null;
  return (
    <View testID="hide-title" style={styles.block}>
      <Pressable
        testID="hide-title-button"
        accessibilityRole="button"
        accessibilityLabel={hidden ? unhideName(target) : hideName(target)}
        accessibilityState={{ disabled: sending, busy: sending }}
        disabled={sending}
        onPress={() => send(!hidden)}
        style={({ pressed }) => [styles.button, (pressed || sending) && styles.pressed]}
      >
        <Text style={styles.buttonText}>{sending ? (hidden ? HIDE_TEXT.unhiding : HIDE_TEXT.hiding) : hidden ? HIDE_TEXT.unhide : HIDE_TEXT.hide}</Text>
      </Pressable>
      {hidden ? <Text style={styles.note}>{HIDE_TEXT.state}</Text> : null}
      <Text style={styles.note}>{HIDE_TEXT.note}</Text>
      <Failure error={error} />
    </View>
  );
}

/**
 * My requests' two views as a tab list (as a network page's All | Series | Films), each tab a thumb's size, the chosen
 * one filled with the cyan tint, outlined in cyan and heavier, so it is never told by colour alone.
 */
export function HideViewTabs({ selected, onChoose }: { selected: HideView; onChoose: (view: HideView) => void }) {
  return (
    <View testID="requests-views" accessibilityRole="tablist" accessibilityLabel={HIDE_TEXT.viewsLabel} style={styles.tabs}>
      {HIDE_VIEWS.map((view) => {
        const chosen = view === selected;
        return (
          <Pressable
            key={view}
            testID={`requests-view-${view}`}
            accessibilityRole="tab"
            accessibilityLabel={HIDE_TEXT.views[view]}
            accessibilityState={{ selected: chosen }}
            onPress={() => onChoose(view)}
            style={({ pressed }) => [styles.tab, chosen && styles.tabChosen, pressed && styles.pressed]}
          >
            <Text style={[styles.tabText, chosen && styles.tabTextChosen]}>{HIDE_TEXT.views[view]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** What a hidden title's Unhide and toast call it: its name once read, else only its kind. */
export function hiddenTarget(entry: HiddenTitle, title: RequestTitle | undefined): HideTarget {
  const named = title?.status === 'loaded' ? title.title : undefined;
  return { mediaType: entry.mediaType, tmdbId: entry.tmdbId, title: named?.title ?? '', year: named?.year ?? null, hidden: true };
}

/**
 * One of the Hidden tab's titles, as a My requests entry: the thumbnail, the title and "year · Movie/Series", and the day
 * it was hidden, as one link to the title (named once with all of it), then Unhide under it.
 */
export function HiddenItem({
  entry,
  title,
  onOpen,
  onUnhidden,
}: {
  entry: HiddenTitle;
  title: RequestTitle | undefined;
  onOpen: (entry: HiddenTitle) => void;
  onUnhidden: (target: HideTarget) => void;
}) {
  const poster = title?.status === 'loaded' ? title.title.posterUrl : null;
  const day = hiddenOnText(entry.hiddenAt);
  const meta = requestMeta(entry.mediaType, title);
  const target = hiddenTarget(entry, title);
  return (
    <View testID="hidden-entry" style={styles.entry}>
      <Pressable
        testID="hidden-item"
        accessibilityRole="link"
        accessibilityLabel={[requestTitleText(title), meta, day ?? ''].filter(Boolean).join(', ')}
        onPress={() => onOpen(entry)}
        style={({ pressed }) => [styles.item, pressed && styles.pressed]}
      >
        <View style={[styles.thumb, !safeImageUrl(poster) && styles.thumbEmpty]} {...hidden}>
          <TmdbImage uri={poster} style={styles.thumbImage} />
        </View>
        <View style={styles.body} {...hidden}>
          <Text style={styles.title}>{requestTitleText(title)}</Text>
          <Text style={styles.meta}>{meta}</Text>
          {day ? <Text style={styles.note}>{day}</Text> : null}
        </View>
      </Pressable>
      <View style={styles.entryFoot}>
        <UnhideButton target={target} onDone={() => onUnhidden(target)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    gap: spacing.xxs,
    padding: spacing.xxs,
    borderWidth: 1.5,
    borderColor: colors.hairline,
    borderRadius: radii.chip,
    alignSelf: 'stretch',
  },
  tab: {
    flex: 1,
    minHeight: layout.touchTarget,
    minWidth: layout.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderWidth: 1.5,
    borderColor: 'transparent',
    borderRadius: radii.chip,
  },
  tabChosen: { backgroundColor: colors.accentTint, borderColor: colors.accent },
  tabText: { fontSize: 15.2, lineHeight: 20, fontWeight: '700', textAlign: 'center', color: colors.muted },
  tabTextChosen: { fontWeight: '800', color: colors.accentText },
  entry: { borderRadius: radii.card, borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.surface },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 12.8, minHeight: layout.touchTarget, paddingVertical: 11.2, paddingHorizontal: 12.8 },
  entryFoot: { marginHorizontal: 12.8, marginBottom: 11.2 },
  thumb: { width: 46, height: 68, borderRadius: radii.chip, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  thumbEmpty: { borderWidth: 1, borderColor: colors.hairline },
  thumbImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  body: { flex: 1, minWidth: 0, gap: 1.6, minHeight: layout.touchTarget, justifyContent: 'center' },
  title: { ...typography.cardTitle, fontSize: 16, lineHeight: 21, color: colors.text },
  meta: { ...typography.meta, color: colors.muted },
  block: { gap: spacing.xs, alignItems: 'flex-start', alignSelf: 'stretch' },
  button: {
    minHeight: layout.touchTarget,
    minWidth: layout.touchTarget,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 17.6,
    paddingVertical: 8,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderWidth: 1.5,
    borderColor: colors.accent,
    borderRadius: radii.chip,
  },
  pressed: { backgroundColor: colors.surfaceRaised },
  buttonText: { fontSize: 15.2, lineHeight: 20, fontWeight: '700', color: colors.accentText, textAlign: 'center' },
  note: { fontSize: 13.6, lineHeight: 19, color: colors.muted },
  error: { ...typography.body, color: colors.text },
});
