// Search's data, as the PWA's search() (app/src/main.ts) asks for it: one call per pause in typing (SEARCH_DEBOUNCE_MS)
// or at once on the keyboard's Search key, the call before it aborted, then each further page only when the member
// presses Load more. An answer for a query that is no longer the latest (or a page asked for under one) is dropped,
// so an older search answering late never replaces a newer one. A failure stays until the member taps Try again,
// which asks again for that one page (nothing is retried by itself); a 401 signs the member out. Every page is seen
// by the session's overlay as it arrives (src/title/asked.ts), so a card shows Requested right after Get this and a
// title's latest state from wherever it was read since.
//
// Everything is kept in memory only, for as long as the Search tab is open: no answer is ever written to the device.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import type { ApiClient } from '../api/client';
import { ApiError, isAbortError } from '../api/errors';
import type { Card } from '../api/types';
import { errorText, type ErrorText } from '../home/text';
import type { Asked } from '../title/asked';
import { SEARCH_DEBOUNCE_MS, SEARCH_TEXT, searchQuery } from './text';

/** The next page: not asked for, on its way, or failed (with its Try again). */
export type MoreState = { status: 'idle' } | { status: 'loading' } | { status: 'failed'; error: ErrorText };

export type SearchState =
  /** Nothing searched for (an empty field). */
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  /** `cards` are the pages' own cards, in order, as the overlay saw them. */
  | { status: 'loaded'; query: string; cards: readonly Card[]; nextPage: number | null; more: MoreState }
  | { status: 'failed'; query: string; error: ErrorText };

export interface SearchData {
  /** The field's text, as typed. */
  text: string;
  state: SearchState;
  /** The member typed: searches once they pause. */
  type: (text: string) => void;
  /** The keyboard's Search key: searches at once. */
  submit: () => void;
  loadMore: () => void;
  /** Try again: the page that failed, alone. */
  retry: () => void;
}

const announce = (text: string) => {
  if (text) AccessibilityInfo.announceForAccessibility?.(text);
};

export function useSearch(api: ApiClient | undefined, expire: () => Promise<void>, overlay: Asked): SearchData {
  const [text, setText] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  // Each search (each query sent) gets a number and its own abort; an answer for an older one is dropped.
  const sequence = useRef(0);
  const pending = useRef<AbortController | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef(true);
  /** A further page is on its way: a second Load more before it answers asks for nothing. */
  const paging = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
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

  /** One page of `query`'s results: the first replaces what is shown, a later one is added under it. */
  const fetchPage = useCallback(
    async (query: string, page: number, mine: number, signal: AbortSignal): Promise<void> => {
      if (!api) return;
      try {
        const answer = await api.search(query, page, { signal });
        if (sequence.current === mine) paging.current = false;
        if (!live.current || sequence.current !== mine) return;
        overlay.seen(answer);
        setState((current) => {
          if (page === 1) return { status: 'loaded', query, cards: answer.results, nextPage: answer.nextPage, more: { status: 'idle' } };
          if (current.status !== 'loaded' || current.query !== query) return current;
          return { ...current, cards: [...current.cards, ...answer.results], nextPage: answer.nextPage, more: { status: 'idle' } };
        });
        announce(page > 1 ? SEARCH_TEXT.more : answer.results.length ? SEARCH_TEXT.loaded : '');
      } catch (error) {
        if (sequence.current === mine) paging.current = false;
        const kind = failure(error, mine);
        if (!kind) return;
        setState((current) => {
          if (page === 1) return { status: 'failed', query, error: kind };
          return current.status === 'loaded' && current.query === query ? { ...current, more: { status: 'failed', error: kind } } : current;
        });
      }
    },
    [api, overlay, failure],
  );

  /** Searches for `raw` now, dropping whatever was out. */
  const run = useCallback(
    (raw: string) => {
      clearTimeout(timer.current);
      pending.current?.abort();
      const mine = ++sequence.current;
      paging.current = false;
      const query = searchQuery(raw);
      if (!query || !api) {
        setState({ status: 'idle' });
        return;
      }
      const controller = new AbortController();
      pending.current = controller;
      setState({ status: 'loading', query });
      announce(SEARCH_TEXT.searching);
      void fetchPage(query, 1, mine, controller.signal);
    },
    [api, fetchPage],
  );

  const type = useCallback(
    (value: string) => {
      setText(value);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => run(value), SEARCH_DEBOUNCE_MS);
    },
    [run],
  );

  const submit = useCallback(() => run(text), [run, text]);

  /** The next page of what is shown, once: a second tap while it loads asks for nothing. */
  const loadMore = useCallback(() => {
    const signal = pending.current?.signal;
    if (state.status !== 'loaded' || state.nextPage === null || paging.current || !signal) return;
    paging.current = true;
    setState({ ...state, more: { status: 'loading' } });
    void fetchPage(state.query, state.nextPage, sequence.current, signal);
  }, [fetchPage, state]);

  const retry = useCallback(() => {
    if (state.status === 'failed') run(state.query);
    else if (state.status === 'loaded' && state.more.status === 'failed') loadMore();
  }, [run, loadMore, state]);

  return { text, state, type, submit, loadMore, retry };
}
