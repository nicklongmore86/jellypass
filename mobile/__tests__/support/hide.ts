// "Not interested"'s tests: a household that hides titles as the server does (apiVersion 3 by default), on top of the
// See all, network and studio, title and Search households. Each sign-in's hidden titles are its own (by the token it
// carries): the discovery lists leave them out, Search and the title pages say `hidden`, and GET /hidden lists them
// newest first, 50 a page. Small queries never print the component tree.
import { fireEvent, screen } from '@testing-library/react-native';

import type { ResponseLike } from '../../src/api/client';
import { API, pageAnswer } from './home';
import { answer, fixture, settle, type Call } from './household';
import { listPage, pageOf } from './list';
import { searchAnswer, searchOf } from './search';
import { sourceAnswer, sourceOf } from './source';
import { movieAnswer, seriesAnswer, titleGateway, type TitleHousehold } from './title';

const HIDE = new RegExp(`^(POST|DELETE) ${API}/hidden/(movie|tv)/(\\d+)$`);
const LIST = new RegExp(`^GET ${API}/discover/([a-z-]+)$`);
const MOVIE = new RegExp(`^GET ${API}/movie/(\\d+)$`);
const SERIES = new RegExp(`^GET ${API}/tv/(\\d+)$`);

type Page = { page: number; nextPage: number | null; results: { mediaType: string; tmdbId: number; hidden?: boolean }[] };

export interface HideHousehold extends TitleHousehold {
  /** `/me`'s apiVersion: 3 (hiding) unless a test says otherwise. */
  apiVersion?: number;
  /** Hidden before the app starts, for every sign-in: `movie:7`, newest first. */
  hidden?: string[];
  /** Answers a hide or unhide first, when it returns something (a failure, an answer held back). */
  setHidden?: (call: Call, hidden: boolean) => ResponseLike | Promise<ResponseLike> | undefined;
  /** Answers GET /hidden first, when it returns something. */
  list?: (page: number, call: Call) => ResponseLike | Promise<ResponseLike> | undefined;
}

/** The sign-in a call carried (its token). */
export const tokenOf = (call: Call) => /Token="([^"]+)"/.exec(call.init.headers.Authorization ?? '')?.[1] ?? '';

export function hideGateway(household: HideHousehold = {}) {
  /** Each sign-in's hidden titles, newest first, by its token and household. */
  const hidden = new Map<string, string[]>();
  const whose = (call: Call) => `${call.url.replace(/^(https:\/\/[^/]+).*$/, '$1')} ${tokenOf(call)}`;
  const own = (call: Call): string[] => {
    const key = whose(call);
    if (!hidden.has(key)) hidden.set(key, [...(household.hidden ?? [])]);
    return hidden.get(key)!;
  };
  const isHidden = (call: Call, card: { mediaType: string; tmdbId: number }) => own(call).includes(`${card.mediaType}:${card.tmdbId}`);
  /** A discovery page as the server sends it: the caller's hidden titles left out. */
  const discovery = (call: Call, page: Page) => answer(200, { ...page, results: page.results.filter((card) => !isHidden(call, card)) });
  /** A search page or title as the server sends it: the caller's hidden titles say so. */
  const flagged = <T extends { mediaType: string; tmdbId: number }>(call: Call, card: T) => ({ ...card, hidden: isHidden(call, card) });

  const gateway = titleGateway({
    ...household,
    override: (call) => {
      const first = household.override?.(call);
      if (first) return first;
      if (call.route === `GET ${API}/me`) return answer(200, { ...fixture('me'), apiVersion: household.apiVersion ?? 3 });
      const hide = HIDE.exec(call.route);
      if (hide) {
        const on = hide[1] === 'POST';
        const answered = household.setHidden?.(call, on);
        if (answered) return answered;
        const key = `${hide[2]}:${hide[3]}`;
        const list = own(call);
        const at = list.indexOf(key);
        if (at >= 0) list.splice(at, 1);
        if (on) list.unshift(key);
        return answer(200, { hidden: on });
      }
      if (call.route === `GET ${API}/hidden`) {
        const page = pageOf(call);
        const answered = household.list?.(page, call);
        if (answered) return answered;
        const list = own(call);
        const results = list.slice((page - 1) * 50, page * 50).map((key, index) => {
          const [mediaType, id] = key.split(':');
          const at = new Date(Date.UTC(2026, 9, 30, 12, 0, 0) - ((page - 1) * 50 + index) * 3_600_000).toISOString();
          return { mediaType, tmdbId: Number(id), hiddenAt: at };
        });
        return answer(200, { page, nextPage: list.length > page * 50 ? page + 1 : null, results });
      }
      const search = searchOf(call);
      if (search) {
        const page = searchAnswer(search.q, search.page);
        return answer(200, { ...page, results: page.results.map((card) => flagged(call, card)) });
      }
      let match = MOVIE.exec(call.route);
      if (match) return answer(200, flagged(call, household.movies?.[Number(match[1])] ?? movieAnswer(Number(match[1]))));
      match = SERIES.exec(call.route);
      if (match) return answer(200, flagged(call, household.series?.[Number(match[1])] ?? seriesAnswer(Number(match[1]))));
      const source = sourceOf(call);
      // Home's service rows are a network's first page.
      if (source) return discovery(call, source.page === 1 && source.list.startsWith('network-') ? pageAnswer(source.list) : sourceAnswer(source.list, source.page));
      const list = LIST.exec(call.route);
      if (list && list[1] !== 'sources') return discovery(call, listPage(list[1]!, pageOf(call)));
      return undefined;
    },
  });
  return { ...gateway, hidden };
}

type Node = NonNullable<ReturnType<typeof screen.queryAllByRole>[number]>;

/** Every link whose name starts with `title` and a comma (a card, a hero slide, an entry). */
export function cardsNamed(title: string): Node[] {
  return screen.queryAllByRole('link').filter((node) => String(node.props.accessibilityLabel).startsWith(`${title}, `));
}

/** A card's long press, as the member's finger held on it. */
export async function longPress(node: Node) {
  await fireEvent(node, 'longPress');
  await settle();
}

/** A screen reader's custom action on a card. */
export async function action(node: Node, name: string) {
  await fireEvent(node, 'accessibilityAction', { nativeEvent: { actionName: name } });
  await settle();
}

/** The toast's words, or '' when none shows. */
export function toastText(): string {
  const toast = screen.queryAllByTestId('hide-toast')[0];
  if (!toast) return '';
  const alert = screen.queryAllByRole('alert').find((node) => {
    for (let at = node.parent; at; at = at.parent) if (at === toast) return true;
    return false;
  });
  return alert ? [alert.props.children].flat().join('') : '';
}

/** The hide or unhide calls made, as `POST movie:7`. */
export function hides(calls: readonly Call[]): string[] {
  return calls.flatMap((call) => {
    const match = HIDE.exec(call.route);
    return match ? [`${match[1]} ${match[2]}:${match[3]}`] : [];
  });
}
