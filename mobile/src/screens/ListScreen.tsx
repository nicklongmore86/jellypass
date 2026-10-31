// A Discover row's "See all" page, the TV add-on's list page (tv/src/discover-source.ts, `list` kind) natively, on
// Home's stack: the row's heading in the header, "New only" (the same choice as Home's), and the network and studio
// pages' poster grid (src/screens/SourceScreen.tsx) with Load more by the API's nextPage. No logo, no tabs and no
// JustWatch credit: every list is TMDB's own. Opened from its row it draws the row's page at once, with no call
// (src/home/rowPages.ts). A card opens the title on Home's stack, and Back from it comes back to the same grid. Each
// card is drawn through the overlay (src/title/asked.ts), and a title the member hides leaves the grid at once.
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Card } from '../api/types';
import { HideChip } from '../home/components';
import { useHideHeld } from '../home/hide';
import type { HomeRow } from '../home/layout';
import { titlePath } from '../navigation/titles';
import { gridCardWidth, gridColumns } from '../search/text';
import { useAsked, useHiddenTitles, useSession } from '../session/SessionProvider';
import { useList } from '../source/useList';
import { colors, layout, spacing } from '../theme';
import { Results } from './SourceScreen';

export function ListScreen({ row }: { row: HomeRow }) {
  const { api, expire, hideHeld, rowPages } = useSession();
  const hide = useHideHeld(hideHeld);
  const overlay = useAsked();
  const hiddenTitles = useHiddenTitles();
  // The row's page, taken once as the page opens: it is the grid's first page.
  const [kept] = useState(() => rowPages.take(row.list));
  const { shown, loadMore, retry } = useList(api, expire, overlay, row.list, kept);
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const paddingLeft = Math.max(spacing.gutter, insets.left);
  const paddingRight = Math.max(spacing.gutter, insets.right);
  const columnWidth = Math.max(0, Math.min(window.width, layout.maxContentWidth) - paddingLeft - paddingRight);
  const columns = gridColumns(window.width, columnWidth);
  const cardWidth = gridCardWidth(columnWidth, columns);
  const open = (card: Card) => router.push(titlePath('home', card));

  return (
    <ScrollView testID="list-scroll" style={styles.page}>
      <Stack.Screen options={{ title: row.heading }} />
      <View testID="screen-column" style={[styles.column, { paddingLeft, paddingRight }]}>
        <View style={styles.hideRow}>
          <HideChip testID="list-hide" value={hide} onToggle={() => hideHeld.set(!hide)} />
        </View>
        <Results
          hide={hide}
          shown={shown}
          columns={columns}
          cardWidth={cardWidth}
          overlay={overlay.card}
          visible={hiddenTitles.visible}
          onOpen={open}
          onMore={loadMore}
          onRetry={retry}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  column: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', paddingTop: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  hideRow: { flexDirection: 'row' },
});
