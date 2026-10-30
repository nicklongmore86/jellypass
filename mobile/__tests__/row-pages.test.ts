// The page a Home row hands its See all page (src/home/rowPages.ts): taken once, the latest put winning, forgotten whole.
import { createRowPages } from '../src/home/rowPages';
import { pageAnswer } from './support/home';

const page = (list: string) => pageAnswer(list) as never;

it('hands each list its latest page once, and nothing after', () => {
  const pages = createRowPages();
  const first = page('trending');
  const second = page('trending');
  pages.put('trending', first);
  pages.put('trending', second);
  pages.put('popular-tv', page('popular-tv'));
  expect(pages.take('trending')).toBe(second);
  expect(pages.take('trending')).toBeUndefined();
  expect(pages.take('upcoming')).toBeUndefined();
  pages.forget();
  expect(pages.take('popular-tv')).toBeUndefined();
});
