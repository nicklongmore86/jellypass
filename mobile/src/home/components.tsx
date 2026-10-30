// Home's pieces, the PWA's (app/src/render.ts) in the Tidepool look: status chips, poster and backdrop cards, row
// headings with their waterlines, the rows, the hero, the filter chips, the studios' strip and the row failure.
//
// - Images are TMDB's only, through the API client's allowlist (src/api/urls.ts); one that fails to load is dropped,
//   leaving its plain frame, and nothing else changes.
// - A card is one link whose name is its title, year and rating, then its status, said once; the status chip drawn on
//   the image is hidden from screen readers.
// - Text grows with the system font size with no line limit, cap or fixed height: titles wrap, the chips scroll.
// - Where the household can hide titles, a card's long press opens the "Not interested" sheet and screen readers get the
//   same as the card's own action (src/hidden/HideProvider.tsx); a card the member hid (Search only) says Hidden.
import { Children, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Image,
  PixelRatio,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type StyleProp,
  useWindowDimensions,
} from 'react-native';

import type { Card, HouseholdState, Source } from '../api/types';
import { useCardHideProps } from '../hidden/HideProvider';
import { HIDE_TEXT } from '../hidden/text';
import { backdropSources, safeImageUrl, safeLogoUrl } from '../api/urls';
import { Icon } from '../icons';
import { colors, layout, radii, spacing, status as statusColors, typography, water } from '../theme';
import { Button } from '../ui';
import { badgeFits, nearestStop, POSTER_BADGE, resnapOffset, revealOffset, snapOffsets, type RowShape, type RowVariant } from './layout';
import {
  backdropMeta,
  cardName,
  EMPTY_ROW_TEXT,
  ERROR_TEXT,
  HERO_TEXT,
  HOME_FILTERS,
  HOME_TEXT,
  posterMeta,
  ratingLabel,
  ratingText,
  REQUEST_LABELS,
  RETRY_TEXT,
  shortOverview,
  networkLinkName,
  listLinkName,
  SOURCE_TEXT,
  BADGE_WORDS,
  badgeWord,
  stateLabel,
  studioLinkName,
  studioName,
  type ErrorText,
  type HomeFilter,
} from './text';

const SKELETON_HEADING_HEIGHT = 26;

/** The space between the cards in a row, and how wide a studio's logo tile is. */
export const CARD_GAP = spacing.md;
export const STUDIO_TILE_WIDTH = 136;

/**
 * A sideways row snaps so a swipe always comes to rest with a card centred (snapOffsets). A fast flick still glides
 * across several cards: the momentum is left alone, at the normal rate, and only where it stops is moved to the nearest
 * card.
 *
 * - iOS snaps natively, with snapToOffsets. Nothing more is animated, so it is the same with Reduce Motion on.
 * - Android is not given snapToOffsets: React Native turns any snap stops into native paging there, and a paged
 *   ReactHorizontalScrollView neither scrolls a focused card into view nor lets Tab reach a card off screen
 *   (requestChildFocus, addFocusables). Instead, once a touch's glide stops, the row is moved to the nearest stop with
 *   scrollTo (SnapRow), without animation under Reduce Motion. Only a touch does that: a row scrolled by focus, a
 *   screen reader or a keyboard is left where that put it.
 */
export function rowSnapping(count: number, item: number, viewport: number, os = Platform.OS) {
  const offsets = snapOffsets(count, item, CARD_GAP, viewport);
  if (!offsets) return {};
  return os === 'android' ? ({ decelerationRate: 'normal' } as const) : ({ snapToOffsets: offsets, decelerationRate: 'normal' } as const);
}

/** Whether the member asked for reduced motion; false until the system says. */
function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((value) => {
        if (live) setReduceMotion(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return reduceMotion;
}

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/** What a card in a SnapRow calls when it takes focus. */
const CardFocus = createContext<(() => void) | undefined>(undefined);

/**
 * A sideways row of `count` items `item` wide in a `viewport` that wide, snapping as rowSnapping says. Its cards tell it
 * when they take focus (CardFocus), so a card reached by the keyboard mid-glide is not then scrolled away from.
 *
 * On Android a touch's end is told by onMomentumScrollEnd, which always follows the drag's onScrollEndDrag there (the
 * native handlePostTouchScrolling sends it once the row has been still a few frames, glide or none) and never follows
 * a focus or accessibility scroll. The snap's own scrollTo ends with one too; it is ignored, as the touch is over by
 * then, as is the one sent when a new touch stops a running glide or snap, as a finger is down.
 *
 * An animated snap runs on its own native animator, which a focus scroll does not stop (ReactHorizontalScrollView's
 * scrollToChild only calls scrollBy), so it would carry a card focused mid-snap off screen. A card that takes focus
 * then is revealed with an animated scrollTo of its own: starting one cancels the running one first
 * (startFlingAnimator), where a scrollTo without animation would not. The cancelled snap still sends a momentum end,
 * part way; should the snap have run to its stop instead (the reveal found nothing to do, or started after it), the
 * card is put in view there without animation.
 *
 * When the row's width changes (the device turned, or an iPad's split view resized) it is moved, without animation,
 * to the stop that keeps the same card in view (resnapOffset), on either platform: neither re-snaps by itself. A change
 * that comes while the row is moving (a finger on it, a glide, a snap or a reveal) waits until it is still: after a
 * touch, the row goes to the nearest stop, as the finger chose where it is in the new shape.
 */
function SnapRow({
  testID,
  count,
  item,
  viewport,
  children,
}: {
  testID: string;
  count: number;
  item: number;
  viewport: number;
  children: ReactNode;
}) {
  const reduceMotion = useReduceMotion();
  const row = useRef<ScrollViewInstance>(null);
  const x = useRef(0);
  const width = useRef(0);
  const shape = useRef<RowShape>({ count, item, gap: CARD_GAP, viewport });
  // A finger is on the row; a touch moved the row and its glide has not ended yet.
  const dragging = useRef(false);
  const touched = useRef(false);
  // Where a running animated snap, and a focused card's reveal that replaced it, are taking the row.
  const snapTo = useRef<number | undefined>(undefined);
  const revealTo = useRef<number | undefined>(undefined);
  // The row's shape before a width change that came while it was moving, until it is still.
  const resized = useRef<RowShape | undefined>(undefined);
  const android = Platform.OS === 'android';

  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  // Android scrolls to whole physical pixels, so a row sent to 1690.5 at density 1 comes to rest at 1691: an offset
  // within a pixel (and never less than half a point) of where it was sent has reached it.
  const reached = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.5, 1 / PixelRatio.get()) + 1e-6;
  const moveTo = (to: number | undefined, animated: boolean) => {
    if (to === undefined || reached(to, x.current)) return false;
    x.current = to;
    row.current?.scrollTo({ x: to, animated });
    return true;
  };
  const still = () => !dragging.current && !touched.current && snapTo.current === undefined && revealTo.current === undefined;
  /** A width change held while the row moved, applied once it is still. */
  const settle = (afterTouch: boolean) => {
    const before = resized.current;
    if (!before || !still()) return;
    resized.current = undefined;
    const now = shape.current;
    const offsets = snapOffsets(now.count, now.item, now.gap, now.viewport);
    moveTo(afterTouch ? offsets && nearestStop(offsets, x.current) : resnapOffset(x.current, before, now), false);
  };
  const onScroll = (event: ScrollEvent) => {
    x.current = event.nativeEvent.contentOffset.x;
  };
  const onScrollBeginDrag = () => {
    // A touch stops a running snap or reveal (onInterceptTouchEvent cancels the animator).
    dragging.current = true;
    touched.current = true;
    snapTo.current = undefined;
    revealTo.current = undefined;
  };
  const onScrollEndDrag = (event: ScrollEvent) => {
    dragging.current = false;
    onScroll(event);
    // iOS sends no momentum end for a drag let go without a glide.
    if (!android && !event.nativeEvent.velocity?.x) {
      touched.current = false;
      settle(true);
    }
  };
  const onMomentumScrollEnd = (event: ScrollEvent) => {
    onScroll(event);
    if (dragging.current) return;
    const reveal = revealTo.current;
    if (reveal !== undefined) {
      if (reached(x.current, reveal)) {
        revealTo.current = undefined;
      } else if (snapTo.current !== undefined && reached(x.current, snapTo.current)) {
        revealTo.current = undefined;
        moveTo(reveal, false);
      }
      snapTo.current = undefined;
      settle(false);
      return;
    }
    if (snapTo.current !== undefined) {
      snapTo.current = undefined;
      settle(false);
      return;
    }
    const glided = touched.current;
    touched.current = false;
    if (!android || !glided || resized.current) {
      settle(true);
      return;
    }
    const offsets = snapOffsets(count, item, CARD_GAP, viewport);
    const to = offsets && nearestStop(offsets, x.current);
    if (moveTo(to, !reduceMotion) && !reduceMotion) snapTo.current = to;
  };
  const onCardFocus = (index: number) => {
    touched.current = false;
    if (snapTo.current === undefined && revealTo.current === undefined) return;
    const to = revealOffset(shape.current, index);
    if (to === undefined) return;
    revealTo.current = to;
    row.current?.scrollTo({ x: to, animated: true });
  };
  const onLayout = (event: LayoutChangeEvent) => {
    const now = event.nativeEvent.layout.width;
    const before = shape.current;
    const after = { count, item, gap: CARD_GAP, viewport };
    shape.current = after;
    if (width.current > 0 && !near(now, width.current)) {
      if (still()) moveTo(resnapOffset(x.current, before, after), false);
      else resized.current ??= before;
    }
    width.current = now;
  };

  return (
    <ScrollView
      ref={row}
      testID={testID}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.rowList}
      scrollEventThrottle={16}
      onScroll={onScroll}
      onLayout={onLayout}
      onScrollBeginDrag={onScrollBeginDrag}
      onScrollEndDrag={onScrollEndDrag}
      onMomentumScrollEnd={onMomentumScrollEnd}
      {...rowSnapping(count, item, viewport)}
    >
      {Children.map(children, (child, index) => (
        <CardFocus value={() => onCardFocus(index)}>{child}</CardFocus>
      ))}
    </ScrollView>
  );
}

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

const STATE_COLORS: Record<HouseholdState, { bg: string; text: string }> = {
  in_library: statusColors.ok,
  get_this: statusColors.get,
  unavailable: statusColors.bad,
  requested: statusColors.warn,
};

const NO_BREAK_SPACE = '\u00a0';

/**
 * Where a card draws its status: in the compact corner pill over the image if the pill is estimated to fit on one line at
 * the user's text size (POSTER_BADGE in ./layout), else below the image. The longest short word decides, so every card of a
 * width places it the same way.
 */
function useBadgePlacement(cardWidth: number): 'overlay' | 'below' {
  const { fontScale } = useWindowDimensions();
  const longest = Object.values(BADGE_WORDS).reduce((a, b) => (b.length > a.length ? b : a));
  return badgeFits(cardWidth, fontScale, longest) ? 'overlay' : 'below';
}

/**
 * A status chip: a dot and its word, solid, so it reads over any picture. `overlay` puts the short word in a compact pill on
 * an image's top-left, on one line; `below` is the same short word and colours as ordinary text in the card's flow, which
 * wraps if the text size is large. Neither caps the text size. Hidden from screen readers where its card's name already
 * says it; a title page's own status is `spoken`. `failed` is a title the household asked for that did not work out: "We
 * couldn't get this".
 */
export function StatusChip({
  state,
  overlay = false,
  below = false,
  spoken = false,
  failed = false,
}: {
  state: HouseholdState;
  overlay?: boolean;
  below?: boolean;
  spoken?: boolean;
  failed?: boolean;
}) {
  const pair = failed || !Object.hasOwn(STATE_COLORS, state) ? STATE_COLORS.unavailable : STATE_COLORS[state];
  const label = failed ? REQUEST_LABELS.failed : stateLabel(state);
  const short = (overlay || below) && !failed;
  // On a card the badge is the short word; the full wording stays the card's (or `spoken`) name.
  const shown = !short ? label : overlay ? badgeWord(state).replace(/ /g, NO_BREAK_SPACE) : badgeWord(state);
  return (
    <View
      testID="status-chip"
      style={[styles.chip, { backgroundColor: pair.bg }, overlay && styles.chipOverlay, below && styles.chipBelow]}
      {...(spoken ? { accessible: true, accessibilityLabel: label } : hidden)}
    >
      <View style={[styles.chipDot, overlay && !failed && styles.chipOverlayDot, { backgroundColor: pair.text }]} />
      <Text style={[styles.chipText, overlay && !failed && styles.chipOverlayText, { color: pair.text }]}>{shown}</Text>
    </View>
  );
}

/** A TMDB image (anything off the allowlist is never loaded); one that fails to load is dropped, leaving its frame. */
export function TmdbImage({ uri, style, logo = false }: { uri: string | null | undefined; style: StyleProp<ImageStyle>; logo?: boolean }) {
  const [broken, setBroken] = useState(false);
  const safe = logo ? safeLogoUrl(uri) : safeImageUrl(uri);
  if (!safe || broken) return null;
  return (
    <Image
      testID="tmdb-image"
      source={{ uri: safe }}
      style={style}
      resizeMode={logo ? 'contain' : 'cover'}
      onError={() => setBroken(true)}
      accessibilityIgnoresInvertColors
      {...hidden}
    />
  );
}

/** A backdrop at the width that suits the space it fills: w780, or w1280 on a wide or dense screen. */
export function backdropUri(url: string | null, width: number, scale = PixelRatio.get()): string | undefined {
  const sources = backdropSources(url);
  if (!sources) return undefined;
  return width * scale > 780 ? sources.large : sources.small;
}

/** A card's accessible name, with "Hidden from Discover" after it when the member hid it. */
function hiddenCardName(card: Card, kind = false): string {
  const name = cardName(card, kind);
  return card.hidden ? `${name}, ${HIDE_TEXT.state}` : name;
}

/** "Hidden" under a card the member hid, in words (never colour alone); its card's name already says it. */
function HiddenMark() {
  return (
    <View testID="hidden-mark" style={styles.hiddenMark} {...hidden}>
      <Text style={styles.hiddenMarkText}>{HIDE_TEXT.badge}</Text>
    </View>
  );
}

/** A poster card: poster with its status chip at the top-left, then the title and "year · Movie/Series". */
export function PosterCard({ card, width, onOpen }: { card: Card; width: number; onOpen: (card: Card) => void }) {
  const onFocus = useContext(CardFocus);
  const badge = useBadgePlacement(width);
  const hide = useCardHideProps(card);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={hiddenCardName(card, true)}
      onPress={() => onOpen(card)}
      {...hide}
      onFocus={onFocus}
      style={({ pressed }) => [styles.card, { width }, pressed && styles.pressed]}
    >
      <View style={[styles.poster, !safeImageUrl(card.posterUrl) && styles.frameEmpty]}>
        <TmdbImage uri={card.posterUrl} style={styles.fillImage} />
      </View>
      <StatusChip state={card.state} overlay={badge === 'overlay'} below={badge === 'below'} />
      <Text style={styles.cardTitle}>{card.title}</Text>
      <Text style={styles.cardMeta}>{posterMeta(card)}</Text>
      {card.hidden ? <HiddenMark /> : null}
    </Pressable>
  );
}

/**
 * A large landscape card: the backdrop (the poster when there is none, a plain frame when neither) as a rounded 16:9
 * image with the status chip at its top-left, and the title and "year · ★ rating TMDB" below it, on the page's own
 * navy: no text is ever drawn over a picture.
 */
export function BackdropCard({ card, width, onOpen }: { card: Card; width: number; onOpen: (card: Card) => void }) {
  const onFocus = useContext(CardFocus);
  const badge = useBadgePlacement(width);
  const backdrop = backdropUri(card.backdropUrl, width);
  const meta = backdropMeta(card);
  const hide = useCardHideProps(card);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={hiddenCardName(card)}
      onPress={() => onOpen(card)}
      {...hide}
      onFocus={onFocus}
      style={({ pressed }) => [styles.card, styles.backdropCard, { width }, pressed && styles.pressed]}
    >
      <View style={styles.backdropFrame}>
        <TmdbImage uri={backdrop ?? card.posterUrl} style={styles.fillImage} />
      </View>
      <StatusChip state={card.state} overlay={badge === 'overlay'} below={badge === 'below'} />
      <View style={styles.backdropText}>
        <Text style={styles.backdropTitle}>{card.title}</Text>
        {meta ? <Text style={styles.backdropMeta}>{meta}</Text> : null}
        {card.hidden ? <HiddenMark /> : null}
      </View>
    </Pressable>
  );
}

/** The short line under a row heading: cyan with a purple cap (two segments, never a gradient), or a service's colour. */
export function Waterline({ accent }: { accent?: keyof typeof water | undefined }) {
  return (
    <View testID={`waterline-${accent ?? 'default'}`} style={styles.waterline} {...hidden}>
      {accent ? (
        <View style={[styles.waterlineService, { backgroundColor: water[accent] }]} />
      ) : (
        <>
          <View style={styles.waterlineAccent} />
          <View style={styles.waterlineCap} />
        </>
      )}
    </View>
  );
}

/** A row heading: heavy, with its waterline under it. */
export function RowHeading({ title, accent, children }: { title: string; accent?: keyof typeof water | undefined; children?: ReactNode }) {
  return (
    <View style={styles.rowHeading}>
      {children ?? (
        <Text accessibilityRole="header" style={styles.rowHeadingText}>
          {title}
        </Text>
      )}
      <Waterline accent={accent} />
    </View>
  );
}

/** A network's or studio's logo on its light tile, or its name as text when the API sent no usable logo. */
export function LogoTile({ source, size }: { source: Source; size: 'small' | 'large' }) {
  const [broken, setBroken] = useState(false);
  const uri = safeLogoUrl(source.logoUrl);
  return (
    <View style={[styles.logoTile, size === 'large' ? styles.logoTileLarge : styles.logoTileSmall]} {...hidden}>
      {uri && !broken ? (
        <Image
          testID="tmdb-logo-image"
          source={{ uri }}
          style={styles.logoImage}
          resizeMode="contain"
          onError={() => setBroken(true)}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Text style={styles.logoText}>{source.name}</Text>
      )}
    </View>
  );
}

/**
 * "Popular on" and the network's logo: one heading, named in words, so a screen reader's headings still land on it.
 * With `onOpen`, the PWA's chevron after the logo is a link of its own to the network's page ("See all Popular on
 * Netflix"); the heading itself is not pressable.
 */
export function NetworkHeading({ prefix, network, onOpen }: { prefix: string; network: Source; onOpen?: () => void }) {
  const heading = (
    <View accessible accessibilityRole="header" accessibilityLabel={`${prefix} ${network.name}`} style={styles.networkHeading}>
      <Text style={styles.rowHeadingText}>{prefix}</Text>
      <LogoTile source={network} size="small" />
    </View>
  );
  if (!onOpen) return heading;
  return (
    <View style={styles.networkHeading}>
      {heading}
      <Pressable
        testID="row-heading-link"
        accessibilityRole="link"
        accessibilityLabel={networkLinkName(prefix, network.name)}
        onPress={onOpen}
        style={({ pressed }) => [styles.headingLink, pressed && styles.pressed]}
      >
        <Icon name="next" color={colors.text} size={20} />
      </Pressable>
    </View>
  );
}

/**
 * A list row's heading with the same chevron after it as a service row's, a link of its own to the row's full grid ("See
 * all Trending"); the heading itself is not pressable, so a screen reader's headings still land on it alone.
 */
export function ListHeading({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <View style={styles.networkHeading}>
      <Text accessibilityRole="header" style={styles.rowHeadingText}>
        {title}
      </Text>
      <Pressable
        testID="row-heading-link"
        accessibilityRole="link"
        accessibilityLabel={listLinkName(title)}
        onPress={onOpen}
        style={({ pressed }) => [styles.headingLink, pressed && styles.pressed]}
      >
        <Icon name="next" color={colors.text} size={20} />
      </Pressable>
    </View>
  );
}

/** A row of title cards that scrolls sideways, `viewport` wide, coming to rest with a card centred. */
export function CardRow({
  cards,
  variant,
  cardWidth,
  viewport,
  onOpen,
}: {
  cards: readonly Card[];
  variant: RowVariant;
  cardWidth: number;
  viewport: number;
  onOpen: (card: Card) => void;
}) {
  if (cards.length === 0) return <Text style={styles.muted}>{EMPTY_ROW_TEXT}</Text>;
  return (
    <SnapRow testID="card-row" count={cards.length} item={cardWidth} viewport={viewport}>
      {cards.map((card) =>
        variant === 'backdrop' ? (
          <BackdropCard key={`${card.mediaType}-${card.tmdbId}`} card={card} width={cardWidth} onOpen={onOpen} />
        ) : (
          <PosterCard key={`${card.mediaType}-${card.tmdbId}`} card={card} width={cardWidth} onOpen={onOpen} />
        ),
      )}
    </SnapRow>
  );
}

/** A row while it loads (or waits to come near the screen): its shape, so nothing shifts, hidden from screen readers. */
export function SkeletonRow({ variant, cardWidth }: { variant: RowVariant; cardWidth: number }) {
  const count = variant === 'backdrop' ? 3 : 6;
  return (
    <View testID="skeleton-row" style={styles.row} {...hidden}>
      <View style={styles.skeletonHeading} />
      <View style={[styles.rowList, styles.skeletonList]}>
        {Array.from({ length: count }, (_, index) => (
          <View key={index} style={[variant === 'backdrop' ? styles.backdropFrame : styles.poster, styles.skeleton, { width: cardWidth }]} />
        ))}
      </View>
    </View>
  );
}

/** How tall SkeletonRow stands. Home keeps each row's slot at least this tall, whatever the row turns out to hold. */
export function skeletonRowHeight(variant: RowVariant, cardWidth: number): number {
  const frame = variant === 'backdrop' ? cardWidth / (16 / 9) : cardWidth / (2 / 3);
  return Math.ceil(SKELETON_HEADING_HEIGHT + spacing.md + frame + spacing.xxs);
}

/** The fixed message for a kind of failure, and Try again for the one call that failed. Nothing in it comes from an answer. */
export function ErrorNotice({ error, onRetry, secondary = true }: { error: ErrorText; onRetry: () => void; secondary?: boolean }) {
  const text = ERROR_TEXT[error];
  return (
    <View accessibilityRole="alert" style={styles.notice}>
      <Text style={styles.noticeTitle}>{text.title}</Text>
      <Text style={styles.noticeBody}>{text.body}</Text>
      <Button label={RETRY_TEXT} onPress={onRetry} secondary={secondary} />
    </View>
  );
}

/** A row that failed: its heading, the fixed message for the kind of failure, and Try again for this row alone. */
export function RowFailure({ heading, error, onRetry }: { heading: string; error: ErrorText; onRetry: () => void }) {
  return (
    <View style={styles.row}>
      <RowHeading title={heading} />
      <ErrorNotice error={error} onRetry={onRetry} />
    </View>
  );
}

/**
 * The studios: a strip of their logos, snapping like a row, each named "<studio> movies" (with `onOpen`, a link to the
 * studio's page named "<studio>, studio"). No title is fetched for it.
 */
export function StudioStrip({ studios, viewport, onOpen }: { studios: readonly Source[]; viewport: number; onOpen?: (studio: Source) => void }) {
  return (
    <View style={styles.row}>
      <RowHeading title={SOURCE_TEXT.studios} />
      <SnapRow testID="studio-strip" count={studios.length} item={STUDIO_TILE_WIDTH} viewport={viewport}>
        {studios.map((studio) => (
          <StudioTile key={studio.id} studio={studio} onOpen={onOpen} />
        ))}
      </SnapRow>
    </View>
  );
}

/** A studio's logo in the strip: a link to its page, or with nowhere to go, an image named "<studio> movies". */
function StudioTile({ studio, onOpen }: { studio: Source; onOpen: ((studio: Source) => void) | undefined }) {
  // The strip's SnapRow keeps a tile reached by the keyboard mid-snap in view, as it does a card.
  const onFocus = useContext(CardFocus);
  if (!onOpen) {
    return (
      <View accessible accessibilityRole="image" accessibilityLabel={studioName(studio.name)}>
        <LogoTile source={studio} size="large" />
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={studioLinkName(studio.name)}
      onPress={() => onOpen(studio)}
      onFocus={onFocus}
      style={({ pressed }) => [styles.studioLink, pressed && styles.pressed]}
    >
      <LogoTile source={studio} size="large" />
    </Pressable>
  );
}

export function JustWatchNote() {
  return <Text style={styles.note}>{SOURCE_TEXT.justWatch}</Text>;
}

/**
 * Home's All | Movies | TV: a radio group of outlined chips, the chosen one filled with the cyan tint, outlined in
 * cyan and ticked, so it is never told by colour alone. At large text the chips scroll sideways rather than wrap.
 */
export function FilterChips({
  selected,
  onChoose,
  hide,
  inset = { left: 0, right: 0 },
}: {
  selected: HomeFilter;
  onChoose: (filter: HomeFilter) => void;
  /** "New only", a chip of its own after the radio group. */
  hide: { value: boolean; onToggle: () => void };
  /** The screen's side padding, kept inside the scroller so the last chip scrolls fully clear of the edge. */
  inset?: { left: number; right: number };
}) {
  return (
    <ScrollView
      testID="home-filters"
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.filterList, { paddingLeft: inset.left, paddingRight: inset.right }]}
    >
      <View testID="home-filter-group" accessibilityRole="radiogroup" accessibilityLabel={HOME_TEXT.label} style={styles.filterGroup}>
        {HOME_FILTERS.map((filter) => {
          const checked = filter === selected;
          return (
            <Pressable
              key={filter}
              testID={`home-filter-${filter}`}
              accessibilityRole="radio"
              accessibilityLabel={HOME_TEXT.filters[filter]}
              accessibilityState={{ checked, selected: checked }}
              onPress={() => onChoose(filter)}
              style={({ pressed }) => [styles.filter, checked && styles.filterChecked, pressed && styles.pressed]}
            >
              {checked ? <Icon name="check" color={colors.accentText} size={17.6} strokeWidth={2.6} /> : null}
              <Text style={[styles.filterText, checked && styles.filterTextChecked]}>{HOME_TEXT.filters[filter]}</Text>
            </Pressable>
          );
        })}
      </View>
      <HideChip value={hide.value} onToggle={hide.onToggle} />
    </ScrollView>
  );
}

/**
 * "Hide what I have": a chip that switches on and off. On is the cyan tint with a cyan outline and a tick, off the
 * plain outline, so never colour alone; a checkbox to a screen reader, a thumb's size.
 */
export function HideChip({ value, onToggle, testID = 'home-hide' }: { value: boolean; onToggle: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={HOME_TEXT.hide.name}
      accessibilityState={{ checked: value }}
      onPress={onToggle}
      style={({ pressed }) => [styles.filter, value && styles.filterChecked, pressed && styles.pressed]}
    >
      {value ? <Icon name="check" color={colors.accentText} size={17.6} strokeWidth={2.6} /> : null}
      <Text style={[styles.filterText, value && styles.filterTextChecked]}>{HOME_TEXT.hide.label}</Text>
    </Pressable>
  );
}

/** The hero while its row loads: a card of the same shape. */
export function SkeletonHero({ tablet }: { tablet: boolean }) {
  return <View testID="skeleton-hero" style={[styles.heroImage, tablet && styles.heroImageWide, styles.skeleton, styles.heroSkeleton]} {...hidden} />;
}

/**
 * Home's hero: the first few titles of the filter's first row (from the answer Home already has), one rounded card a
 * slide: the backdrop, then a solid navy panel under it with the title, year, rating, status and the start of the
 * overview. It never moves by itself: a swipe, Previous and Next (wrapping round) or a dot moves it, without animation
 * when the member asks for reduced motion, and the screen reader hears which title is showing.
 */
export function Hero({
  cards,
  filter,
  width,
  tablet,
  onOpen,
}: {
  cards: readonly Card[];
  filter: HomeFilter;
  width: number;
  tablet: boolean;
  onOpen: (card: Card) => void;
}) {
  // The slide showing is kept by its title and its place: when the slides change (New only, a refresh, the
  // overlay) the same title stays selected if it is still there, else the place is clamped, and the scroll follows.
  const keyOf = (card: Card) => `${card.mediaType}-${card.tmdbId}`;
  const [shown, setShown] = useState<{ key: string | undefined; at: number }>({ key: undefined, at: 0 });
  const found = shown.key === undefined ? -1 : cards.findIndex((card) => keyOf(card) === shown.key);
  const index = found >= 0 ? found : Math.min(shown.at, Math.max(0, cards.length - 1));
  const reduceMotion = useReduceMotion();
  const track = useRef<ScrollViewInstance>(null);
  // Where the track was last put (or swiped) to: the slide, and the slide width that offset was measured in.
  const scrolledTo = useRef({ at: 0, width: 0 });
  const shownKey = cards[index] ? keyOf(cards[index]) : undefined;
  // What was clamped to is what is selected from now on (adjusted while rendering, before anything is drawn).
  if (shownKey !== undefined && (shown.key !== shownKey || shown.at !== index)) setShown({ key: shownKey, at: index });
  useEffect(() => {
    // A new width (a rotation) moves every slide's offset, so the track is put back on the selected slide then too.
    if (width > 0 && (scrolledTo.current.at !== index || scrolledTo.current.width !== width)) {
      scrolledTo.current = { at: index, width };
      track.current?.scrollTo({ x: index * width, animated: false });
    }
  }, [index, width, shownKey]);

  if (cards.length === 0) return null;
  const total = cards.length;
  const show = (next: number) => {
    scrolledTo.current = { at: next, width };
    if (next === index) return;
    setShown({ key: keyOf(cards[next]!), at: next });
    AccessibilityInfo.announceForAccessibility?.(`Showing ${next + 1} of ${total}: ${cards[next]!.title}`);
  };
  const goTo = (next: number) => {
    track.current?.scrollTo({ x: next * width, animated: !reduceMotion });
    show(next);
  };
  // Previous, a dot a title and Next each take a thumb's width. Where they do not fit on one line (five titles on a
  // 320 pt phone) the dots take a line of their own, over Previous and Next.
  const fits = width >= (total + 2) * layout.touchTarget + 2 * spacing.sm;
  const previous = <HeroButton icon="prev" label={HERO_TEXT.previous} onPress={() => goTo((index - 1 + total) % total)} />;
  const next = <HeroButton icon="next" label={HERO_TEXT.next} onPress={() => goTo((index + 1) % total)} />;
  const dots = <HeroDots cards={cards} index={index} onChoose={goTo} />;
  const onSwipe = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width > 0) show(Math.min(total - 1, Math.max(0, Math.round(event.nativeEvent.contentOffset.x / width))));
  };

  return (
    <View testID="hero" accessibilityLabel={HERO_TEXT.labels[filter]} style={styles.hero}>
      <ScrollView
        ref={track}
        testID="hero-track"
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onSwipe}
      >
        {cards.map((card, at) => (
          <HeroSlide key={`${card.mediaType}-${card.tmdbId}`} card={card} width={width} tablet={tablet} first={at === 0} onOpen={onOpen} />
        ))}
      </ScrollView>
      {total > 1 && fits ? (
        <View testID="hero-controls" style={styles.heroControls}>
          {previous}
          {dots}
          {next}
        </View>
      ) : null}
      {total > 1 && !fits ? (
        <View style={styles.heroControlsStacked}>
          {dots}
          <View testID="hero-controls" style={styles.heroControls}>
            {previous}
            {next}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** A dot a title, the current one filled: each a thumb's size, wrapping to another line before it would overflow. */
function HeroDots({ cards, index, onChoose }: { cards: readonly Card[]; index: number; onChoose: (at: number) => void }) {
  return (
    <View testID="hero-dots" style={styles.heroDots}>
      {cards.map((card, at) => (
        <Pressable
          key={`${card.mediaType}-${card.tmdbId}`}
          accessibilityRole="button"
          accessibilityLabel={`Show title ${at + 1} of ${cards.length}: ${card.title}`}
          accessibilityState={{ selected: at === index }}
          onPress={() => onChoose(at)}
          style={styles.heroDotTarget}
        >
          <View testID={at === index ? 'hero-dot-current' : 'hero-dot'} style={[styles.heroDot, at === index && styles.heroDotCurrent]} />
        </Pressable>
      ))}
    </View>
  );
}

function HeroButton({ icon, label, onPress }: { icon: 'prev' | 'next'; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.heroNav, pressed && styles.pressedButton]}
    >
      <Icon name={icon} color={colors.text} />
    </Pressable>
  );
}

function HeroSlide({ card, width, tablet, first, onOpen }: { card: Card; width: number; tablet: boolean; first: boolean; onOpen: (card: Card) => void }) {
  const overview = shortOverview(card.overview);
  const hide = useCardHideProps(card);
  return (
    <View testID={first ? 'hero-slide-first' : 'hero-slide'} style={{ width }}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={hiddenCardName(card)}
        onPress={() => onOpen(card)}
        {...hide}
        style={({ pressed }) => [styles.heroCard, pressed && styles.pressed]}
      >
        <View style={[styles.heroImage, tablet && styles.heroImageWide]}>
          <TmdbImage uri={backdropUri(card.backdropUrl, width)} style={styles.fillImage} />
        </View>
        <View style={styles.heroPanel}>
          <Text style={styles.heroTitle}>{card.title}</Text>
          <View style={styles.heroFacts}>
            {card.year ? <Text style={styles.heroFact}>{card.year}</Text> : null}
            {typeof card.rating === 'number' ? (
              <Text style={styles.heroFact} accessibilityLabel={ratingLabel(card.rating)}>
                {ratingText(card.rating)}
              </Text>
            ) : null}
            <StatusChip state={card.state} />
          </View>
          {overview ? <Text style={styles.heroOverview}>{overview}</Text> : null}
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.75 },
  hiddenMark: { alignSelf: 'flex-start', paddingHorizontal: spacing.xs, paddingVertical: 1, borderRadius: radii.chip, borderWidth: 1, borderColor: colors.muted },
  hiddenMarkText: { ...typography.chip, color: colors.text },
  pressedButton: { backgroundColor: colors.surfaceRaised },
  muted: { ...typography.body, color: colors.muted },
  fillImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radii.poster },

  // The stylesheet's .badge: a solid chip with a dot, 0.64rem on a poster, 0.75rem elsewhere.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingVertical: 2.4,
    paddingLeft: 8,
    paddingRight: 9.6,
    borderRadius: radii.chip,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  chipOverlay: {
    position: 'absolute',
    top: POSTER_BADGE.inset,
    left: POSTER_BADGE.inset,
    maxWidth: `${POSTER_BADGE.maxWidthRatio * 100}%`,
    paddingVertical: 1.6,
    paddingLeft: POSTER_BADGE.paddingLeft,
    paddingRight: POSTER_BADGE.paddingRight,
    gap: POSTER_BADGE.gap,
  },
  // Below the image the chip is in the card's flow and the card's width is all it may use; its text wraps at large sizes.
  chipBelow: { maxWidth: '100%' },
  chipOverlayText: { fontSize: POSTER_BADGE.fontSize },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipOverlayDot: { width: POSTER_BADGE.dot, height: POSTER_BADGE.dot, borderRadius: POSTER_BADGE.dot / 2 },
  chipText: { ...typography.chip, flexShrink: 1 },

  // Far taller than a thumb in practice; the floor holds for a card with no image yet.
  card: { gap: 5, minHeight: layout.touchTarget },
  poster: { width: '100%', aspectRatio: 2 / 3, borderRadius: radii.poster, backgroundColor: colors.surface },
  frameEmpty: { borderWidth: 1, borderColor: colors.hairline },
  cardTitle: { ...typography.cardTitle, color: colors.text },
  cardMeta: { ...typography.meta, color: colors.muted },

  backdropCard: { gap: spacing.sm },
  backdropFrame: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: radii.backdrop,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surfaceRaised,
  },
  backdropText: { gap: 2, paddingHorizontal: spacing.xxs },
  backdropTitle: { fontSize: 18.4, lineHeight: 23, fontWeight: '800', color: colors.text },
  backdropMeta: { fontSize: 13.6, lineHeight: 18, color: colors.muted },

  row: { gap: spacing.md },
  rowList: { gap: CARD_GAP, paddingBottom: spacing.xxs },
  rowHeading: { gap: spacing.sm, alignSelf: 'flex-start' },
  rowHeadingText: { ...typography.rowHeading, color: colors.text },
  networkHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  headingLink: { minHeight: layout.touchTarget, minWidth: layout.touchTarget, alignItems: 'center', justifyContent: 'center' },
  studioLink: { width: STUDIO_TILE_WIDTH, minHeight: layout.touchTarget, borderRadius: radii.card },
  waterline: { flexDirection: 'row', height: layout.waterline.height },
  waterlineAccent: { width: layout.waterline.accentWidth, borderRadius: layout.waterline.height, backgroundColor: colors.accent },
  waterlineCap: {
    width: layout.waterline.capWidth,
    marginLeft: layout.waterline.capOffset - layout.waterline.accentWidth,
    borderRadius: layout.waterline.height,
    backgroundColor: colors.purple,
  },
  waterlineService: { width: 44, borderRadius: layout.waterline.height },

  logoTile: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.logoTile },
  logoTileSmall: { width: 104, minHeight: 36, paddingVertical: 4.8, paddingHorizontal: 8.8, borderRadius: radii.chip },
  logoTileLarge: { width: STUDIO_TILE_WIDTH, minHeight: 72, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radii.card },
  logoImage: { width: '100%', aspectRatio: 3 },
  logoText: { fontSize: 12.8, lineHeight: 15, fontWeight: '700', textAlign: 'center', color: colors.logoText },

  skeleton: { backgroundColor: colors.surface, borderWidth: 0 },
  skeletonHeading: { width: 160, height: SKELETON_HEADING_HEIGHT, borderRadius: radii.chip, backgroundColor: colors.surface },
  skeletonList: { flexDirection: 'row', overflow: 'hidden' },

  notice: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  noticeTitle: { ...typography.label, color: colors.text },
  noticeBody: { ...typography.body, color: colors.muted },
  note: { fontSize: 12.8, lineHeight: 18, color: colors.muted },

  filterList: { flexDirection: 'row', gap: spacing.sm, paddingVertical: 4 },
  filter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6.4,
    minHeight: layout.touchTarget,
    minWidth: 56,
    paddingHorizontal: 14,
    flexShrink: 0,
    borderWidth: 1.5,
    borderColor: colors.hairline,
    borderRadius: radii.chip,
  },
  filterGroup: { flexDirection: 'row', gap: spacing.sm },
  filterChecked: { backgroundColor: colors.accentTint, borderColor: colors.accent },
  filterText: { fontSize: 15.2, lineHeight: 20, fontWeight: '700', color: colors.muted },
  filterTextChecked: { color: colors.accentText },

  hero: { gap: spacing.md },
  heroCard: { minHeight: layout.touchTarget, borderRadius: radii.sheet, borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.surface },
  heroImage: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    backgroundColor: colors.surfaceRaised,
  },
  heroImageWide: { aspectRatio: 21 / 9 },
  heroSkeleton: { borderRadius: radii.sheet },
  heroPanel: { gap: spacing.sm, padding: spacing.lg, borderBottomLeftRadius: radii.sheet, borderBottomRightRadius: radii.sheet, backgroundColor: colors.surface },
  heroTitle: { fontSize: 24, lineHeight: 29, fontWeight: '800', letterSpacing: -0.48, color: colors.text },
  heroFacts: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md },
  heroFact: { ...typography.label, color: colors.text },
  heroOverview: { ...typography.body, color: colors.muted },
  heroControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  heroNav: {
    width: layout.touchTarget,
    minHeight: layout.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: layout.touchTarget / 2,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  heroControlsStacked: { alignItems: 'center', gap: spacing.xxs },
  heroDots: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center' },
  heroDotTarget: { minWidth: layout.touchTarget, minHeight: layout.touchTarget, alignItems: 'center', justifyContent: 'center' },
  heroDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: colors.muted },
  heroDotCurrent: { width: 14, height: 14, borderRadius: 7, borderColor: colors.accent, backgroundColor: colors.accent },
});
