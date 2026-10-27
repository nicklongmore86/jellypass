// A network's or a studio's page, the PWA's sourceScreen() (app/src/main.ts) natively, on Home's stack: the header
// says "Popular on <network>" ("Series on" or "Films on" on those tabs) or "<studio> movies", over the logo
// (decorative: the header names it), a network's All | Series | Films tabs where the API lists films for it, and the
// same poster grid as Search (three columns on a phone, two on a very narrow one, as many as fit on an iPad) with Load
// more by the API's nextPage. The JustWatch credit closes a network's All and Films lists, whose films are TMDB's
// where-to-watch data. The tab chosen is put in the address (`?kind=`) in place, so the page keeps it under a title
// opened from it and Back comes back to it. A card opens the title on Home's stack. Each card is drawn through the
// overlay (src/title/asked.ts): Requested right after Get this, and a title's latest state from wherever it was read.
import { router, Stack } from 'expo-router';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Card } from '../api/types';
import { ErrorNotice, JustWatchNote, LogoTile } from '../home/components';
import { EMPTY_ROW_TEXT, sourceHeading, type SourceList } from '../home/text';
import { titlePath } from '../navigation/titles';
import { LoadMore, ResultsGrid, SkeletonGrid } from '../search/components';
import { gridCardWidth, gridColumns } from '../search/text';
import { useAsked, useSession } from '../session/SessionProvider';
import { SourceTabs } from '../source/components';
import { useSource, type ListState, type SourceKind } from '../source/useSource';
import { colors, layout, spacing, typography } from '../theme';
import { NotFoundScreen } from './NotFoundScreen';

export function SourceScreen({ kind, id, list }: { kind: SourceKind; id: number; list: SourceList }) {
  const { api, expire } = useSession();
  const overlay = useAsked();
  const { state, select, loadMore, retry } = useSource(api, expire, overlay, kind, id, list);
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const paddingLeft = Math.max(spacing.gutter, insets.left);
  const paddingRight = Math.max(spacing.gutter, insets.right);
  const columnWidth = Math.max(0, Math.min(window.width, layout.maxContentWidth) - paddingLeft - paddingRight);
  const columns = gridColumns(window.width, columnWidth);
  const cardWidth = gridCardWidth(columnWidth, columns);
  const open = (card: Card) => router.push(titlePath('home', card));
  const choose = (next: SourceList) => {
    select(next);
    // Replaced in place, as the PWA's history.replaceState: Back still leaves the page.
    router.setParams({ kind: next === 'all' ? undefined : next });
  };

  if (state.status === 'not_found') return <NotFoundScreen />;
  const title = state.status === 'ready' ? sourceHeading(kind, state.source.name, state.list) : '';

  return (
    <ScrollView testID="source-scroll" style={styles.page}>
      <Stack.Screen options={{ title }} />
      <View testID="screen-column" style={[styles.column, { paddingLeft, paddingRight }]}>
        {state.status === 'loading' ? <SkeletonGrid columns={columns} cardWidth={cardWidth} /> : null}
        {state.status === 'failed' ? <ErrorNotice error={state.error} onRetry={retry} secondary={false} /> : null}
        {state.status === 'ready' ? (
          <>
            <LogoTile source={state.source} size="large" />
            {state.lists.length > 1 ? <SourceTabs lists={state.lists} selected={state.list} onChoose={choose} /> : null}
            <Results shown={state.shown} columns={columns} cardWidth={cardWidth} overlay={overlay.card} onOpen={open} onMore={loadMore} onRetry={retry} />
            {kind === 'network' && state.list !== 'series' && state.shown.status === 'loaded' ? <JustWatchNote /> : null}
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}

function Results({
  shown,
  columns,
  cardWidth,
  overlay,
  onOpen,
  onMore,
  onRetry,
}: {
  shown: ListState;
  columns: number;
  cardWidth: number;
  overlay: (card: Card) => Card;
  onOpen: (card: Card) => void;
  onMore: () => void;
  onRetry: () => void;
}) {
  if (shown.status === 'loading') return <SkeletonGrid columns={columns} cardWidth={cardWidth} />;
  if (shown.status === 'failed') return <ErrorNotice error={shown.error} onRetry={onRetry} secondary={false} />;
  if (shown.cards.length === 0) return <Text style={styles.muted}>{EMPTY_ROW_TEXT}</Text>;
  return (
    <>
      <ResultsGrid testID="source-grid" cards={shown.cards.map(overlay)} cardWidth={cardWidth} onOpen={onOpen} />
      {shown.more.status === 'failed' ? <ErrorNotice error={shown.more.error} onRetry={onRetry} secondary={false} /> : null}
      {shown.nextPage !== null && shown.more.status !== 'failed' ? <LoadMore loading={shown.more.status === 'loading'} onPress={onMore} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  column: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', paddingTop: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  muted: { ...typography.body, color: colors.muted },
});
