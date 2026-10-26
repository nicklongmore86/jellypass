// The Home tab, the PWA's home() (app/src/main.ts) natively: the All | Movies | TV chips in a band that sticks under the
// header, the hero, then the chosen filter's rows in the PWA's order (src/home/layout.ts). The eager rows and the
// networks and studios are asked for at once; every other row only once it comes within LAZY_MARGIN of the screen,
// after the eager ones have answered, so Home stays inside docs/app-api/fetch-budget.json. Pull to refresh asks again;
// nothing is retried by itself. The filter stays as chosen while the app is open (Home stays mounted under its tab).
//
// Lazy rows are loaded by the member's own scrolling, plus one look per drawing (a filter chosen, or a refresh) at what
// is on screen at rest. "Near the screen" is measured from `reach`, the deepest the member has dragged in this drawing
// plus a screen and LAZY_MARGIN. Each drawing starts it again at nothing, whatever the old filter's offset was, and only
// a drag that began in this drawing (and the glide that follows it) moves it on: never the jump back to the first row,
// a restored offset, or a glide left over from before the switch. The look at rest is taken once, from the first
// layout after the eager rows have answered, and loads only the lazy rows on screen then. A row that comes back empty
// or failed shrinks and pulls the next rows up, but no later layout is looked at, so it can't load them in turn (which
// on a tall iPad would make every lazy call at once). A row's slot keeps its skeleton's height (skeletonRowHeight) while
// it waits or loads, so the rows below stay put until it has answered.
import { router } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Card, Network, Source } from '../api/types';
import {
  CardRow,
  FilterChips,
  Hero,
  JustWatchNote,
  NetworkHeading,
  RowFailure,
  RowHeading,
  SkeletonHero,
  SkeletonRow,
  skeletonRowHeight,
  StudioStrip,
} from '../home/components';
import { HERO_MAX, HOME_LAYOUT, LAZY_MARGIN, NETWORK_ACCENTS, networkKey, rowKey, TABLET_WIDTH, type HomeRow, type RowVariant } from '../home/layout';
import { HOME_TEXT, SOURCE_TEXT, type HomeFilter } from '../home/text';
import { listedNetworks, networkList, useHome, type RowState } from '../home/useHome';
import { useSession } from '../session/SessionProvider';
import { colors, layout, spacing } from '../theme';

/** Where a title opens: its page under the Home tab's stack. */
export function titlePath(card: Pick<Card, 'mediaType' | 'tmdbId'>): string {
  return `/home/${card.mediaType}/${card.tmdbId}`;
}

/** How wide each kind of card is: about 92% of the column on a phone (the next one peeks), 36% on a tablet. */
export function cardWidths(columnWidth: number, tablet: boolean): Record<RowVariant, number> {
  return {
    poster: tablet ? 168 : 132,
    backdrop: Math.round(columnWidth * (tablet ? 0.36 : 0.92)),
  };
}

interface Slot {
  key: string;
  lazy: boolean;
}

export function HomeScreen() {
  const { api, expire } = useSession();
  const home = useHome(api, expire);
  const { filter, rows, sources, started, near } = home;
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const tablet = window.width >= TABLET_WIDTH;
  const paddingLeft = Math.max(spacing.gutter, insets.left);
  const paddingRight = Math.max(spacing.gutter, insets.right);
  const columnWidth = Math.max(0, Math.min(window.width, layout.maxContentWidth) - paddingLeft - paddingRight);
  const widths = cardWidths(columnWidth, tablet);

  const scroller = useRef<ScrollViewInstance>(null);
  const scrollY = useRef(0);
  const viewport = useRef(0);
  /** How far down the member has brought the screen in this drawing: its bottom plus LAZY_MARGIN; 0 until they drag. */
  const reach = useRef(0);
  /** This screen's count of drawings: a drag belongs to the drawing it began in. */
  const drawn = useRef(0);
  /** The offset a drawing starts at, known when it starts: the top, or its first row after a filter is chosen. */
  const origin = useRef(0);
  /** The member's drag in progress, then the glide it set off; only one that began in this drawing moves `reach`. */
  const gesture = useRef<{ drawing: number; phase: 'dragging' | 'released' | 'gliding' } | undefined>(undefined);
  /** The drawing whose eager rows have all answered (`started`), so its rows are where they will stay. */
  const ready = useRef(-1);
  /** The drawing whose look at rest has been taken, and whether one is due after this batch of layouts. */
  const looked = useRef(-1);
  const looking = useRef(false);
  const columnY = useRef(0);
  const heroEnd = useRef(0);
  /** Each slot's top within the column, by key, as last laid out. */
  const slotY = useRef(new Map<string, number>());
  const [refreshing, setRefreshing] = useState(false);
  const announcing = useRef<HomeFilter | undefined>(undefined);

  const listed: Network[] = useMemo(() => (sources.status === 'loaded' ? listedNetworks(filter, sources.sources) : []), [filter, sources]);
  const parts = HOME_LAYOUT[filter];

  /** Every slot the filter has now, in order: lazy ones are fetched once they near the screen. */
  const slots: Slot[] = useMemo(
    () =>
      parts.flatMap((part): Slot[] => {
        if (part.part === 'row') return [{ key: rowKey(part), lazy: !part.eager }];
        if (part.part === 'networks') return listed.map((network) => ({ key: networkKey(network.id), lazy: true }));
        return [];
      }),
    [parts, listed],
  );

  /** Asks for every lazy row the member has scrolled within reach of; nothing before the eager rows have answered. */
  const check = useCallback(() => {
    if (!started || reach.current <= 0) return;
    const due = slots.filter((slot) => {
      const y = slotY.current.get(slot.key);
      return slot.lazy && y !== undefined && columnY.current + y <= reach.current;
    });
    if (due.length) near(due.map((slot) => slot.key));
  }, [started, slots, near]);

  /** The look at rest: once per drawing, the lazy rows on screen at the drawing's offset, never the margin below. */
  const look = useCallback(() => {
    if (ready.current !== drawn.current || looked.current === drawn.current || viewport.current <= 0) return;
    looked.current = drawn.current;
    const bottom = origin.current + viewport.current;
    const due = slots.filter((slot) => {
      const y = slotY.current.get(slot.key);
      return slot.lazy && y !== undefined && columnY.current + y < bottom;
    });
    if (due.length) near(due.map((slot) => slot.key));
  }, [slots, near]);

  /** After a layout: what is within reach, and the look at rest once this batch of layouts has all arrived. */
  const laidOut = () => {
    check();
    if (ready.current !== drawn.current || looked.current === drawn.current || looking.current) return;
    looking.current = true;
    const mine = drawn.current;
    void Promise.resolve().then(() => {
      looking.current = false;
      if (drawn.current === mine) look();
    });
  };

  /** A new drawing starts at `at`, reaching nothing until the member drags; a gesture from before it is let go. */
  const restart = (at: number) => {
    drawn.current += 1;
    origin.current = Math.max(0, at);
    reach.current = 0;
    gesture.current = undefined;
  };

  useEffect(() => check(), [check]);
  // Before any layout of this commit arrives: a `started` left over from the filter just switched from never counts.
  useLayoutEffect(() => {
    ready.current = started ? drawn.current : -1;
  }, [started]);

  useEffect(() => {
    if (started && announcing.current === filter) {
      announcing.current = undefined;
      AccessibilityInfo.announceForAccessibility?.(HOME_TEXT.shown[filter]);
    }
  }, [started, filter]);

  const choose = (next: HomeFilter) => {
    if (next === filter) return;
    announcing.current = next;
    AccessibilityInfo.announceForAccessibility?.('Loading…');
    // The chips stay where they are; a member far down the page starts the new filter at its first row.
    const deep = scrollY.current > heroEnd.current;
    if (deep) scroller.current?.scrollTo({ y: heroEnd.current, animated: false });
    restart(deep ? heroEnd.current : scrollY.current);
    home.choose(next);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    restart(scrollY.current);
    try {
      await home.refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const open = (card: Card) => router.push(titlePath(card));

  /** Where the screen is now; `reach` follows it only while the member drags, or glides on from a drag, in this drawing. */
  const follow = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement } = event.nativeEvent;
    scrollY.current = contentOffset.y;
    const own = gesture.current;
    if (!own || own.drawing !== drawn.current || own.phase === 'released' || contentOffset.y <= 0) return;
    const height = viewport.current || layoutMeasurement.height;
    reach.current = Math.max(reach.current, contentOffset.y + height + LAZY_MARGIN);
    check();
  };
  const onScrollBeginDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    gesture.current = { drawing: drawn.current, phase: 'dragging' };
    follow(event);
  };
  const onScrollEndDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    follow(event);
    if (gesture.current?.phase === 'dragging') gesture.current = { ...gesture.current, phase: 'released' };
  };
  const onMomentumScrollBegin = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Only the glide straight after the member lets go: not one the app started by scrolling itself.
    if (gesture.current?.phase === 'released') gesture.current = { ...gesture.current, phase: 'gliding' };
    follow(event);
  };
  const onMomentumScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    follow(event);
    if (gesture.current?.phase === 'gliding') gesture.current = undefined;
  };
  const onLayout = (event: LayoutChangeEvent) => {
    viewport.current = event.nativeEvent.layout.height;
    laidOut();
  };
  const placed = (key: string) => (event: LayoutChangeEvent) => {
    slotY.current.set(key, event.nativeEvent.layout.y);
    laidOut();
  };

  const first = parts[0] as HomeRow;
  const heroState = rows[rowKey(first)];
  const heroCards = heroState?.status === 'loaded' ? heroState.page.results.slice(0, HERO_MAX) : [];

  const titleRow = (part: HomeRow) => {
    const key = rowKey(part);
    return (
      <View key={key} testID={`home-slot-${key}`} onLayout={placed(key)} style={{ minHeight: reserved(rows[key], part.variant, widths[part.variant]) }}>
        <RowBody
          state={rows[key]}
          heading={<RowHeading title={part.heading} />}
          title={part.heading}
          variant={part.variant}
          cardWidth={widths[part.variant]}
          onOpen={open}
          onRetry={() => home.retry(key)}
        />
      </View>
    );
  };

  const networkRow = (network: Network) => {
    const key = networkKey(network.id);
    const prefix = SOURCE_TEXT.networkPrefix[networkList(filter, network)];
    return (
      <View key={key} testID={`home-slot-${key}`} onLayout={placed(key)} style={{ minHeight: reserved(rows[key], 'poster', widths.poster) }}>
        <RowBody
          state={rows[key]}
          heading={
            <RowHeading title={`${prefix} ${network.name}`} accent={NETWORK_ACCENTS[network.id]}>
              <NetworkHeading prefix={prefix} network={network} />
            </RowHeading>
          }
          title={`${prefix} ${network.name}`}
          variant="poster"
          cardWidth={widths.poster}
          onOpen={open}
          onRetry={() => home.retry(key)}
        />
      </View>
    );
  };

  const studios: readonly Source[] = sources.status === 'loaded' ? sources.sources.studios : [];
  const sourcesFailure =
    sources.status === 'failed' ? (
      <RowFailure key="sources-failed" heading="Studios and networks" error={sources.error} onRetry={home.retrySources} />
    ) : null;
  const hasStudios = parts.some((part) => part.part === 'studios');

  return (
    <ScrollView
      ref={scroller}
      testID="home-scroll"
      style={styles.page}
      stickyHeaderIndices={[0]}
      onScroll={follow}
      onScrollBeginDrag={onScrollBeginDrag}
      onScrollEndDrag={onScrollEndDrag}
      onMomentumScrollBegin={onMomentumScrollBegin}
      onMomentumScrollEnd={onMomentumScrollEnd}
      scrollEventThrottle={16}
      onLayout={onLayout}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.accent} />}
    >
      <View testID="home-switch" style={styles.band}>
        <View style={[styles.bandInner, { paddingLeft, paddingRight }]}>
          <FilterChips selected={filter} onChoose={choose} />
        </View>
      </View>
      <View
        testID="screen-column"
        style={[styles.column, { paddingLeft, paddingRight }]}
        onLayout={(event) => {
          columnY.current = event.nativeEvent.layout.y;
          laidOut();
        }}
      >
        <View
          onLayout={(event) => {
            heroEnd.current = columnY.current + event.nativeEvent.layout.y + event.nativeEvent.layout.height;
          }}
        >
          {heroState?.status === 'loading' ? <SkeletonHero tablet={tablet} /> : null}
          {heroCards.length ? <Hero key={filter} cards={heroCards} filter={filter} width={columnWidth} tablet={tablet} onOpen={open} /> : null}
        </View>
        {parts.map((part) => {
          if (part.part === 'row') return titleRow(part);
          if (part.part === 'networks') return hasStudios ? listed.map(networkRow) : [sourcesFailure, ...listed.map(networkRow)];
          if (part.part === 'studios') return sourcesFailure ?? (studios.length ? <StudioStrip key="studios" studios={studios} /> : null);
          // The JustWatch credit closes the services: only where a service's films are shown.
          return listed.some((network) => network.hasFilms) && filter !== 'tv' ? <JustWatchNote key="credit" /> : null;
        })}
      </View>
    </ScrollView>
  );
}

/** The height a row's slot keeps: its skeleton's while it waits or loads, then only what it shows. */
function reserved(state: RowState | undefined, variant: RowVariant, cardWidth: number): number | undefined {
  return state?.status === 'loaded' || state?.status === 'failed' ? undefined : skeletonRowHeight(variant, cardWidth);
}

/** One row by its state: a skeleton while it waits or loads, the cards, or its failure with Try again. */
function RowBody({
  state,
  heading,
  title,
  variant,
  cardWidth,
  onOpen,
  onRetry,
}: {
  state: RowState | undefined;
  heading: ReactNode;
  title: string;
  variant: RowVariant;
  cardWidth: number;
  onOpen: (card: Card) => void;
  onRetry: () => void;
}) {
  if (state?.status === 'failed') return <RowFailure heading={title} error={state.error} onRetry={onRetry} />;
  if (state?.status !== 'loaded') return <SkeletonRow variant={variant} cardWidth={cardWidth} />;
  return (
    <View style={styles.row}>
      {heading}
      <CardRow cards={state.page.results} variant={variant} cardWidth={cardWidth} onOpen={onOpen} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  band: { backgroundColor: colors.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  bandInner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', paddingTop: spacing.xxs, paddingBottom: 6 },
  column: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', paddingTop: spacing.lg, paddingBottom: spacing.xxl, gap: 28 },
  row: { gap: spacing.md },
});
