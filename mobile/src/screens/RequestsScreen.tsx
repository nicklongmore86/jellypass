// The My requests tab, the PWA's requestsScreen() (app/src/main.ts) natively: the household's requests from GET
// /requests, each with its title's thumbnail and name, the coarse status (per season for a series), who asked, and the
// admin note where something did not work out; Load more for the next ten. The list is read each time the screen is
// shown (as the PWA reads it on each visit) and on pull to refresh; nothing is retried by itself. An entry opens its
// title on the My requests tab's own stack, so Back comes back here.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Request } from '../api/types';
import { ErrorNotice } from '../home/components';
import { titlePath } from '../navigation/titles';
import { RequestItem, SkeletonRequests } from '../requests/components';
import { REQUESTS_TEXT } from '../requests/text';
import { useRequests } from '../requests/useRequests';
import { LoadMore } from '../search/components';
import { useAsked, useSession } from '../session/SessionProvider';
import { colors, spacing, typography } from '../theme';

/** The list stops widening here on iPad (the stylesheet's 46rem). */
export const REQUESTS_MAX_WIDTH = 736;

export function RequestsScreen() {
  const { api, expire } = useSession();
  const overlay = useAsked();
  const data = useRequests(api, expire, overlay);
  const { reload, stop } = data;
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void reload();
      return stop;
    }, [reload, stop]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  const open = (request: Request) => router.push(titlePath('requests', request));
  const { load } = data;

  return (
    <ScrollView
      testID="requests-scroll"
      style={styles.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.accent} />}
    >
      <View
        testID="screen-column"
        style={[styles.column, { paddingLeft: Math.max(spacing.gutter, insets.left), paddingRight: Math.max(spacing.gutter, insets.right) }]}
      >
        {load.status === 'loading' ? <SkeletonRequests /> : null}
        {load.status === 'failed' ? <ErrorNotice error={load.error} onRetry={() => void reload()} secondary={false} /> : null}
        {load.status === 'loaded' && load.requests.length === 0 ? <Text style={styles.muted}>{REQUESTS_TEXT.empty}</Text> : null}
        {load.status === 'loaded' && load.requests.length ? (
          <View testID="request-list" style={styles.list}>
            {load.requests.slice(0, data.shown).map((request) => (
              <RequestItem key={request.id} request={request} title={data.titles[request.id]} onOpen={open} />
            ))}
          </View>
        ) : null}
        {load.status === 'loaded' && data.shown < load.requests.length ? <LoadMore loading={data.naming} onPress={data.loadMore} /> : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  column: { width: '100%', maxWidth: REQUESTS_MAX_WIDTH, alignSelf: 'center', paddingTop: spacing.md, paddingBottom: spacing.xxl, gap: spacing.lg },
  list: { gap: 9.6 },
  muted: { ...typography.body, color: colors.muted },
});
