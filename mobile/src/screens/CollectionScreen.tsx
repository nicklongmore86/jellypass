// A collection's page (a film series), opened from a film's "Part of …" link on the stack of the tab it was opened from
// (/home/collection/<id>, …): the backdrop card, its name and overview, then its films, oldest first. Each film is a
// link to its own page, with its poster, year and the household's state; one the household can still ask for has a
// round selection circle, ticked at first when the film is out, and not when it is not released yet (shown, but never
// in "Get all missing films"). One button asks for the films ticked, one "Get this" each, in order: "Get all missing
// films" while the ticks are the first ones, "Get selected (N)" otherwise. When one is refused (a limit reached, with
// how long to wait) the rest are not sent, and the page says which films were asked for and which were not.
//
// Every film is drawn through the overlay (src/title/asked.ts), so one just asked for shows Requested here and on Home.
import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Collection, CollectionFilm } from '../api/types';
import { COLLECTION_TEXT, getFilmsLabel } from '../collection/text';
import { outcomeLines, useCollection } from '../collection/useCollection';
import { StatusChip, TmdbImage } from '../home/components';
import { stateLabel } from '../home/text';
import { titlePath, type TitleTab } from '../navigation/titles';
import { useAsked } from '../session/SessionProvider';
import { colors, layout, radii, spacing, typography } from '../theme';
import { ActionButton, DETAIL_MAX_WIDTH, DetailBackdrop, DetailFailure, DetailSkeleton, SectionHeading, SelectCircle } from '../title/components';
import { GET_THIS_TEXT } from '../title/text';
import { Screen } from '../ui';

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

/** The films the household can ask for now: Available to get, and not asked for on this page. */
function offeredFilms(films: readonly CollectionFilm[], askedHere: ReadonlySet<number>): CollectionFilm[] {
  return films.filter((film) => film.state === 'get_this' && !askedHere.has(film.tmdbId));
}

/** The films ticked at first: those on offer that are out. */
export function defaultChoice(films: readonly CollectionFilm[], askedHere: ReadonlySet<number> = new Set()): Set<number> {
  return new Set(offeredFilms(films, askedHere).filter((film) => film.released).map((film) => film.tmdbId));
}

export function CollectionScreen({ id, tab }: { id: number; tab: TitleTab }) {
  const data = useCollection(id);
  const overlay = useAsked();
  const { load } = data;
  return (
    <Screen maxWidth={DETAIL_MAX_WIDTH}>
      <Stack.Screen options={{ title: '' }} />
      {load.status === 'loading' ? <DetailSkeleton /> : null}
      {load.status === 'failed' ? <DetailFailure error={load.error} onRetry={data.reload} /> : null}
      {load.status === 'loaded' ? (
        <CollectionDetail
          collection={{ ...load.collection, films: load.collection.films.map((film) => overlay.card(film)) }}
          tab={tab}
          {...data}
        />
      ) : null}
    </Screen>
  );
}

function CollectionDetail({
  collection,
  tab,
  sending,
  outcome,
  askedHere,
  send,
}: { collection: Collection; tab: TitleTab } & Omit<ReturnType<typeof useCollection>, 'load' | 'reload'>) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const width = Math.max(0, Math.min(window.width, DETAIL_MAX_WIDTH) - Math.max(spacing.gutter, insets.left) - Math.max(spacing.gutter, insets.right));
  const offered = offeredFilms(collection.films, askedHere);
  // The films are drawn afresh through the overlay on every render: the first ticks are compared by their IDs.
  const defaultKey = [...defaultChoice(collection.films, askedHere)].join(',');
  const defaults = useMemo(() => new Set(defaultKey ? defaultKey.split(',').map(Number) : []), [defaultKey]);
  // The member's ticks, for the films on offer when they made them: read again (after asking), they start over.
  const [picks, setPicks] = useState<{ key: string; chosen: ReadonlySet<number> } | undefined>(undefined);
  const chosen = picks?.key === defaultKey ? picks.chosen : defaults;
  const picked = offered.filter((film) => chosen.has(film.tmdbId));
  const allMissing = picked.length > 0 && picked.length === defaults.size && picked.every((film) => defaults.has(film.tmdbId));
  const lines = outcome ? outcomeLines(outcome) : [];

  const toggle = (tmdbId: number) => {
    const next = new Set(chosen);
    if (next.has(tmdbId)) next.delete(tmdbId);
    else next.add(tmdbId);
    setPicks({ key: defaultKey, chosen: next });
  };

  return (
    <View style={styles.page}>
      <DetailBackdrop url={collection.backdropUrl} width={width} />
      <View style={styles.text}>
        <Text accessibilityRole="header" style={styles.title}>
          {collection.name}
        </Text>
        {collection.overview ? <Text style={styles.overview}>{collection.overview}</Text> : null}
        {offered.length || lines.length ? (
          <View testID="get-films" style={styles.actions}>
            {offered.length ? (
              <ActionButton
                label={sending ? GET_THIS_TEXT.sending : getFilmsLabel(picked.length, allMissing)}
                name={sending ? GET_THIS_TEXT.sending : `${getFilmsLabel(picked.length, allMissing)}: ${collection.name}`}
                onPress={() => send(picked)}
                disabled={picked.length === 0}
                busy={sending}
              />
            ) : null}
            {offered.length && picked.length === 0 && !sending ? <Text style={styles.muted}>{COLLECTION_TEXT.chooseBelow}</Text> : null}
            <View testID="films-message" accessibilityLiveRegion="polite" style={styles.messages}>
              {lines.map((line) => (
                <Text key={line} style={styles.message}>
                  {line}
                </Text>
              ))}
            </View>
          </View>
        ) : null}
      </View>
      <View style={styles.section}>
        <SectionHeading title={COLLECTION_TEXT.films} />
        {offered.length ? <Text style={styles.legend}>{COLLECTION_TEXT.chooseFilms}</Text> : null}
        {collection.films.length ? (
          <View testID="film-list" style={styles.films}>
            {collection.films.map((film) => (
              <FilmRow
                key={film.tmdbId}
                film={film}
                onOpen={() => router.push(titlePath(tab, film))}
                choice={
                  offered.some((candidate) => candidate.tmdbId === film.tmdbId)
                    ? { checked: chosen.has(film.tmdbId), disabled: sending, onToggle: () => toggle(film.tmdbId) }
                    : undefined
                }
              />
            ))}
          </View>
        ) : (
          <Text style={styles.muted}>{COLLECTION_TEXT.none}</Text>
        )}
      </View>
    </View>
  );
}

/** One film: a link (its title, year, status and, when it is not out yet, so) to its page, and its selection circle. */
function FilmRow({
  film,
  onOpen,
  choice,
}: {
  film: CollectionFilm;
  onOpen: () => void;
  choice: { checked: boolean; disabled: boolean; onToggle: () => void } | undefined;
}) {
  const upcoming = !film.released && film.state !== 'in_library';
  const name = [film.title, film.year ? String(film.year) : '', stateLabel(film.state), upcoming ? COLLECTION_TEXT.notReleased : ''].filter(Boolean).join(', ');
  return (
    <View testID="film-row" style={styles.film}>
      <Pressable accessibilityRole="link" accessibilityLabel={name} onPress={onOpen} style={({ pressed }) => [styles.filmLink, pressed && styles.pressed]}>
        <View style={styles.poster} {...hidden}>
          <TmdbImage uri={film.posterUrl} style={styles.fill} />
        </View>
        <View style={styles.filmText}>
          <Text style={styles.filmTitle}>{film.title}</Text>
          {film.year ? <Text style={styles.meta}>{film.year}</Text> : null}
          {upcoming ? <Text style={styles.meta}>{COLLECTION_TEXT.notReleased}</Text> : null}
          <StatusChip state={film.state} />
        </View>
      </Pressable>
      {choice ? <SelectCircle name={film.title} {...choice} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { gap: 20 },
  text: { gap: spacing.md },
  title: { ...typography.detailTitle, color: colors.text },
  overview: { ...typography.body, color: colors.text },
  muted: { ...typography.body, color: colors.muted },
  meta: { ...typography.meta, color: colors.muted },
  actions: { gap: spacing.sm, marginTop: spacing.xxs },
  messages: { gap: spacing.xxs },
  message: { ...typography.label, color: colors.text },
  section: { gap: spacing.md },
  legend: { ...typography.label, color: colors.text },
  films: { gap: spacing.md },
  film: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  filmLink: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: layout.touchTarget },
  pressed: { opacity: 0.75 },
  poster: { width: 56, aspectRatio: 2 / 3, borderRadius: radii.poster, backgroundColor: colors.surfaceRaised },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radii.poster },
  filmText: { flex: 1, gap: spacing.xxs, alignItems: 'flex-start' },
  filmTitle: { ...typography.label, color: colors.text },
});
