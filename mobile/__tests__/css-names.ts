import { colors, status, water } from '../src/theme';

// The theme's colours under the stylesheet's custom-property names, so the tests below read like the web ones.
export const cssTokens: Record<string, string> = {
  bg: colors.bg,
  surface: colors.surface,
  'surface-raised': colors.surfaceRaised,
  'accent-tint': colors.accentTint,
  hairline: colors.hairline,
  text: colors.text,
  muted: colors.muted,
  accent: colors.accent,
  'accent-text': colors.accentText,
  'on-accent': colors.onAccent,
  purple: colors.purple,
  'logo-tile': colors.logoTile,
  'logo-text': colors.logoText,
  panel: colors.panel,
  ...Object.fromEntries(Object.entries(water).map(([name, hex]) => [`water-${name}`, hex])),
  ...Object.fromEntries(
    Object.entries(status).flatMap(([name, pair]) => [
      [`pill-${name}-bg`, pair.bg],
      [`pill-${name}-text`, pair.text],
    ]),
  ),
};

export function token(name: string): string {
  const value = cssTokens[name];
  if (value === undefined) throw new Error(`--${name} is not a theme token`);
  return value;
}
