// WCAG 2 relative luminance and contrast ratio, as test/app-pwa.test.mjs computes them.

export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4]
    .map((index) => parseInt(match[1]!.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

// An rgba() colour laid over an opaque grey backdrop (0 black, 255 white), as #rrggbb.
export function composite(rgba: string, backdrop: number): string {
  const match = /^rgba\((\d+), (\d+), (\d+), ([0-9.]+)\)$/.exec(rgba);
  if (!match) throw new Error(`not an rgba() colour: ${rgba}`);
  const alpha = Number(match[4]);
  return `#${match
    .slice(1, 4)
    .map((value) => Math.round(Number(value) * alpha + backdrop * (1 - alpha)).toString(16).padStart(2, '0'))
    .join('')}`;
}
