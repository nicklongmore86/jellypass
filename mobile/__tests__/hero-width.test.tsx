// The hero's track stays on the selected slide when the hero's width changes (an iPad rotated): the offset is the
// slide's index times the new width, and the dots and the slide in view still agree.
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ScrollView } from 'react-native';

import type { Card } from '../src/api/types';
import { Hero } from '../src/home/components';
import { pageAnswer } from './support/home';

const cards = pageAnswer('trending', 5).results as Card[];
let scrolls: jest.SpyInstance;
beforeEach(() => {
  scrolls = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => undefined);
});
afterEach(() => scrolls.mockRestore());

const hero = (width: number) => <Hero cards={cards} filter="all" width={width} tablet={width > 700} onOpen={() => undefined} />;
const lastX = () => (scrolls.mock.calls[scrolls.mock.calls.length - 1]?.[0] as { x: number } | undefined)?.x;
const selected = () => screen.queryAllByLabelText(/^Show title \d+ of \d+: /).findIndex((node) => node.props.accessibilityState?.selected === true);

describe('the hero when its width changes', () => {
  it('puts the track back on the selected slide at the new width', async () => {
    const view = await render(hero(358));
    await fireEvent.press(screen.queryAllByLabelText(/^Show title 5 of 5: /)[0]!);
    expect([selected(), lastX()]).toEqual([4, 4 * 358]);
    await view.rerender(hero(992));
    expect([selected(), lastX()]).toEqual([4, 4 * 992]);
    await view.rerender(hero(358));
    expect([selected(), lastX()]).toEqual([4, 4 * 358]);
  });

  it('does not scroll again when the width and the slide have not changed', async () => {
    const view = await render(hero(358));
    await fireEvent.press(screen.queryAllByLabelText(/^Show title 3 of 5: /)[0]!);
    const before = scrolls.mock.calls.length;
    await view.rerender(hero(358));
    expect(scrolls.mock.calls.length).toBe(before);
  });
});
