// The Home tab, the PWA's home() (app/src/main.ts) natively: the All | Movies | TV chips in a band that sticks under the
// header, the hero, then the chosen filter's rows in the PWA's order (src/home/layout.ts). The eager rows and the
// networks and studios are asked for at once; every other row only once it comes within LAZY_MARGIN of the screen,
// after the eager ones have answered, so Home stays inside docs/app-api/fetch-budget.json. Pull to refresh asks again;
// nothing is retried by itself. The filter stays as chosen while the app is open (Home stays mounted under its tab).
//
// Lazy rows are loaded in order, one at a time, by the screen moving down, plus one look per drawing (a filter chosen,
// or a refresh) at what is on screen at rest. A scroll event may ask for the next lazy row only if the screen has gone
// down past `from` (where the last row was asked for, or the furthest up it has been since) and that row's top is
// within LAZY_MARGIN of the screen's bottom; it asks for that one row and no more. At the content's end, where the
// screen can go no further (and where it lands when rows above shrink), a scroll event asks for every lazy row still on
// screen instead: they are all in view, and nothing is below them. Any scrolling counts, the member's drag
// and glide as much as a screen reader's scroll action, a mouse wheel or a keyboard, because what moves it on is the
// screen going down, never a layout (but for the page fitting whole, below): a row that comes back empty or failed
// shrinks and pulls the next rows up, but that alone asks for nothing (on a tall iPad it once made every lazy call at
// once). Going back up lowers `from`, so a member whose end moved up as rows shrank can nudge the rest in. Each drawing starts `from` again where it starts, once the
// scroll view has caught up with it: the app's jump back to the first row has landed and a glide from before has
// stopped (or the member touches the screen); scroll events until then belong to the old drawing. The look at rest is
// taken once, from the first layout after the eager rows have answered, and loads only the lazy rows on screen then. A
// row's slot keeps its skeleton's height (skeletonRowHeight) while it waits or loads, so the rows below stay put until
// it has answered.
//
// Two things load every lazy row still on screen at once, and only ever rows already on screen, never the margin below
// nor a row that comes into view after: a scroll event at the content's end (above), even one that hasn't gone down
// past `from`, as rows above it shrank and the end came up to the screen; and, once per drawing, the content fitting on
// the screen whole after the eager rows have answered and a batch of layouts has arrived (a tall Android tablet whose
// rows shrank at the top: the page can't scroll, and Android sends no scroll event to say where it is).
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
import { heroSlides, useHideHeld, visibleCards } from '../home/hide';
import { HERO_MAX, HOME_LAYOUT, LAZY_MARGIN, NETWORK_ACCENTS, networkKey, rowKey, TABLET_WIDTH, type HomeRow, type RowVariant } from '../home/layout';
import { HOME_TEXT, SOURCE_TEXT, type HomeFilter } from '../home/text';
import { listedNetworks, networkList, useHome, type RowState } from '../home/useHome';
import { networkPath, studioPath, titlePath } from '../navigation/titles';
import { useAsked, useSession } from '../session/SessionProvider';
import { colors, layout, spacing } from '../theme';

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
  const { api, expire, hideHeld } = useSession();
  const hide = useHideHeld(hideHeld);
  // What the member just asked for shows as Requested on every card at once, with no call, and a title's state read
  // since (its page opened again) wins over the row's older answer (src/title/asked.ts).
  const overlay = useAsked();
  const home = useHome(api, expire, overlay);
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
  /** This screen's count of drawings. */
  const drawn = useRef(0);
  /** The offset a drawing starts at, known when it starts: the top, or its first row after a filter is chosen. */
  const origin = useRef(0);
  /** Where the next lazy row may be asked for from: the screen must go down past it. */
  const from = useRef(0);
  /** The lazy rows asked for in this drawing. */
  const asked = useRef(new Set<string>());
  /** The member's touch or glide under way, whatever drawing it began in. */
  const moving = useRef<'dragging' | 'gliding' | undefined>(undefined);
  /** A new drawing the scroll view hasn't caught up with: the jump back to `landing` still to come, or an old glide. */
  const stale = useRef<{ landing: number | undefined; gliding: boolean } | undefined>(undefined);
  /** The drawing whose eager rows have all answered (`started`), so its rows are where they will stay. */
  const ready = useRef(-1);
  /** The drawing whose look at rest has been taken, and whether one is due after this batch of layouts. */
  const looked = useRef(-1);
  const looking = useRef(false);
  /** The drawing whose fits-on-screen check has asked for its rows: once per drawing, like the look at rest. */
  const fitted = useRef(-1);
  const columnY = useRef(0);
  /** Where the content ends: the column's bottom, as last laid out. */
  const contentEnd = useRef(0);
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

  /** Asks for lazy rows not asked for yet in this drawing. */
  const ask = useCallback(
    (keys: readonly string[]) => {
      const fresh = keys.filter((key) => !asked.current.has(key));
      for (const key of fresh) asked.current.add(key);
      if (fresh.length) near(fresh);
    },
    [near],
  );

  /**
   * The screen has gone down to `y`: asks for the next lazy row, in order, if its top is within LAZY_MARGIN of the
   * screen's bottom; or, at the content's end, where the screen can go no further, for every lazy row on screen.
   */
  const advance = (y: number, height: number, end: boolean): boolean => {
    if (ready.current !== drawn.current || (y <= 0 && !end)) return false;
    const waiting = slots.filter((slot) => slot.lazy && !asked.current.has(slot.key));
    const bottom = y + height + (end ? 0 : LAZY_MARGIN);
    const due = (end ? waiting : waiting.slice(0, 1)).filter((slot) => {
      const top = slotY.current.get(slot.key);
      return top !== undefined && columnY.current + top < bottom;
    });
    ask(due.map((slot) => slot.key));
    return due.length > 0;
  };

  /** The look at rest: once per drawing, the lazy rows on screen at the drawing's offset, never the margin below. */
  const look = useCallback(() => {
    if (ready.current !== drawn.current || looked.current === drawn.current || viewport.current <= 0) return;
    looked.current = drawn.current;
    const bottom = origin.current + viewport.current;
    const due = slots.filter((slot) => {
      const y = slotY.current.get(slot.key);
      return slot.lazy && y !== undefined && columnY.current + y < bottom;
    });
    ask(due.map((slot) => slot.key));
  }, [slots, ask]);

  /**
   * When the whole content fits on screen, once per drawing: every lazy row still waiting, all on screen, never the
   * margin below. The page can't scroll then, so no scroll event (none at all on Android) would ever ask for them.
   */
  const fit = useCallback(() => {
    if (ready.current !== drawn.current || fitted.current === drawn.current || viewport.current <= 0) return;
    if (contentEnd.current <= 0 || contentEnd.current > viewport.current) return;
    fitted.current = drawn.current;
    const due = slots.filter((slot) => {
      const y = slotY.current.get(slot.key);
      return slot.lazy && y !== undefined && columnY.current + y < viewport.current;
    });
    ask(due.map((slot) => slot.key));
  }, [slots, ask]);

  /**
   * After a layout: once this batch of layouts has all arrived, the look at rest, and the fits-on-screen check. Nothing
   * else; a layout that leaves the page taller than the screen moves nothing on.
   */
  const laidOut = () => {
    if (ready.current !== drawn.current || looking.current) return;
    if (looked.current === drawn.current && fitted.current === drawn.current) return;
    looking.current = true;
    const mine = drawn.current;
    void Promise.resolve().then(() => {
      looking.current = false;
      if (drawn.current !== mine) return;
      look();
      fit();
    });
  };

  /** A new drawing starts at `at`, after the app's own jump there if it `jumped`; until then scroll events are the old one's. */
  const restart = (at: number, jumped: boolean) => {
    drawn.current += 1;
    origin.current = Math.max(0, at);
    from.current = origin.current;
    asked.current = new Set();
    const gliding = moving.current === 'gliding';
    stale.current = jumped || gliding ? { landing: jumped ? origin.current : undefined, gliding } : undefined;
  };

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
    restart(deep ? heroEnd.current : scrollY.current, deep);
    if (deep) scroller.current?.scrollTo({ y: heroEnd.current, animated: false });
    home.choose(next);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    restart(scrollY.current, false);
    try {
      await home.refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const open = (card: Card) => router.push(titlePath('home', card));
  const openStudio = (studio: Source) => router.push(studioPath(studio.id));

  /** The scroll view has caught up with the new drawing: it starts moving on from where the screen is now. */
  const caughtUp = (y: number) => {
    stale.current = undefined;
    from.current = y;
  };

  /** Where the screen is now: going down past `from` may ask for the next lazy row; going up lowers `from`. */
  const follow = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const y = contentOffset.y;
    scrollY.current = y;
    const old = stale.current;
    if (old) {
      if (old.landing !== undefined && y <= old.landing + 1) old.landing = undefined;
      if (old.landing === undefined && !old.gliding) caughtUp(y);
      return;
    }
    const end = y + layoutMeasurement.height >= contentSize.height - 1;
    if ((y > from.current || end) && advance(y, viewport.current || layoutMeasurement.height, end)) from.current = y;
    else if (y < from.current) from.current = y;
  };
  const onScrollBeginDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    moving.current = 'dragging';
    // The member's touch stops anything left over from before: this drawing moves on from here.
    if (stale.current) caughtUp(event.nativeEvent.contentOffset.y);
  };
  const onScrollEndDrag = () => {
    moving.current = undefined;
  };
  const onMomentumScrollBegin = () => {
    moving.current = 'gliding';
  };
  const onMomentumScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    moving.current = undefined;
    const old = stale.current;
    if (!old) return;
    old.gliding = false;
    if (old.landing === undefined) caughtUp(event.nativeEvent.contentOffset.y);
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
  // New only: the hero skips what the member has and fills from the next titles of the same answer.
  const heroCards = heroState?.status === 'loaded' ? heroSlides(heroState.page.results.map((card) => overlay.card(card)), hide, HERO_MAX) : [];

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
          viewport={columnWidth}
          overlay={overlay.card}
          hide={hide}
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
              <NetworkHeading prefix={prefix} network={network} onOpen={() => router.push(networkPath(network.id, networkList(filter, network)))} />
            </RowHeading>
          }
          title={`${prefix} ${network.name}`}
          variant="poster"
          cardWidth={widths.poster}
          viewport={columnWidth}
          overlay={overlay.card}
          hide={hide}
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
        <View style={styles.bandInner}>
          <FilterChips selected={filter} onChoose={choose} hide={{ value: hide, onToggle: () => hideHeld.set(!hide) }} inset={{ left: paddingLeft, right: paddingRight }} />
        </View>
      </View>
      <View
        testID="screen-column"
        style={[styles.column, { paddingLeft, paddingRight }]}
        onLayout={(event) => {
          columnY.current = event.nativeEvent.layout.y;
          contentEnd.current = event.nativeEvent.layout.y + event.nativeEvent.layout.height;
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
          if (part.part === 'studios') return sourcesFailure ?? (studios.length ? <StudioStrip key="studios" studios={studios} viewport={columnWidth} onOpen={openStudio} /> : null);
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
  viewport,
  overlay,
  hide,
  onOpen,
  onRetry,
}: {
  state: RowState | undefined;
  heading: ReactNode;
  title: string;
  variant: RowVariant;
  cardWidth: number;
  /** How wide the row shows: the column. */
  viewport: number;
  /** The card as it is drawn: Requested if the member just asked for it. */
  overlay: (card: Card) => Card;
  /** New only: the cards the member has are left out. */
  hide: boolean;
  onOpen: (card: Card) => void;
  onRetry: () => void;
}) {
  if (state?.status === 'failed') return <RowFailure heading={title} error={state.error} onRetry={onRetry} />;
  if (state?.status !== 'loaded') return <SkeletonRow variant={variant} cardWidth={cardWidth} />;
  return (
    <View style={styles.row}>
      {heading}
      <CardRow cards={visibleCards(state.page.results.map(overlay), hide)} variant={variant} cardWidth={cardWidth} viewport={viewport} onOpen={onOpen} />
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
