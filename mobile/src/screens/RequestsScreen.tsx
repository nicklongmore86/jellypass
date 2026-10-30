// The My requests tab, the PWA's requestsScreen() (app/src/main.ts) natively: the household's requests from GET
// /requests, each with its title's thumbnail and name, the coarse status (per season for a series), who asked, and the
// admin note where something did not work out; Load more for the next ten. The list is read each time the screen is
// shown (as the PWA reads it on each visit) and on pull to refresh, its titles only if not named in the last ten
// minutes of this sign-in; nothing is retried by itself. An entry opens its
// title on the My requests tab's own stack, so Back comes back here. An entry the server lists as cancellable has a
// Cancel request button, which asks first (CancelSheet) and then cancels (useRequests).
//
// Where the household can hide titles (`apiVersion` 3), Requests | Hidden tabs come first: Hidden lists the member's
// own hidden titles (src/hidden/useHiddenList.ts), newest first, each with Unhide, and is read each time it is shown
// instead of the requests. The filters belong to Requests alone. The tab chosen is kept while the screen is open.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { HiddenTitle, Request } from '../api/types';
import { HiddenItem, HideViewTabs } from '../hidden/components';
import type { HideTarget } from '../hidden/store';
import { backText, HIDE_TEXT, type HideView } from '../hidden/text';
import { useHiddenList, type HiddenListData } from '../hidden/useHiddenList';
import { ErrorNotice } from '../home/components';
import { titlePath } from '../navigation/titles';
import { useRequestFilter } from '../requests/filters';
import { CancelSheet, RequestFilters, RequestItem, SkeletonRequests } from '../requests/components';
import { matchesRequestFilter, REQUEST_FILTER_TEXT, requestFilterActive, requestFilterEmptyText, REQUESTS_TEXT } from '../requests/text';
import { useRequests } from '../requests/useRequests';
import { LoadMore } from '../search/components';
import { useAsked, useHiddenTitles, useSession } from '../session/SessionProvider';
import { colors, spacing, typography } from '../theme';
import { Button } from '../ui';

/** The list stops widening here on iPad (the stylesheet's 46rem). */
export const REQUESTS_MAX_WIDTH = 736;

export function RequestsScreen() {
  const { api, expire, titles, requestFilters, cancelRequest, canHide, hiddenTitles } = useSession();
  const filter = useRequestFilter(requestFilters);
  const overlay = useAsked();
  const data = useRequests(api, expire, overlay, titles, cancelRequest);
  const hiddenList = useHiddenList(api, expire, overlay, titles, hiddenTitles);
  const { reload, stop, cancel } = data;
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<HideView>('requests');
  const showing: HideView = canHide ? view : 'requests';
  const { reload: reloadHidden, stop: stopHidden } = hiddenList;

  // The view shown is read each time it is shown: the screen coming into focus, or the other tab chosen.
  useFocusEffect(
    useCallback(() => {
      if (showing === 'hidden') {
        void reloadHidden();
        return stopHidden;
      }
      void reload();
      return stop;
    }, [showing, reload, stop, reloadHidden, stopHidden]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await (showing === 'hidden' ? reloadHidden() : reload());
    } finally {
      setRefreshing(false);
    }
  };

  const open = (request: Request) => router.push(titlePath('requests', request));
  const { load } = data;
  // Only entries already listed and named are filtered: choosing a filter reads nothing (Load more names ten more).
  const visible = load.status === 'loaded' ? load.requests.slice(0, data.shown).filter((request) => matchesRequestFilter(request, filter)) : [];

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
        {canHide ? <HideViewTabs selected={showing} onChoose={setView} /> : null}
        {showing === 'hidden' ? <HiddenView data={hiddenList} /> : null}
        {showing === 'requests' ? (
          <>
            {cancel.notice ? (
              <Text testID="cancel-notice" accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice}>{cancel.notice}</Text>
            ) : null}
            {load.status === 'loading' ? <SkeletonRequests /> : null}
            {load.status === 'failed' ? <ErrorNotice error={load.error} onRetry={() => void reload()} secondary={false} /> : null}
            {load.status === 'loaded' && load.requests.length === 0 ? <Text style={styles.muted}>{REQUESTS_TEXT.empty}</Text> : null}
            {load.status === 'loaded' && load.requests.length ? <RequestFilters filter={filter} onChange={requestFilters.set} /> : null}
            {load.status === 'loaded' && load.requests.length ? (
              <View testID="request-list" style={styles.list}>
                {visible.map((request) => (
                  <RequestItem key={request.id} request={request} title={data.titles[request.id]} onOpen={open} onCancel={cancel.ask} />
                ))}
              </View>
            ) : null}
            {load.status === 'loaded' && visible.length > 0 && requestFilterActive(filter) && data.shown < load.requests.length ? (
              <Text testID="request-filter-more" style={styles.muted}>{REQUEST_FILTER_TEXT.more}</Text>
            ) : null}
            {load.status === 'loaded' && load.requests.length && data.shown > 0 && visible.length === 0 ? (
              <View testID="request-filter-empty" style={styles.none}>
                <Text style={styles.muted}>{requestFilterEmptyText(filter, data.shown < load.requests.length)}</Text>
                {requestFilterActive(filter) ? <Button label={REQUEST_FILTER_TEXT.showAll} onPress={requestFilters.reset} secondary /> : null}
              </View>
            ) : null}
            {load.status === 'loaded' && data.shown < load.requests.length ? <LoadMore loading={data.naming} onPress={data.loadMore} /> : null}
          </>
        ) : null}
      </View>
      <CancelSheet
        request={cancel.target}
        title={cancel.target ? data.titles[cancel.target.id] : undefined}
        sending={cancel.sending}
        error={cancel.error}
        onConfirm={cancel.confirm}
        onKeep={cancel.keep}
      />
    </ScrollView>
  );
}

/**
 * The Hidden tab: the member's hidden titles as entries, each with Unhide; an entry unhidden here (or anywhere in this
 * session) leaves the list at once, with no call, and the screen says it is back in Discover.
 */
function HiddenView({ data }: { data: HiddenListData }) {
  const hiddenTitles = useHiddenTitles();
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const { load } = data;
  const open = (entry: HiddenTitle) => router.push(titlePath('requests', entry));
  const visible = load.status === 'loaded' ? load.entries.slice(0, data.shown).filter((entry) => hiddenTitles.isHidden({ ...entry, hidden: true })) : [];
  const more = load.status === 'loaded' && (data.shown < load.entries.length || load.nextPage !== null);
  let body: ReactNode = null;
  if (load.status === 'loading') body = <SkeletonRequests />;
  else if (load.status === 'failed') body = <ErrorNotice error={load.error} onRetry={() => void data.reload()} secondary={false} />;
  else if (visible.length === 0 && !more) body = <Text testID="hidden-empty" style={styles.muted}>{HIDE_TEXT.empty}</Text>;
  return (
    <>
      {notice ? (
        <Text testID="hidden-notice" accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice}>
          {notice}
        </Text>
      ) : null}
      {body}
      {visible.length ? (
        <View testID="hidden-list" style={styles.list}>
          {visible.map((entry) => {
            const key = `${entry.mediaType}:${entry.tmdbId}`;
            return (
              <HiddenItem
                key={key}
                entry={entry}
                title={data.titles[key]}
                onOpen={open}
                onUnhidden={(target: HideTarget) => setNotice(backText(target))}
              />
            );
          })}
        </View>
      ) : null}
      {data.more.status === 'failed' ? <ErrorNotice error={data.more.error} onRetry={data.loadMore} secondary={false} /> : null}
      {more && data.more.status !== 'failed' ? <LoadMore loading={data.naming} onPress={data.loadMore} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  column: { width: '100%', maxWidth: REQUESTS_MAX_WIDTH, alignSelf: 'center', paddingTop: spacing.md, paddingBottom: spacing.xxl, gap: spacing.lg },
  list: { gap: 9.6 },
  muted: { ...typography.body, color: colors.muted },
  notice: { ...typography.body, fontWeight: '700', color: colors.text },
  none: { gap: spacing.md, alignItems: 'flex-start' },
});
