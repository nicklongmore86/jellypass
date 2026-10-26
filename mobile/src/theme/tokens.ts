// Tidepool, in Jellyfin's colours: the household app's design tokens, ported from the PWA's app/static/app.css.
// A navy page, solid surfaces (no glass), a cyan main colour with a small purple decoration, big soft squircles.
// Every text/background pair is checked for WCAG AA contrast by __tests__/contrast.test.ts (the same pairs and
// thresholds as test/app-pwa.test.mjs), and __tests__/tokens-match-css.test.ts fails if a hex here drifts from
// the stylesheet. Sizes are in points: the stylesheet's 1rem is 16.

export const colors = {
  // Jellyfin's own navy and cyan. The page is Jellyfin navy; surfaces step lighter.
  bg: '#000b25',
  surface: '#0b1838',
  surfaceRaised: '#13224a',
  // The chosen filter chip's and active tab's fill: the cyan, tinted into the page.
  accentTint: '#06304d',
  hairline: 'rgba(150, 175, 225, 0.22)',
  text: '#eaf2ff',
  muted: '#a9bad8',
  // The main colour: Jellyfin cyan. Buttons, the chosen chip, the active tab's outline, links and focus rings.
  accent: '#00a4dc',
  accentText: '#35b8e8',
  onAccent: '#000b25',
  // Jellyfin purple is a small decorative accent only (the cap at the end of a heading's waterline): never a
  // button, chip, tab indicator or text, and never blended with the cyan.
  purple: '#aa5cc3',
  // Network and studio logos sit on a light tile, as TMDB draws them; a name shown in place of a logo is dark on it.
  logoTile: '#eaf2ff',
  logoText: '#000b25',
  // The text panel inside the hero card: navy, nearly opaque, so its text never depends on the picture.
  panel: 'rgba(0, 11, 37, 0.92)',
} as const;

// Row headings' waterlines: decorative only (the heading says what the row is). A service's brand colour as a
// tasteful approximation, never a logo, and never text.
export const water = {
  netflix: '#f0343c',
  disney: '#5b7cff',
  apple: '#8e99a8',
  prime: '#00a8e1',
  hbo: '#f5f5f5',
  hulu: '#1ce783',
  paramount: '#2f8bff',
  peacock: '#ff8a3d',
} as const;

// Status chips: solid pairs, each a word and a dot (the dot is the text colour) at 4.5:1.
export const status = {
  ok: { bg: '#0f3d2b', text: '#a7f3d0' },
  get: { bg: '#06395a', text: '#c4ecff' },
  warn: { bg: '#4a3a0a', text: '#fde68a' },
  bad: { bg: '#4d1c24', text: '#fecdd3' },
} as const;

export const radii = {
  chip: 12,
  poster: 20,
  card: 20,
  backdrop: 24,
  sheet: 30,
} as const;

export const spacing = {
  xxs: 4,
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  // The page's side margin before safe areas (the stylesheet's --gutter floor).
  gutter: 16,
} as const;

export const layout = {
  // Apple's and WCAG's minimum touch target; chips, tabs and the header buttons are at least this tall.
  touchTarget: 44,
  headerHeight: 60,
  tabbarHeight: 72,
  // Content stops widening here on iPad and wide windows (the stylesheet's 72rem).
  maxContentWidth: 1152,
  // The waterline under a row heading: a cyan line, a gap, then a short purple cap (two segments, never a gradient).
  waterline: { height: 4, accentWidth: 34, capOffset: 38, capWidth: 10 },
} as const;

// Heavy titles: the stylesheet's 800-weight headings, with tracking in points.
export const typography = {
  screenTitle: { fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.56 },
  detailTitle: { fontSize: 32, lineHeight: 35, fontWeight: '800', letterSpacing: -0.64 },
  rowHeading: { fontSize: 21, lineHeight: 26, fontWeight: '800', letterSpacing: -0.21 },
  headerTitle: { fontSize: 19, lineHeight: 25, fontWeight: '800', letterSpacing: -0.19 },
  button: { fontSize: 17, lineHeight: 22, fontWeight: '800' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  cardTitle: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  meta: { fontSize: 12.5, lineHeight: 16, fontWeight: '400' },
  chip: { fontSize: 12, lineHeight: 16, fontWeight: '700' },
} as const;

export const theme = { colors, water, status, radii, spacing, layout, typography } as const;
export type Theme = typeof theme;
