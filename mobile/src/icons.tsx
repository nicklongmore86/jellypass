// The app's own small line icons, the PWA's (app/src/icons.ts) shape for shape: drawn with react-native-svg from the
// code, so no image file is loaded. They take the colour they are given and are hidden from screen readers: the label
// next to an icon, or its button's own label, is its name.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

type Shape =
  | readonly ['path', { d: string }]
  | readonly ['circle', { cx: string; cy: string; r: string }]
  | readonly ['rect', { x: string; y: string; width: string; height: string; rx: string }]
  | readonly ['line', { x1: string; y1: string; x2: string; y2: string }];

export const SHAPES = {
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
  // A key: the Account tab.
  account: [
    ['circle', { cx: '8', cy: '15.5', r: '3.6' }],
    ['line', { x1: '10.6', y1: '12.9', x2: '19.5', y2: '4' }],
    ['line', { x1: '15.8', y1: '7.7', x2: '18.4', y2: '10.3' }],
    ['line', { x1: '13.2', y1: '10.3', x2: '15.2', y2: '12.3' }],
  ],
  back: [['path', { d: 'M14.5 5.5 8 12l6.5 6.5' }]],
} as const satisfies Record<string, readonly Shape[]>;

export type IconName = keyof typeof SHAPES;

/** The stylesheet's `.icon`: 1.4rem, a 1.8 stroke with round ends; the active tab's is 2.4. */
export const ICON_SIZE = 22.4;
export const ICON_STROKE = 1.8;

export function Icon({ name, color, size = ICON_SIZE, strokeWidth = ICON_STROKE }: { name: IconName; color: string; size?: number; strokeWidth?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={`icon-${name}`}
    >
      {(SHAPES[name] as readonly Shape[]).map(([tag, attrs], index) => {
        switch (tag) {
          case 'path':
            return <Path key={index} {...attrs} />;
          case 'circle':
            return <Circle key={index} {...attrs} />;
          case 'rect':
            return <Rect key={index} {...attrs} />;
          case 'line':
            return <Line key={index} {...attrs} />;
        }
      })}
    </Svg>
  );
}
