// A movie's, a series' and a season's page, the PWA's titleDetail() and seasonView() (app/src/render.ts) natively, on
// the stack of the tab it was opened from (/home/movie/<id>, /search/tv/<id>, /requests/tv/<id>/season/<n>, …). The inset backdrop card, then the
// title, its facts, genres, the status (and its note), and one full-width action: Play when the title is in the
// library (its own Jellyfin link, through the allowlist), Get this when the household can ask for it, nothing else
// otherwise. A series partly in the library keeps Play and shows Get this outlined. A series lists its seasons as
// cards, each with a round selection circle where the household can ask, and Select all; Get this sends exactly the
// seasons chosen (HD only: the API asks for nothing else). A season page lists its episodes and can ask for itself.
//
// Each answer is drawn through the overlay (src/title/asked.ts), so a title just asked for shows Requested at once,
// here, on Home and on any other page that shows it. The header carries only Back: the page's title is its one heading.
//
// Where the household can hide titles, a movie's or series' page has Not interested (Unhide once hidden) under its
// actions (src/hidden/components.tsx): the page stays open, and the toast offers Undo. A season is never hidden alone.
//
// A film in a collection (server `apiVersion` 6) has the collection's own section under its overview, last on the page
// (a film has no seasons below it), so the actions and description come first: the heading "Part of
// <name>" (the whole heading row and its chevron open the collection page), then the collection's other films as poster
// cards, Home's, with their states. The film itself is left out: its own page is the one open. The collection is read
// once the page is drawn; until it answers the heading stands over placeholder posters, and if the read fails the plain
// "Part of <name>" link is all that is left (the page itself never waits for it, nor shows its failure).
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CollectionLink, Movie, Season, Series } from '../api/types';
import { safePlayUrl } from '../api/urls';
import { ALL_SEASONS_TEXT, partOfText, seeAllFilmsText } from '../collection/text';
import { useCollectionPreview } from '../collection/useCollectionPreview';
import { CardRow, ListHeading, SkeletonRow } from '../home/components';
import { TABLET_WIDTH } from '../home/layout';
import { collectionPath, seasonPath, titlePath, type TitleTab } from '../navigation/titles';
import { HideTitleButton } from '../hidden/components';
import { useAsked, useHiddenTitles, useSession } from '../session/SessionProvider';
import { colors, layout, spacing, typography } from '../theme';
import {
  DETAIL_MAX_WIDTH,
  DETAIL_TABLET_WIDTH,
  DetailBackdrop,
  DetailFailure,
  DetailPoster,
  DetailSkeleton,
  DetailStatus,
  Facts,
  FactLine,
  Genres,
  GetThisBox,
  PlayButton,
  SeasonCard,
  SectionHeading,
} from '../title/components';
import { episodesText, episodeTitle, GET_THIS_TEXT, seasonName, SEASONS_TEXT } from '../title/text';
import { useTitle, type GetThisState, type TitleRoute } from '../title/useTitle';
import { Button, Screen } from '../ui';
import { cardWidths } from './HomeScreen';

/** The column's width, inside the gutters and the detail page's widest. */
function useColumn() {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const gutters = Math.max(spacing.gutter, insets.left) + Math.max(spacing.gutter, insets.right);
  return {
    width: Math.max(0, Math.min(window.width, DETAIL_MAX_WIDTH) - gutters),
    tablet: window.width >= DETAIL_TABLET_WIDTH,
    posterWidth: cardWidths(0, window.width >= TABLET_WIDTH).poster,
  };
}

/** `tab`: the tab whose stack the page is on, where its season pages open too. */
export function TitleScreen({ route, tab }: { route: TitleRoute; tab: TitleTab }) {
  const data = useTitle(route);
  const asked = useAsked();
  const { load } = data;
  return (
    <Screen maxWidth={DETAIL_MAX_WIDTH}>
      <Stack.Screen options={{ title: '' }} />
      {load.status === 'loading' ? <DetailSkeleton /> : null}
      {load.status === 'failed' ? <DetailFailure error={load.error} onRetry={data.reload} /> : null}
      {load.status === 'loaded' && load.answer.season ? (
        <SeasonDetail season={asked.season(load.answer.season)} series={load.answer.title as Series | undefined} failed={load.answer.failed} {...data} />
      ) : null}
      {load.status === 'loaded' && !load.answer.season && load.answer.title ? (
        <TitleDetail
          title={load.answer.title.mediaType === 'tv' ? asked.series(load.answer.title) : asked.movie(load.answer.title)}
          failed={load.answer.failed}
          failedFilms={load.answer.failedFilms}
          tab={tab}
          {...data}
        />
      ) : null}
    </Screen>
  );
}

interface DetailProps {
  failed: ReadonlySet<number>;
  get: GetThisState;
  send: (seasons: readonly number[]) => void;
  reload: () => void;
}

function TitleDetail({ title, failed, failedFilms, get, send, reload, tab }: DetailProps & { title: Movie | Series; failedFilms: ReadonlySet<number>; tab: TitleTab }) {
  const { api, hasCollections } = useSession();
  const hiddenTitles = useHiddenTitles();
  const collection = title.mediaType === 'movie' && hasCollections ? title.collection : null;
  const column = useColumn();
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const series = title.mediaType === 'tv' ? title : undefined;

  const failedSeason = (seasonNumber: number, state: string) => state === 'get_this' && failed.has(seasonNumber);
  const choices = series
    ? series.seasons
        .filter((season) => season.state === 'get_this' && season.seasonNumber >= 1 && !get.asked.has(season.seasonNumber) && !failedSeason(season.seasonNumber, season.state))
        .map((season) => season.seasonNumber)
    : !get.asked.has(0) && !failed.has(0) && title.state === 'get_this'
      ? [0]
      : [];
  const failedMovie = !series && title.state === 'get_this' && failed.has(0);
  const failedAny = failedMovie || (series?.seasons.some((season) => failedSeason(season.seasonNumber, season.state)) ?? false);
  const play = title.state === 'in_library' && api ? safePlayUrl(title.play, api.address.origin) : undefined;
  const picking = series !== undefined;
  const selected = choices.filter((season) => chosen.has(season));
  const toggling = get.sending;
  const controls = choices.length > 0 && !get.reloading && !get.refreshFailed;

  const onSend = () => {
    send(picking ? selected : []);
    if (picking) setChosen(new Set());
  };
  const onSendAll = () => {
    send(choices);
    setChosen(new Set());
  };
  const toggle = (seasonNumber: number) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(seasonNumber)) next.delete(seasonNumber);
      else next.add(seasonNumber);
      return next;
    });
  const allChosen = choices.length > 0 && selected.length === choices.length;

  return (
    <View style={styles.page}>
      <DetailBackdrop url={title.backdropUrl} width={column.width} />
      <View style={[styles.head, column.tablet && styles.headWide]}>
        {column.tablet ? <DetailPoster url={title.posterUrl} /> : null}
        <View style={[styles.text, column.tablet && styles.textWide]}>
          <Text accessibilityRole="header" style={styles.title}>
            {title.title}
          </Text>
          <Facts title={title} />
          <Genres genres={title.genres} />
          <DetailStatus state={title.state} failed={failedMovie} failedNote={failedAny} />
          {play || choices.length || get.confirmed || get.error ? (
            <View style={styles.actions}>
              {play ? <PlayButton title={title.title} url={play} /> : null}
              <GetThisBox
                subject={title.title}
                offered={choices.length > 0}
                picking={picking}
                chosen={selected.length}
                get={get}
                secondary={play !== undefined}
                onSend={onSend}
                onReload={reload}
              />
            </View>
          ) : null}
          <HideTitleButton target={title} hidden={hiddenTitles.isHidden(title)} />
        </View>
      </View>
      {title.overview ? <Text style={styles.overview}>{title.overview}</Text> : null}
      {collection ? (
        <CollectionSection
          key={collection.id}
          collection={collection}
          filmId={title.tmdbId}
          failedFilms={failedFilms}
          tab={tab}
          width={column.width}
          posterWidth={column.posterWidth}
        />
      ) : null}
      {series ? (
        <View style={styles.section}>
          <SectionHeading title={SEASONS_TEXT.heading} />
          {picking && controls ? (
            <View style={styles.picker}>
              <Text style={styles.legend}>{GET_THIS_TEXT.chooseSeasons}</Text>
              {/* Every season still to get, in one request: the same as Select all, then Get this. */}
              <Button label={ALL_SEASONS_TEXT} onPress={() => onSendAll()} disabled={toggling} />
              {choices.length > 1 ? (
                <Button
                  label={allChosen ? GET_THIS_TEXT.clearAll : GET_THIS_TEXT.selectAll}
                  onPress={() => setChosen(allChosen ? new Set() : new Set(choices))}
                  disabled={toggling}
                  secondary
                />
              ) : null}
            </View>
          ) : null}
          {series.seasons.length ? (
            <View testID="season-list" accessibilityLabel={picking && controls ? GET_THIS_TEXT.chooseSeasons : undefined} style={[styles.seasons, column.tablet && styles.seasonsWide]}>
              {series.seasons.map((season) => {
                const name = seasonName(season.name, season.seasonNumber);
                const offered = controls && choices.includes(season.seasonNumber);
                return (
                  <SeasonCard
                    key={season.seasonNumber}
                    name={name}
                    episodes={episodesText(season.episodeCount)}
                    state={season.state}
                    failed={failedSeason(season.seasonNumber, season.state)}
                    wide={column.tablet}
                    onOpen={() => router.push(seasonPath(tab, series.tmdbId, season.seasonNumber))}
                    choice={offered ? { checked: chosen.has(season.seasonNumber), disabled: toggling, onToggle: () => toggle(season.seasonNumber) } : undefined}
                  />
                );
              })}
            </View>
          ) : (
            <Text style={styles.muted}>{SEASONS_TEXT.none}</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** The plain link to a collection's page: all a film's page shows of it when the collection could not be read. */
function CollectionLinkText({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <Pressable
      testID="collection-link"
      accessibilityRole="link"
      accessibilityLabel={partOfText(name)}
      onPress={onOpen}
      style={({ pressed }) => [styles.collection, pressed && styles.pressed]}
    >
      <Text style={styles.collectionText}>{partOfText(name)}</Text>
    </Pressable>
  );
}

/**
 * A film's collection: its heading (a header, "Part of <name>", the whole row a touch target and its chevron the one
 * "See all films in <name>" link, both to the collection page), then the collection's other films as Home's poster
 * cards, each a link to its own page with its state, drawn through the overlay and the hidden titles as the collection
 * page draws them ("Hidden" under one the member hid). Placeholder posters while it is read; the plain link if it fails.
 */
function CollectionSection({
  collection,
  filmId,
  failedFilms,
  tab,
  width,
  posterWidth,
}: {
  collection: CollectionLink;
  filmId: number;
  /** The films the household asked for that failed, from the film page's own GET /requests (no read of its own). */
  failedFilms: ReadonlySet<number>;
  tab: TitleTab;
  width: number;
  posterWidth: number;
}) {
  const preview = useCollectionPreview(collection.id);
  const overlay = useAsked();
  const hiddenTitles = useHiddenTitles();
  const open = () => router.push(collectionPath(tab, collection.id));
  if (preview.status === 'failed') return <CollectionLinkText name={collection.name} onOpen={open} />;
  const films =
    preview.status === 'loaded' ? preview.collection.films.filter((film) => film.tmdbId !== filmId).map((film) => hiddenTitles.card(overlay.card(film))) : [];
  return (
    <View testID="collection-preview" style={styles.section}>
      <ListHeading
        title={partOfText(collection.name)}
        linkName={seeAllFilmsText(collection.name)}
        testID="collection-link"
        linkTestID="collection-see-all"
        onOpen={open}
      />
      {preview.status === 'loading' ? <SkeletonRow variant="poster" cardWidth={posterWidth} heading={false} /> : null}
      {films.length ? (
        <CardRow
          cards={films}
          variant="poster"
          cardWidth={posterWidth}
          viewport={width}
          onOpen={(card) => router.push(titlePath(tab, card))}
          // As the collection page says it: a film still to get whose request failed is "We couldn't get this".
          failed={(card) => card.state === 'get_this' && failedFilms.has(card.tmdbId)}
        />
      ) : null}
    </View>
  );
}

function SeasonDetail({ season, series, failed, get, send, reload }: DetailProps & { season: Season; series: Series | undefined }) {
  const column = useColumn();
  const name = seasonName(season.name, season.seasonNumber);
  const failedHere = season.state === 'get_this' && failed.has(season.seasonNumber);
  const offered = season.state === 'get_this' && season.seasonNumber >= 1 && !get.asked.has(season.seasonNumber) && !failed.has(season.seasonNumber);
  const count = season.episodes.length;
  return (
    <View style={styles.page}>
      <DetailBackdrop url={series?.backdropUrl} width={column.width} />
      <View style={styles.text}>
        {series ? <Text style={styles.eyebrow}>{series.title}</Text> : null}
        <Text accessibilityRole="header" style={styles.title}>
          {name}
        </Text>
        <FactLine facts={count ? [episodesText(count)] : []} />
        <DetailStatus state={season.state} failed={failedHere} failedNote={failedHere} />
        {offered || get.confirmed || get.error ? (
          <View style={styles.actions}>
            <GetThisBox
              subject={[series?.title, name].filter(Boolean).join(' ')}
              offered={offered}
              picking={false}
              chosen={1}
              get={get}
              secondary={false}
              onSend={() => send([season.seasonNumber])}
              onReload={reload}
            />
          </View>
        ) : null}
      </View>
      {season.overview ? <Text style={styles.overview}>{season.overview}</Text> : null}
      {season.episodes.length ? (
        <View testID="episode-list" style={styles.episodes}>
          {season.episodes.map((episode) => (
            <View key={episode.episodeNumber} style={styles.episode}>
              <Text accessibilityRole="header" style={styles.episodeTitle}>
                {episodeTitle(episode.episodeNumber, episode.name)}
              </Text>
              {episode.overview ? <Text style={styles.muted}>{episode.overview}</Text> : null}
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.muted}>{SEASONS_TEXT.noEpisodes}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { gap: 20 },
  head: { gap: spacing.lg },
  headWide: { flexDirection: 'row', alignItems: 'flex-start' },
  text: { gap: spacing.md },
  textWide: { flex: 1 },
  eyebrow: { ...typography.label, color: colors.muted },
  collection: { minHeight: layout.touchTarget, justifyContent: 'center', alignSelf: 'flex-start' },
  collectionText: { ...typography.label, color: colors.accent, textDecorationLine: 'underline' },
  pressed: { opacity: 0.75 },
  title: { ...typography.detailTitle, color: colors.text },
  actions: { gap: spacing.md, marginTop: spacing.xxs },
  overview: { ...typography.body, color: colors.text },
  muted: { ...typography.body, color: colors.muted },
  section: { gap: spacing.md },
  picker: { gap: spacing.sm, alignItems: 'flex-start' },
  legend: { ...typography.label, color: colors.text },
  seasons: { gap: spacing.md },
  seasonsWide: { flexDirection: 'row', flexWrap: 'wrap' },
  episodes: { gap: spacing.lg },
  episode: { gap: spacing.xxs },
  episodeTitle: { ...typography.label, color: colors.text },
});
