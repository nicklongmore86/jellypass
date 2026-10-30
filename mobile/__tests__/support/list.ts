// The See all pages' tests (list.test.tsx, list-states.test.tsx): a household whose discover lists answer by page
// number, page 1 being Home's own row (support/home's pageAnswer) and each later one with IDs of its own, on top of the
// network and studio pages' household.
import type { ResponseLike } from '../../src/api/client';
import { API, pageAnswer } from './home';
import { answer, type Call } from './household';
import { sourceGateway, type SourceHousehold } from './source';

const LIST = new RegExp(`^GET ${API}/discover/([a-z-]+)$`);

/** The page number a call asked for. */
export const pageOf = (call: Call) => Number(new URLSearchParams(call.url.includes('?') ? call.url.slice(call.url.indexOf('?') + 1) : '').get('page') ?? 1);

/** Page `page` of a discover list: page 1 is Home's own row, each later one IDs of its own, three in all. */
export function listPage(list: string, page: number) {
  const first = pageAnswer(list);
  return {
    page,
    nextPage: page < 3 ? page + 1 : null,
    results: first.results.map((card, index) => {
      const n = (page - 1) * 20 + index + 1;
      return { ...card, tmdbId: 1000 + n, title: `${list} ${n}` };
    }),
  };
}

export type ListAnswer = (name: string, page: number, call: Call) => ResponseLike | Promise<ResponseLike> | undefined;

/** `list` answers a discover list's page first, when it returns something; by default listPage(list, page). */
export function listGateway(list?: ListAnswer, household: SourceHousehold = {}) {
  return sourceGateway({
    ...household,
    override: (call) => {
      const own = household.override?.(call);
      if (own) return own;
      const match = LIST.exec(call.route);
      if (!match || match[1] === 'sources') return undefined;
      return list?.(match[1]!, pageOf(call), call) ?? answer(200, listPage(match[1]!, pageOf(call)));
    },
  });
}
