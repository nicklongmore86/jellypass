/**
 * The app's own small line icons, drawn here and built node by node with `createElementNS`: no markup is parsed, no
 * image file is fetched and no CSS `url()` is needed. They take their colour from the text (`currentColor`) and are
 * hidden from assistive technology: the label next to an icon, or the button's own `aria-label`, is its name.
 */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

type Shape = readonly [tag: 'path' | 'circle' | 'rect' | 'line', attrs: Readonly<Record<string, string>>];

const SHAPES = {
  home: [
    ['path', { d: 'M4 11.2 12 4l8 7.2' }],
    ['path', { d: 'M6 9.8V19a1 1 0 0 0 1 1h3.4v-5.4h3.2V20H17a1 1 0 0 0 1-1V9.8' }],
  ],
  search: [
    ['circle', { cx: '11', cy: '11', r: '6.5' }],
    ['line', { x1: '16', y1: '16', x2: '20.5', y2: '20.5' }],
  ],
  requests: [
    ['rect', { x: '4', y: '5', width: '16', height: '14', rx: '3.5' }],
    ['line', { x1: '8.2', y1: '10', x2: '15.8', y2: '10' }],
    ['line', { x1: '8.2', y1: '14', x2: '13', y2: '14' }],
  ],
  account: [
    ['circle', { cx: '8', cy: '15.5', r: '3.6' }],
    ['line', { x1: '10.6', y1: '12.9', x2: '19.5', y2: '4' }],
    ['line', { x1: '15.8', y1: '7.7', x2: '18.4', y2: '10.3' }],
    ['line', { x1: '13.2', y1: '10.3', x2: '15.2', y2: '12.3' }],
  ],
  back: [['path', { d: 'M14.5 5.5 8 12l6.5 6.5' }]],
  check: [['path', { d: 'M5.5 12.5 10 17l8.5-9.5' }]],
  prev: [['path', { d: 'M14.5 5.5 8 12l6.5 6.5' }]],
  next: [['path', { d: 'M9.5 5.5 16 12l-6.5 6.5' }]],
  more: [
    ['circle', { cx: '6', cy: '12', r: '1.4' }],
    ['circle', { cx: '12', cy: '12', r: '1.4' }],
    ['circle', { cx: '18', cy: '12', r: '1.4' }],
  ],
} as const satisfies Record<string, readonly Shape[]>;

export type IconName = keyof typeof SHAPES;

export function icon(doc: Document, name: IconName): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of SHAPES[name]) {
    const shape = doc.createElementNS(SVG_NAMESPACE, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}
