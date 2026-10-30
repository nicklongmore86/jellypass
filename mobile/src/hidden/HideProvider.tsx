// "Not interested" for the signed-in app (src/app/(tabs)/_layout.tsx): the actions every card and title page uses, the
// long-press sheet and the toast with Undo. Only where the household can hide (`apiVersion` 3, `canHide`): otherwise
// `useHideActions()` is undefined, so no card has a long press or an action and no page a button.
//
// - A hide or unhide is one call (docs/app-api/fetch-budget.json, "hiding"), sent once: the control is disabled while it
//   is out and nothing is retried by itself. Once accepted, every list already on screen drops (or, after an unhide or
//   Undo, shows again) the title at once, with no call (src/hidden/store.ts), and screen readers hear what happened.
// - A failure is one fixed message (the 2,000-title limit has its own) where it was asked; a 401 signs the member out.
// - The sheet (a card's long press) says what hiding does and offers Not interested or Unhide, and Close. Screen readers
//   get the same command as a card's own action, with no sheet: the toast after it is the way back.
// - The toast, over the tab bar, says what was hidden and offers Undo (one unhide) and Dismiss. It goes by itself after
//   TOAST_MS, but never while a screen reader is on, and never while Undo is out or has failed.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ApiError, isAbortError } from '../api/errors';
import { useHiddenTitles, useSession } from '../session/SessionProvider';
import { colors, layout, radii, spacing, typography } from '../theme';
import { hiddenKey, type HideTarget } from './store';
import { backText, HIDE_TEXT, hideError, hiddenText, hideName, hideSubject, TOAST_MS, undoName, unhideName, type HideError } from './text';

/** How a hide or unhide ended: `error` is the fixed message to show, none when there is nothing to show (a 401, an abort). */
export type HideOutcome = { ok: true } | { ok: false; error?: HideError };

export interface HideActions {
  /** Opens the sheet for a title (a card's long press). */
  open: (target: HideTarget) => void;
  /** Hides or unhides a title: one call, announced; the outcome for the control that asked. */
  toggle: (target: HideTarget, hidden: boolean, signal?: AbortSignal) => Promise<HideOutcome>;
}

const HideContext = createContext<HideActions | undefined>(undefined);

/** The actions, or undefined where the household cannot hide (or outside the signed-in app). */
export function useHideActions(): HideActions | undefined {
  return useContext(HideContext);
}

/** A card's long press and screen-reader action, where the household can hide; nothing otherwise. */
export function useCardHideProps(card: HideTarget) {
  const actions = useHideActions();
  if (!actions) return {};
  return {
    onLongPress: () => actions.open(card),
    accessibilityActions: [{ name: 'hide', label: card.hidden ? HIDE_TEXT.unhide : HIDE_TEXT.hide }],
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
      if (event.nativeEvent.actionName === 'hide') void actions.toggle(card, !card.hidden);
    },
  };
}

export function HideProvider({ children }: { children: ReactNode }) {
  const { canHide, expire, hiddenTitles, setHidden } = useSession();

  const toggle = useCallback(
    async (target: HideTarget, hidden: boolean, signal?: AbortSignal): Promise<HideOutcome> => {
      try {
        await setHidden(target, hidden, signal);
      } catch (error) {
        if (isAbortError(error)) return { ok: false };
        if (error instanceof ApiError && error.kind === 'unauthorized') {
          void expire();
          return { ok: false };
        }
        const message = hideError(error instanceof ApiError ? error.kind : 'unavailable');
        AccessibilityInfo.announceForAccessibility?.(HIDE_TEXT[message]);
        return { ok: false, error: message };
      }
      AccessibilityInfo.announceForAccessibility?.(hidden ? hiddenText(target) : backText(target));
      return { ok: true };
    },
    [setHidden, expire],
  );

  const actions = useMemo<HideActions | undefined>(
    () => (canHide ? { open: (target) => hiddenTitles.openMenu(target), toggle } : undefined),
    [canHide, hiddenTitles, toggle],
  );

  return (
    <HideContext value={actions}>
      {children}
      {actions ? <HideSheet toggle={toggle} /> : null}
    </HideContext>
  );
}

/** The long-press sheet: the title, what hiding does, Not interested (or Unhide) and Close, all 44 pt. */
function HideSheet({ toggle }: { toggle: HideActions['toggle'] }) {
  const hiddenTitles = useHiddenTitles();
  const target = hiddenTitles.menu();
  return (
    <Modal visible={target !== undefined} transparent animationType="fade" onRequestClose={() => hiddenTitles.closeMenu()} supportedOrientations={['portrait', 'landscape']}>
      {target ? <SheetBody key={hiddenKey(target.mediaType, target.tmdbId)} target={target} toggle={toggle} /> : null}
    </Modal>
  );
}

function SheetBody({ target, toggle }: { target: HideTarget; toggle: HideActions['toggle'] }) {
  const hiddenTitles = useHiddenTitles();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<HideError | undefined>(undefined);
  const hidden = hiddenTitles.isHidden(target);
  const close = () => {
    if (!sending) hiddenTitles.closeMenu();
  };
  const confirm = () => {
    if (sending) return;
    setSending(true);
    setError(undefined);
    void toggle(target, !hidden).then((outcome) => {
      setSending(false);
      if (outcome.ok) hiddenTitles.closeMenu();
      else setError(outcome.error);
    });
  };
  return (
    <View style={styles.scrim} accessibilityViewIsModal>
      <ScrollView testID="hide-sheet" style={styles.sheet} contentContainerStyle={styles.sheetContent} bounces={false}>
        <Text accessibilityRole="header" style={styles.sheetTitle}>
          {hideSubject(target)}
        </Text>
        <Text style={styles.body}>{HIDE_TEXT.note}</Text>
        {error ? (
          <Text testID="hide-error" accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>
            {HIDE_TEXT[error]}
          </Text>
        ) : null}
        <Pressable
          testID="hide-confirm"
          accessibilityRole="button"
          accessibilityLabel={hidden ? unhideName(target) : hideName(target)}
          accessibilityState={{ disabled: sending, busy: sending }}
          disabled={sending}
          onPress={confirm}
          style={({ pressed }) => [styles.button, styles.primary, (pressed || sending) && styles.pressed]}
        >
          <Text style={styles.primaryText}>{sending ? (hidden ? HIDE_TEXT.unhiding : HIDE_TEXT.hiding) : hidden ? HIDE_TEXT.unhide : HIDE_TEXT.hide}</Text>
        </Pressable>
        <Pressable
          testID="hide-close"
          accessibilityRole="button"
          accessibilityState={{ disabled: sending }}
          disabled={sending}
          onPress={close}
          style={({ pressed }) => [styles.button, styles.secondary, (pressed || sending) && styles.pressed]}
        >
          <Text style={styles.secondaryText}>{HIDE_TEXT.close}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

/** Whether a screen reader is on now (and as it changes). */
function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.resolve(AccessibilityInfo.isScreenReaderEnabled?.())
      .then((enabled) => {
        if (live) setOn(enabled === true);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener?.('screenReaderChanged', setOn);
    return () => {
      live = false;
      subscription?.remove();
    };
  }, []);
  return on;
}

/** The toast after a hide, over the tab bar: "Hidden … from Discover", Undo and Dismiss. Nothing where none is due. */
export function HideToast() {
  const actions = useHideActions();
  const hiddenTitles = useHiddenTitles();
  const toast = hiddenTitles.toast();
  if (!actions || !toast) return null;
  return <ToastBody key={toast.id} id={toast.id} target={toast.target} toggle={actions.toggle} />;
}

function ToastBody({ id, target, toggle }: { id: number; target: HideTarget; toggle: HideActions['toggle'] }) {
  const hiddenTitles = useHiddenTitles();
  const screenReader = useScreenReader();
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<HideError | undefined>(undefined);
  const stays = screenReader || undoing || error !== undefined;

  useEffect(() => {
    if (stays) return undefined;
    const timer = setTimeout(() => {
      if (hiddenTitles.toast()?.id === id) hiddenTitles.dismissToast();
    }, TOAST_MS);
    return () => clearTimeout(timer);
  }, [stays, hiddenTitles, id]);

  const undo = () => {
    if (undoing) return;
    setUndoing(true);
    setError(undefined);
    // Accepted, the unhide closes the toast itself (src/hidden/store.ts).
    void toggle(target, false).then((outcome) => {
      setUndoing(false);
      if (!outcome.ok) setError(outcome.error);
    });
  };

  return (
    <View testID="hide-toast" style={styles.toastWrap}>
      <View style={styles.toast}>
        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.toastText}>
          {error ? HIDE_TEXT[error] : hiddenText(target)}
        </Text>
        <View style={styles.toastButtons}>
          <Pressable
            testID="hide-undo"
            accessibilityRole="button"
            accessibilityLabel={undoName(target)}
            accessibilityState={{ disabled: undoing, busy: undoing }}
            disabled={undoing}
            onPress={undo}
            style={({ pressed }) => [styles.toastButton, styles.primary, (pressed || undoing) && styles.pressed]}
          >
            <Text style={styles.primaryText}>{undoing ? HIDE_TEXT.undoing : HIDE_TEXT.undo}</Text>
          </Pressable>
          <Pressable
            testID="hide-dismiss"
            accessibilityRole="button"
            accessibilityState={{ disabled: undoing }}
            disabled={undoing}
            onPress={() => hiddenTitles.dismissToast()}
            style={({ pressed }) => [styles.toastButton, styles.secondary, (pressed || undoing) && styles.pressed]}
          >
            <Text style={styles.secondaryText}>{HIDE_TEXT.dismiss}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.6)', justifyContent: 'center', padding: spacing.gutter },
  sheet: { alignSelf: 'center', width: '100%', maxWidth: 560, maxHeight: '90%', flexGrow: 0, borderRadius: radii.card, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline },
  sheetContent: { padding: spacing.lg, gap: spacing.md },
  sheetTitle: { ...typography.cardTitle, fontSize: 20, lineHeight: 26, color: colors.text },
  body: { ...typography.body, color: colors.muted },
  error: { ...typography.body, color: colors.text },
  button: { minHeight: layout.touchTarget, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 17.6, paddingVertical: 8, borderRadius: radii.chip },
  primary: { backgroundColor: colors.accent },
  primaryText: { fontSize: 16, lineHeight: 21, fontWeight: '700', color: colors.onAccent, textAlign: 'center' },
  secondary: { borderWidth: 1.5, borderColor: colors.accent },
  secondaryText: { fontSize: 16, lineHeight: 21, fontWeight: '700', color: colors.accentText, textAlign: 'center' },
  pressed: { opacity: 0.75 },
  toastWrap: { paddingHorizontal: spacing.gutter, paddingBottom: spacing.sm, backgroundColor: 'transparent' },
  toast: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surfaceRaised,
  },
  toastText: { ...typography.body, fontWeight: '700', color: colors.text },
  toastButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  toastButton: { minHeight: layout.touchTarget, minWidth: 88, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 17.6, paddingVertical: 8, borderRadius: radii.chip },
});
