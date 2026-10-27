// My requests' pieces, the PWA's requestItem() (app/src/render.ts) in the Tidepool look: an entry with its title's
// thumbnail (TMDB's poster only, through the allowlist), its title and "year · Movie/Series", who asked, and each
// status once: one chip for a movie, a series of one season or seasons sharing one status (said on the meta line,
// "2027 · Series · Season 1"), else a chip per season and none for the entry; the admin note under what did not work
// out. Never a button. An entry is one link to its title, named once with everything it shows. Text grows with the system font size
// with no line limit, cap or fixed height.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CoarseStatus, HouseholdState, Request } from '../api/types';
import { safeImageUrl } from '../api/urls';
import { StatusChip, TmdbImage } from '../home/components';
import { Icon } from '../icons';
import { colors, layout, radii, spacing, typography } from '../theme';
import { GET_THIS_TEXT } from '../title/text';
import {
  REQUEST_FILTER_TEXT,
  REQUEST_KIND_FILTERS,
  REQUEST_STATUS_FILTERS,
  requestMeta,
  requestName,
  requestNoteHere,
  requestPills,
  requestSeasonName,
  requestTitleText,
  whoText,
  type RequestFilter,
  type RequestTitle,
} from './text';

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

/** A coarse status as a chip: Requested, Ready to watch, or We couldn't get this (the PWA's request badges). */
export function RequestChip({ status }: { status: CoarseStatus }) {
  const state: HouseholdState = status === 'ready' ? 'in_library' : 'requested';
  return <StatusChip state={state} failed={status === 'failed'} />;
}

const THUMB = { width: 46, height: 68 };

function FilterChip({ role, label, checked, testID, onPress }: { role: 'radio' | 'checkbox'; label: string; checked: boolean; testID: string; onPress: () => void }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={{ checked, selected: checked }}
      onPress={onPress}
      style={({ pressed }) => [styles.filter, checked && styles.filterChecked, pressed && styles.pressed]}
    >
      {checked ? <Icon name="check" color={colors.accentText} size={17.6} strokeWidth={2.6} /> : null}
      <Text style={[styles.filterText, checked && styles.filterTextChecked]}>{label}</Text>
    </Pressable>
  );
}

/**
 * My requests' filters, the PWA's requestFilterBar() (app/src/render.ts) in Home's chip look: Status and Type are radio
 * groups of outlined chips, "Asked by me" a checkbox chip; the chosen one is filled with the cyan tint, outlined in cyan and
 * ticked, never colour alone. Chips wrap onto more lines at large text rather than hide. Choosing one reads nothing.
 */
export function RequestFilters({ filter, onChange }: { filter: RequestFilter; onChange: (filter: RequestFilter) => void }) {
  return (
    <View testID="request-filters" style={styles.filters}>
      <View testID="request-filter-group-status" accessibilityRole="radiogroup" accessibilityLabel={REQUEST_FILTER_TEXT.statusLabel} style={styles.filterGroup}>
        {REQUEST_STATUS_FILTERS.map((status) => (
          <FilterChip key={status} role="radio" testID={`request-filter-status-${status}`} label={REQUEST_FILTER_TEXT.status[status]} checked={filter.status === status} onPress={() => onChange({ ...filter, status })} />
        ))}
      </View>
      <View testID="request-filter-group-kind" accessibilityRole="radiogroup" accessibilityLabel={REQUEST_FILTER_TEXT.kindLabel} style={styles.filterGroup}>
        {REQUEST_KIND_FILTERS.map((kind) => (
          <FilterChip key={kind} role="radio" testID={`request-filter-kind-${kind}`} label={REQUEST_FILTER_TEXT.kind[kind]} checked={filter.kind === kind} onPress={() => onChange({ ...filter, kind })} />
        ))}
      </View>
      <View accessibilityLabel={REQUEST_FILTER_TEXT.whoLabel} style={styles.filterGroup}>
        <FilterChip role="checkbox" testID="request-filter-by-you" label={REQUEST_FILTER_TEXT.byYou} checked={filter.byYou} onPress={() => onChange({ ...filter, byYou: !filter.byYou })} />
      </View>
    </View>
  );
}

export function RequestItem({ request, title, onOpen }: { request: Request; title: RequestTitle | undefined; onOpen: (request: Request) => void }) {
  const poster = title?.status === 'loaded' ? title.title.posterUrl : null;
  const pills = requestPills(request);
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
          <Text style={styles.meta}>{requestMeta(request.mediaType, title, pills.seasonsText)}</Text>
        </View>
        {pills.status ? <RequestChip status={pills.status} /> : null}
        <Text style={styles.who}>{whoText(request)}</Text>
        {pills.perSeason ? (
          <View style={styles.seasons}>
            {request.seasons.map((season) => (
              <View key={season.seasonNumber} testID="request-season" style={styles.season}>
                <Text style={styles.seasonName}>{requestSeasonName(season.seasonNumber)}</Text>
                <RequestChip status={season.status} />
                {season.status === 'failed' ? <Text style={[styles.who, styles.seasonNote]}>{GET_THIS_TEXT.failedNote}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}
        {requestNoteHere(request) ? <Text style={styles.who}>{GET_THIS_TEXT.failedNote}</Text> : null}
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
  filters: { gap: spacing.sm },
  filterGroup: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  filter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6.4,
    minHeight: layout.touchTarget,
    minWidth: 72,
    paddingHorizontal: 17.6,
    borderWidth: 1.5,
    borderColor: colors.hairline,
    borderRadius: radii.chip,
  },
  filterChecked: { backgroundColor: colors.accentTint, borderColor: colors.accent },
  filterText: { fontSize: 15.2, lineHeight: 20, fontWeight: '700', color: colors.muted },
  filterTextChecked: { color: colors.accentText },
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
  seasonNote: { flexBasis: '100%' },
  skeletonItem: { alignItems: 'center' },
  skeleton: { backgroundColor: colors.surfaceRaised },
  skeletonLines: { flex: 1, gap: spacing.sm },
  skeletonLine: { height: 12, borderRadius: 6, width: '80%' },
  skeletonShort: { width: '45%' },
});
