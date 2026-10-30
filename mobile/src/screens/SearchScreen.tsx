// The Search tab, the PWA's search() (app/src/main.ts) natively: the field in a band that sticks under the header,
// then the results as a poster grid (three columns on a phone, two on a very narrow one, as many as fit on an iPad) with
// Load more by the API's nextPage. Results come as the member types (one call per pause, src/search/useSearch.ts) or
// at once on the keyboard's Search key; nothing is retried by itself. A card opens the title on the Search tab's own
// stack, so Back comes back to the results as they were. Each card is drawn through the overlay (src/title/asked.ts):
// Requested right after Get this, and a title's latest state from wherever it was read since. A title the member hid
// stays in the results, marked Hidden, with Unhide under it (src/hidden): Search is how a hidden title is found again.
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Card } from '../api/types';
import { ErrorNotice } from '../home/components';
import { titlePath } from '../navigation/titles';
import { LoadMore, ResultsGrid, SearchField, SkeletonGrid } from '../search/components';
import { gridCardWidth, gridColumns, noResultsText } from '../search/text';
import { useSearch, type SearchState } from '../search/useSearch';
import { useAsked, useHiddenTitles, useSession } from '../session/SessionProvider';
import { colors, layout, spacing, typography } from '../theme';

export function SearchScreen() {
  const { api, expire } = useSession();
  const overlay = useAsked();
  const hiddenTitles = useHiddenTitles();
  const search = useSearch(api, expire, overlay);
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const paddingLeft = Math.max(spacing.gutter, insets.left);
  const paddingRight = Math.max(spacing.gutter, insets.right);
  const columnWidth = Math.max(0, Math.min(window.width, layout.maxContentWidth) - paddingLeft - paddingRight);
  const columns = gridColumns(window.width, columnWidth);
  const cardWidth = gridCardWidth(columnWidth, columns);
  const open = (card: Card) => router.push(titlePath('search', card));

  return (
    <ScrollView
      testID="search-scroll"
      style={styles.page}
      stickyHeaderIndices={[0]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <View style={styles.band}>
        <View style={[styles.bandInner, { paddingLeft, paddingRight }]}>
          <SearchField value={search.text} onChangeText={search.type} onSubmit={search.submit} />
        </View>
      </View>
      <View testID="screen-column" style={[styles.column, { paddingLeft, paddingRight }]}>
        <Results
          state={search.state}
          columns={columns}
          cardWidth={cardWidth}
          overlay={(card) => hiddenTitles.card(overlay.card(card))}
          onOpen={open}
          onMore={search.loadMore}
          onRetry={search.retry}
        />
      </View>
    </ScrollView>
  );
}

function Results({
  state,
  columns,
  cardWidth,
  overlay,
  onOpen,
  onMore,
  onRetry,
}: {
  state: SearchState;
  columns: number;
  cardWidth: number;
  overlay: (card: Card) => Card;
  onOpen: (card: Card) => void;
  onMore: () => void;
  onRetry: () => void;
}) {
  if (state.status === 'idle') return null;
  if (state.status === 'loading') return <SkeletonGrid columns={columns} cardWidth={cardWidth} />;
  if (state.status === 'failed') return <ErrorNotice error={state.error} onRetry={onRetry} secondary={false} />;
  if (state.cards.length === 0) return <Text style={styles.muted}>{noResultsText(state.query)}</Text>;
  return (
    <>
      <ResultsGrid cards={state.cards.map(overlay)} cardWidth={cardWidth} onOpen={onOpen} unhide />
      {state.more.status === 'failed' ? <ErrorNotice error={state.more.error} onRetry={onRetry} secondary={false} /> : null}
      {state.nextPage !== null && state.more.status !== 'failed' ? <LoadMore loading={state.more.status === 'loading'} onPress={onMore} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  band: { backgroundColor: colors.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  bandInner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', paddingTop: spacing.xxs, paddingBottom: spacing.md },
  column: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', paddingTop: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  muted: { ...typography.body, color: colors.muted },
});
