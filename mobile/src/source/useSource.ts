// A network's or a studio's page data, as the PWA's sourceScreen() (app/src/main.ts) asks for it: the networks and
// studios the API lists (GET /discover/sources, no TMDB call), and only when the address names one of them, the first
// page of its list; then each further page only when the member presses Load more. That is
// docs/app-api/fetch-budget.json's network and studio screens (with the start-up /me). An ID the API does not list is
// Not found without asking for titles, and so is a network's Films for a network the API lists no films for.
//
// A network the API lists films for has three lists (All, Series, Films). Choosing another drops whatever the one
// before had out: each list drawn gets a number and its own abort, and an answer for an older one (a page asked for
// before the switch, or a Load more under it) is dropped, so a late answer never replaces a newer one. A failure stays
// until the member taps Try again, which asks again for that one call (nothing is retried by itself); a 401 signs the
// member out. Every page is seen by the session's overlay as it arrives (src/title/asked.ts).
//
// Everything is kept in memory only, for as long as the page is on its stack: no answer is ever written to the device.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import type { ApiClient } from '../api/client';
import { ApiError, isAbortError } from '../api/errors';
import type { Card, Network, Page, Source, Sources } from '../api/types';
import { errorText, SOURCE_LISTS, SOURCE_TEXT, type ErrorText, type SourceList } from '../home/text';
import { MORE_TEXT, SEARCH_TEXT } from '../search/text';
import type { MoreState } from '../search/useSearch';
import type { Asked } from '../title/asked';

export type SourceKind = 'network' | 'studio';

/** The list shown: its first page on its way, failed, or its pages so far. */
export type ListState =
  | { status: 'loading' }
  | { status: 'failed'; error: ErrorText }
  /** `cards` are the pages' own cards, in order, as the overlay saw them. */
  | { status: 'loaded'; cards: readonly Card[]; nextPage: number | null; more: MoreState };

export type SourceState =
  | { status: 'loading' }
  /** The networks and studios could not be read. */
  | { status: 'failed'; error: ErrorText }
  | { status: 'not_found' }
  | { status: 'ready'; source: Source; lists: readonly SourceList[]; list: SourceList; shown: ListState };

export interface SourceData {
  state: SourceState;
  /** Shows another of a network's lists. */
  select: (list: SourceList) => void;
  loadMore: () => void;
  /** Try again: the call that failed, alone. */
  retry: () => void;
}

const announce = (text: string) => {
  if (text) AccessibilityInfo.announceForAccessibility?.(text);
};

/** The source the address names, if the API lists it, and the lists it has (a studio: its movies alone). */
function lookUp(sources: Sources, kind: SourceKind, id: number): { source: Source; lists: readonly SourceList[] } | undefined {
  if (kind === 'studio') {
    const studio = sources.studios.find((candidate) => candidate.id === id);
    return studio && { source: studio, lists: ['all'] };
  }
  const network: Network | undefined = sources.networks.find((candidate) => candidate.id === id);
  return network && { source: network, lists: network.hasFilms ? SOURCE_LISTS : ['series'] };
}

/** One page of a list: a studio's movies, or a network's series, films or both mixed. */
function fetchList(api: ApiClient, kind: SourceKind, id: number, list: SourceList, page: number, signal: AbortSignal): Promise<Page> {
  if (kind === 'studio') return api.studio(id, page, { signal });
  return api.network(id, list === 'series' ? undefined : list, page, { signal });
}

export function useSource(api: ApiClient | undefined, expire: () => Promise<void>, overlay: Asked, kind: SourceKind, id: number, initial: SourceList): SourceData {
  const [state, setState] = useState<SourceState>({ status: 'loading' });
  /** Bumped by Try again after the sources failed, to read them again. */
  const [attempt, setAttempt] = useState(0);
  /** The list the member last chose (or the address named), kept for a Try again that reads the sources again. */
  const wanted = useRef<SourceList>(kind === 'studio' ? 'all' : initial);
  // Each list drawn gets a number and its own abort; an answer for an older one is dropped.
  const sequence = useRef(0);
  const pending = useRef<AbortController | undefined>(undefined);
  const live = useRef(true);
  /** A further page is on its way: a second Load more before it answers asks for nothing. */
  const paging = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      pending.current?.abort();
    };
  }, []);

  /** A failure's fixed wording, or undefined when there is nothing to show (an abort, a stale answer, or a 401). */
  const failure = useCallback(
    (error: unknown, mine: number): ErrorText | undefined => {
      if (!live.current || sequence.current !== mine || isAbortError(error)) return undefined;
      if (error instanceof ApiError && error.kind === 'unauthorized') {
        void expire();
        return undefined;
      }
      return errorText(error instanceof ApiError ? error.kind : 'unavailable');
    },
    [expire],
  );

  /** One page of `list`: the first replaces what is shown, a later one is added under it. */
  const fetchPage = useCallback(
    async (list: SourceList, page: number, mine: number, signal: AbortSignal, switched = false): Promise<void> => {
      if (!api) return;
      try {
        const answer = await fetchList(api, kind, id, list, page, signal);
        if (sequence.current === mine) paging.current = false;
        if (!live.current || sequence.current !== mine) return;
        overlay.seen(answer);
        setState((current) => {
          if (current.status !== 'ready' || current.list !== list) return current;
          if (page === 1) return { ...current, shown: { status: 'loaded', cards: answer.results, nextPage: answer.nextPage, more: { status: 'idle' } } };
          if (current.shown.status !== 'loaded') return current;
          return { ...current, shown: { ...current.shown, cards: [...current.shown.cards, ...answer.results], nextPage: answer.nextPage, more: { status: 'idle' } } };
        });
        announce(page > 1 ? SEARCH_TEXT.more : switched ? `${SOURCE_TEXT.lists[list]} shown.` : '');
      } catch (error) {
        if (sequence.current === mine) paging.current = false;
        const kindOfFailure = failure(error, mine);
        if (!kindOfFailure) return;
        setState((current) => {
          if (current.status !== 'ready' || current.list !== list) return current;
          if (page === 1) return { ...current, shown: { status: 'failed', error: kindOfFailure } };
          return current.shown.status === 'loaded' ? { ...current, shown: { ...current.shown, more: { status: 'failed', error: kindOfFailure } } } : current;
        });
      }
    },
    [api, kind, id, overlay, failure],
  );

  /** A new drawing of `list`: whatever the one before had out is aborted, and its answers dropped. */
  const draw = useCallback(
    (list: SourceList, switched = false) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      const mine = ++sequence.current;
      paging.current = false;
      void fetchPage(list, 1, mine, controller.signal, switched);
    },
    [fetchPage],
  );

  // The sources, then (only for a source the API lists) its list's first page.
  useEffect(() => {
    if (!api) return undefined;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const mine = ++sequence.current;
    api.sources({ signal: controller.signal }).then(
      (sources) => {
        if (!live.current || sequence.current !== mine) return;
        const found = lookUp(sources, kind, id);
        let list = wanted.current;
        // A network the API lists no films for has its series alone: no All, and its Films is Not found.
        if (found && !found.lists.includes(list)) list = list === 'films' ? list : 'series';
        if (!found || !found.lists.includes(list)) {
          setState({ status: 'not_found' });
          return;
        }
        wanted.current = list;
        setState({ status: 'ready', source: found.source, lists: found.lists, list, shown: { status: 'loading' } });
        void fetchPage(list, 1, mine, controller.signal);
      },
      (error: unknown) => {
        const kindOfFailure = failure(error, mine);
        if (kindOfFailure) setState({ status: 'failed', error: kindOfFailure });
      },
    );
    return () => controller.abort();
  }, [api, kind, id, attempt, fetchPage, failure]);

  const select = useCallback(
    (list: SourceList) => {
      if (state.status !== 'ready' || state.list === list || !state.lists.includes(list)) return;
      wanted.current = list;
      setState({ ...state, list, shown: { status: 'loading' } });
      announce(MORE_TEXT.loading);
      draw(list, true);
    },
    [draw, state],
  );

  /** The next page of what is shown, once: a second tap while it loads asks for nothing. */
  const loadMore = useCallback(() => {
    const signal = pending.current?.signal;
    if (state.status !== 'ready' || state.shown.status !== 'loaded' || state.shown.nextPage === null || paging.current || !signal) return;
    paging.current = true;
    setState({ ...state, shown: { ...state.shown, more: { status: 'loading' } } });
    void fetchPage(state.list, state.shown.nextPage, sequence.current, signal);
  }, [fetchPage, state]);

  const retry = useCallback(() => {
    if (state.status === 'failed') {
      setState({ status: 'loading' });
      setAttempt((count) => count + 1);
    } else if (state.status === 'ready' && state.shown.status === 'failed') {
      setState({ ...state, shown: { status: 'loading' } });
      draw(state.list);
    } else if (state.status === 'ready' && state.shown.status === 'loaded' && state.shown.more.status === 'failed') loadMore();
  }, [draw, loadMore, state]);

  return { state, select, loadMore, retry };
}
