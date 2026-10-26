// My requests' pieces, the PWA's requestItem() (app/src/render.ts) in the Tidepool look: an entry with its title's
// thumbnail (TMDB's poster only, through the allowlist), its title and "year · Movie/Series", the coarse status, who
// asked, each season of a series with its own status, and the admin note where something did not work out: never a
// button. An entry is one link to its title, named once with everything it shows. Text grows with the system font size
// with no line limit, cap or fixed height.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CoarseStatus, HouseholdState, Request } from '../api/types';
import { safeImageUrl } from '../api/urls';
import { StatusChip, TmdbImage } from '../home/components';
import { colors, layout, radii, spacing, typography } from '../theme';
import { GET_THIS_TEXT } from '../title/text';
import { requestFailed, requestMeta, requestName, requestSeasonName, requestTitleText, whoText, type RequestTitle } from './text';

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

/** A coarse status as a chip: Requested, Ready to watch, or We couldn't get this (the PWA's request badges). */
export function RequestChip({ status }: { status: CoarseStatus }) {
  const state: HouseholdState = status === 'ready' ? 'in_library' : 'requested';
  return <StatusChip state={state} failed={status === 'failed'} />;
}

const THUMB = { width: 46, height: 68 };

export function RequestItem({ request, title, onOpen }: { request: Request; title: RequestTitle | undefined; onOpen: (request: Request) => void }) {
  const poster = title?.status === 'loaded' ? title.title.posterUrl : null;
  return (
    <Pressable
      testID="request-item"
      accessibilityRole="link"
      accessibilityLabel={requestName(request, title)}
      onPress={() => onOpen(request)}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}
    >
      <View style={[styles.thumb, !safeImageUrl(poster) && styles.thumbEmpty]} {...hidden}>
        <TmdbImage uri={poster} style={styles.thumbImage} />
      </View>
      <View style={styles.body} {...hidden}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{requestTitleText(title)}</Text>
          <Text style={styles.meta}>{requestMeta(request.mediaType, title)}</Text>
        </View>
        <RequestChip status={request.status} />
        <Text style={styles.who}>{whoText(request)}</Text>
        {request.seasons.length ? (
          <View style={styles.seasons}>
            {request.seasons.map((season) => (
              <View key={season.seasonNumber} style={styles.season}>
                <Text style={styles.seasonName}>{requestSeasonName(season.seasonNumber)}</Text>
                <RequestChip status={season.status} />
              </View>
            ))}
          </View>
        ) : null}
        {requestFailed(request) ? <Text style={styles.who}>{GET_THIS_TEXT.failedNote}</Text> : null}
      </View>
    </Pressable>
  );
}

/** The list while it loads: a thumbnail and two lines per entry, hidden from screen readers. */
export function SkeletonRequests() {
  return (
    <View testID="skeleton-requests" style={styles.list} {...hidden}>
      {Array.from({ length: 4 }, (_, index) => (
        <View key={index} style={[styles.item, styles.skeletonItem]}>
          <View style={[styles.thumb, styles.skeleton]} />
          <View style={styles.skeletonLines}>
            <View style={[styles.skeletonLine, styles.skeleton]} />
            <View style={[styles.skeletonLine, styles.skeletonShort, styles.skeleton]} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 9.6 },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12.8,
    minHeight: layout.touchTarget,
    paddingVertical: 11.2,
    paddingHorizontal: 12.8,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  pressed: { backgroundColor: colors.surfaceRaised },
  thumb: { ...THUMB, borderRadius: radii.chip, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  thumbEmpty: { borderWidth: 1, borderColor: colors.hairline },
  thumbImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  body: { flex: 1, minWidth: 0, gap: 5.6, alignItems: 'flex-start' },
  titleBlock: { gap: 1.6, minHeight: layout.touchTarget, justifyContent: 'center' },
  title: { ...typography.cardTitle, fontSize: 16, lineHeight: 21, color: colors.text },
  meta: { ...typography.meta, color: colors.muted },
  who: { fontSize: 13.6, lineHeight: 19, color: colors.muted },
  seasons: { gap: 5.6, alignSelf: 'stretch' },
  season: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  seasonName: { ...typography.body, fontSize: 15, color: colors.text },
  skeletonItem: { alignItems: 'center' },
  skeleton: { backgroundColor: colors.surfaceRaised },
  skeletonLines: { flex: 1, gap: spacing.sm },
  skeletonLine: { height: 12, borderRadius: 6, width: '80%' },
  skeletonShort: { width: '45%' },
});
