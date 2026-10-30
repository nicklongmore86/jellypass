// The Hidden tab of My requests: the member's own hidden titles, as docs/app-api/fetch-budget.json's "hiding" →
// "hiddenTab" pins it. GET /hidden (the newest 50 IDs) each time the tab is shown (choosing it, coming back to My
// requests on it, Try again and pull to refresh), then the first HIDDEN_PER_STEP titles are named from their own answer
// (GET /movie or /tv, REQUEST_TITLE_CALLS at a time), as My requests names its entries; each Load more names the next
// ones, and once every listed ID is named it reads the list's next page (GET /hidden?page=n). A title named in the last
// ten minutes of this sign-in (the session's title cache, src/requests/titleCache.ts) is named from there with no call.
// A title that cannot be read says "Title unavailable" and keeps its Unhide. Nothing is retried by itself; a 401
// anywhere signs the member out. Every title answer read is seen by the session's overlay (src/title/asked.ts).
//
// Everything is kept in memory only: no answer is ever written to the device.
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';
import { ApiError, isAbortError } from '../api/errors';
import type { HiddenTitle } from '../api/types';
import { errorText, type ErrorText } from '../home/text';
import { REQUEST_TITLE_CALLS, REQUESTS_PER_PAGE, type RequestTitle } from '../requests/text';
import type { TitleCache } from '../requests/titleCache';
import type { MoreState } from '../search/useSearch';
import type { Asked } from '../title/asked';
import { hiddenKey } from './store';

/** The hidden titles named at first and by each Load more (the budget's `titlesAtOnce`). */
export const HIDDEN_PER_STEP = REQUESTS_PER_PAGE;

export type HiddenLoad =
  | { status: 'loading' }
  | { status: 'loaded'; entries: readonly HiddenTitle[]; nextPage: number | null }
  | { status: 'failed'; error: ErrorText };

export interface HiddenListData {
  load: HiddenLoad;
  /** How many entries are shown (named, or being named). */
  shown: number;
  /** What each shown entry knows of its title, by its key (`movie:<id>`). */
  titles: Readonly<Record<string, RequestTitle>>;
  /** Titles are being named, or the list read: Load more waits. */
  naming: boolean;
  /** The list's next page, when Load more had to read it. */
  more: MoreState;
  /** The list's first page and its first titles, again. */
  reload: () => Promise<void>;
  loadMore: () => void;
  /** The tab is no longer shown: whatever is out is dropped. */
  stop: () => void;
}

export function useHiddenList(api: ApiClient | undefined, expire: () => Promise<void>, overlay: Asked, cache: TitleCache): HiddenListData {
  const [load, setLoad] = useState<HiddenLoad>({ status: 'loading' });
  const [shown, setShown] = useState(0);
  const [titles, setTitles] = useState<Record<string, RequestTitle>>({});
  const [naming, setNaming] = useState(false);
  const [more, setMore] = useState<MoreState>({ status: 'idle' });
  // Each reading of the list gets a number and its own abort; an answer for an older one is dropped.
  const reading = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const live = useRef(true);
  const entries = useRef<readonly HiddenTitle[]>([]);
  const next = useRef<number | null>(null);
  const count = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      abort.current?.abort();
    };
  }, []);

  const current = (mine: number) => live.current && reading.current === mine;

  /** Signs out on a 401; true when the error is one to show (not an abort, a stale answer or a 401). */
  const shows = useCallback(
    (error: unknown, mine: number): boolean => {
      if (!current(mine) || isAbortError(error)) return false;
      if (error instanceof ApiError && error.kind === 'unauthorized') {
        void expire();
        return false;
      }
      return true;
    },
    [expire],
  );

  /** Names the next `size` entries: those kept at once, the others a few title calls at a time. */
  const name = useCallback(
    async (size: number, mine: number, signal: AbortSignal): Promise<void> => {
      if (!api) return;
      const batch = entries.current.slice(count.current, count.current + size);
      count.current += batch.length;
      setShown(count.current);
      if (batch.length === 0) return;
      const keyOf = (entry: HiddenTitle) => hiddenKey(entry.mediaType, entry.tmdbId);
      const kept = new Map(batch.map((entry) => [keyOf(entry), cache.get(entry.mediaType, entry.tmdbId)]));
      const unread = batch.filter((entry) => !kept.get(keyOf(entry)));
      setTitles((now) => ({
        ...now,
        ...Object.fromEntries(
          batch.map((entry) => {
            const key = keyOf(entry);
            const details = kept.get(key);
            if (details) return [key, { status: 'loaded', title: details } as RequestTitle];
            return [key, now[key]?.status === 'loaded' ? now[key]! : ({ status: 'loading' } as RequestTitle)];
          }),
        ),
      }));
      let at = 0;
      let stopped = false;
      const worker = async (): Promise<void> => {
        while (at < unread.length && !stopped && current(mine)) {
          const entry = unread[at++]!;
          let title: RequestTitle;
          try {
            const found = entry.mediaType === 'tv' ? await api.tv(entry.tmdbId, { signal }) : await api.movie(entry.tmdbId, { signal });
            if (!current(mine)) return;
            overlay.seen(found);
            const details = { title: found.title, year: found.year, posterUrl: found.posterUrl };
            cache.set(entry.mediaType, entry.tmdbId, details);
            title = { status: 'loaded', title: details };
          } catch (error) {
            if (!shows(error, mine)) {
              stopped = true;
              return;
            }
            title = { status: 'missing' };
          }
          setTitles((now) => ({ ...now, [keyOf(entry)]: title }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(REQUEST_TITLE_CALLS, unread.length) }, worker));
    },
    [api, overlay, cache, shows],
  );

  const reload = useCallback(async (): Promise<void> => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const mine = ++reading.current;
    if (!api) return;
    busy.current = true;
    setNaming(true);
    setMore({ status: 'idle' });
    try {
      const page = await api.hidden(1, { signal: controller.signal });
      if (!current(mine)) return;
      entries.current = page.results;
      next.current = page.nextPage;
      count.current = 0;
      const keys = new Set(page.results.map((entry) => hiddenKey(entry.mediaType, entry.tmdbId)));
      setTitles((now) => Object.fromEntries(Object.entries(now).filter(([key]) => keys.has(key))));
      setLoad({ status: 'loaded', entries: page.results, nextPage: page.nextPage });
      await name(HIDDEN_PER_STEP, mine, controller.signal);
    } catch (error) {
      if (shows(error, mine)) setLoad({ status: 'failed', error: errorText(error instanceof ApiError ? error.kind : 'unavailable') });
    } finally {
      if (current(mine)) {
        busy.current = false;
        setNaming(false);
      }
    }
  }, [api, name, shows]);

  const loadMore = useCallback(() => {
    const signal = abort.current?.signal;
    const mine = reading.current;
    if (!api || !signal || busy.current || load.status !== 'loaded') return;
    if (count.current >= entries.current.length && next.current === null) return;
    busy.current = true;
    setNaming(true);
    void (async () => {
      try {
        if (count.current >= entries.current.length && next.current !== null) {
          setMore({ status: 'loading' });
          const page = await api.hidden(next.current, { signal });
          if (!current(mine)) return;
          // A title hidden meanwhile moves the list on by one: one already listed is not listed twice.
          const listed = new Set(entries.current.map((entry) => hiddenKey(entry.mediaType, entry.tmdbId)));
          entries.current = [...entries.current, ...page.results.filter((entry) => !listed.has(hiddenKey(entry.mediaType, entry.tmdbId)))];
          next.current = page.nextPage;
          setMore({ status: 'idle' });
          setLoad({ status: 'loaded', entries: entries.current, nextPage: page.nextPage });
        }
        await name(HIDDEN_PER_STEP, mine, signal);
      } catch (error) {
        if (shows(error, mine)) setMore({ status: 'failed', error: errorText(error instanceof ApiError ? error.kind : 'unavailable') });
      } finally {
        if (current(mine)) {
          busy.current = false;
          setNaming(false);
        }
      }
    })();
  }, [api, load, name, shows]);

  const stop = useCallback(() => {
    reading.current += 1;
    abort.current?.abort();
    busy.current = false;
  }, []);

  return { load, shown, titles, naming, more, reload, loadMore, stop };
}
