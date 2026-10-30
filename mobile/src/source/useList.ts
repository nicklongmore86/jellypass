// A Discover row's "See all" page data, the TV add-on's list page (tv/src/discover-source.ts, `list` kind) natively: one
// list, paged through the API's own GET /discover/<list>?page=n. Opened from its row, the grid starts from the page the
// row showed (src/home/rowPages.ts) and asks for nothing; opened by its address, it asks for the first page alone
// (there is nothing to look up). Each further page only when the member presses Load more. A failure stays until the
// member taps Try again, which asks again for that one call (nothing is retried by itself); a 401 signs the member
// out. Every page is seen by the session's overlay as it arrives (src/title/asked.ts).
//
// Everything is kept in memory only, for as long as the page is on its stack: no answer is ever written to the device.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import type { ApiClient } from '../api/client';
import { ApiError, isAbortError } from '../api/errors';
import type { DiscoverList, Page } from '../api/types';
import { errorText, type ErrorText } from '../home/text';
import { SEARCH_TEXT } from '../search/text';
import type { Asked } from '../title/asked';
import type { ListState } from './useSource';

export interface ListData {
  shown: ListState;
  loadMore: () => void;
  /** Try again: the call that failed, alone. */
  retry: () => void;
}

const loaded = (page: Page): ListState => ({ status: 'loaded', cards: page.results, nextPage: page.nextPage, more: { status: 'idle' } });

/** `kept` is the page the row showed, if the page was opened from it: drawn at once, with no call. */
export function useList(api: ApiClient | undefined, expire: () => Promise<void>, overlay: Asked, list: DiscoverList, kept: Page | undefined): ListData {
  const [shown, setShown] = useState<ListState>(() => (kept ? loaded(kept) : { status: 'loading' }));
  /** Bumped by Try again after the first page failed, to ask for it again. */
  const [attempt, setAttempt] = useState(0);
  /** Whether the first page is in hand already (the row's), so the page asks for nothing as it opens. */
  const had = useRef(kept !== undefined);
  // Each first-page drawing gets a number and its own abort; an answer for an older one is dropped.
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

  // The first page, unless the row's is in hand: as the page opens, and again on Try again.
  useEffect(() => {
    if (!api || had.current) return undefined;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const mine = ++sequence.current;
    paging.current = false;
    api.discover(list, 1, { signal: controller.signal }).then(
      (page) => {
        if (!live.current || sequence.current !== mine) return;
        overlay.seen(page);
        had.current = true;
        setShown(loaded(page));
      },
      (error: unknown) => {
        const kind = failure(error, mine);
        if (kind) setShown({ status: 'failed', error: kind });
      },
    );
    return () => controller.abort();
  }, [api, list, attempt, overlay, failure]);

  /** The next page, once: a second tap while it loads asks for nothing. */
  const loadMore = useCallback(() => {
    if (!api || shown.status !== 'loaded' || shown.nextPage === null || paging.current) return;
    if (!pending.current || pending.current.signal.aborted) pending.current = new AbortController();
    const signal = pending.current.signal;
    const mine = sequence.current;
    const number = shown.nextPage;
    paging.current = true;
    setShown({ ...shown, more: { status: 'loading' } });
    api.discover(list, number, { signal }).then(
      (page) => {
        if (sequence.current === mine) paging.current = false;
        if (!live.current || sequence.current !== mine) return;
        overlay.seen(page);
        setShown((current) =>
          current.status === 'loaded' ? { ...current, cards: [...current.cards, ...page.results], nextPage: page.nextPage, more: { status: 'idle' } } : current,
        );
        AccessibilityInfo.announceForAccessibility?.(SEARCH_TEXT.more);
      },
      (error: unknown) => {
        if (sequence.current === mine) paging.current = false;
        const kind = failure(error, mine);
        if (kind) setShown((current) => (current.status === 'loaded' ? { ...current, more: { status: 'failed', error: kind } } : current));
      },
    );
  }, [api, list, overlay, failure, shown]);

  const retry = useCallback(() => {
    if (shown.status === 'failed') {
      setShown({ status: 'loading' });
      setAttempt((count) => count + 1);
    } else if (shown.status === 'loaded' && shown.more.status === 'failed') loadMore();
  }, [loadMore, shown]);

  return { shown, loadMore, retry };
}
