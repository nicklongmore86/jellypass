// My requests' data, as the PWA's requestsScreen() (app/src/main.ts) asks for it: GET /requests each time the screen
// is shown (its first opening, coming back to it, and pull to refresh), then the first REQUESTS_PER_PAGE requests are
// named from their title's own answer (GET /movie or /tv, REQUEST_TITLE_CALLS at a time), and each Load more names
// the next ones the same way. Shown again, it names as many as were showing, as the PWA does coming back. A title that cannot be read leaves its request's status in place ("Title unavailable");
// a failed list stays until the member taps Try again. Nothing is retried by itself, and a 401 anywhere signs the
// member out. Every title answer is seen by the session's overlay (src/title/asked.ts) as it arrives, as the PWA's
// API layer does with it, so the title's latest state is what Home, Search and its page show.
//
// Everything is kept in memory only, for as long as the screen is on: no answer is ever written to the device.
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';
import { ApiError, isAbortError } from '../api/errors';
import type { Request } from '../api/types';
import { errorText, type ErrorText } from '../home/text';
import type { Asked } from '../title/asked';
import { REQUEST_TITLE_CALLS, REQUESTS_PER_PAGE, type RequestTitle } from './text';

export type RequestsLoad = { status: 'loading' } | { status: 'loaded'; requests: readonly Request[] } | { status: 'failed'; error: ErrorText };

export interface RequestsData {
  load: RequestsLoad;
  /** How many requests are shown (named, or being named). */
  shown: number;
  /** What each shown request knows of its title, by its id. */
  titles: Readonly<Record<string, RequestTitle>>;
  /** The titles of the last Load more are still being read. */
  naming: boolean;
  /** The list and the first titles, again: on showing the screen, Try again and pull to refresh. */
  reload: () => Promise<void>;
  loadMore: () => void;
  /** The screen is no longer shown: whatever is out is dropped. */
  stop: () => void;
}

export function useRequests(api: ApiClient | undefined, expire: () => Promise<void>, overlay: Asked): RequestsData {
  const [load, setLoad] = useState<RequestsLoad>({ status: 'loading' });
  const [shown, setShown] = useState(0);
  const [titles, setTitles] = useState<Record<string, RequestTitle>>({});
  const [naming, setNaming] = useState(false);
  // Each reading of the list gets a number and its own abort; an answer for an older one is dropped.
  const reading = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const live = useRef(true);
  const requests = useRef<readonly Request[]>([]);
  const count = useRef(0);

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

  /** Names the next `size` requests, a few title calls at a time. */
  const name = useCallback(
    async (size: number, mine: number, signal: AbortSignal): Promise<void> => {
      if (!api) return;
      const batch = requests.current.slice(count.current, count.current + size);
      count.current += batch.length;
      setShown(count.current);
      if (batch.length === 0) return;
      setNaming(true);
      // A title already named (the screen shown again) keeps its name while it is read again.
      setTitles((now) => ({
        ...now,
        ...Object.fromEntries(batch.map((request) => [request.id, now[request.id]?.status === 'loaded' ? now[request.id]! : ({ status: 'loading' } as RequestTitle)])),
      }));
      let next = 0;
      let stopped = false;
      const worker = async (): Promise<void> => {
        while (next < batch.length && !stopped && current(mine)) {
          const request = batch[next++]!;
          let title: RequestTitle;
          try {
            const found = request.mediaType === 'tv' ? await api.tv(request.tmdbId, { signal }) : await api.movie(request.tmdbId, { signal });
            if (!current(mine)) return;
            overlay.seen(found);
            title = { status: 'loaded', title: found };
          } catch (error) {
            if (!shows(error, mine)) {
              stopped = true;
              return;
            }
            // The status stays; only the name could not be read.
            title = { status: 'missing' };
          }
          setTitles((now) => ({ ...now, [request.id]: title }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(REQUEST_TITLE_CALLS, batch.length) }, worker));
      if (current(mine)) setNaming(false);
    },
    [api, overlay, shows],
  );

  const reload = useCallback(async (): Promise<void> => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const mine = ++reading.current;
    if (!api) return;
    setNaming(false);
    try {
      const list = await api.requests({ signal: controller.signal });
      if (!current(mine)) return;
      // As many as were showing are named again (the screen shown again keeps its place), at least the first page.
      const again = Math.max(REQUESTS_PER_PAGE, count.current);
      requests.current = list.results;
      count.current = 0;
      const ids = new Set(list.results.map((request) => request.id));
      setTitles((now) => Object.fromEntries(Object.entries(now).filter(([id]) => ids.has(id))));
      setLoad({ status: 'loaded', requests: list.results });
      await name(again, mine, controller.signal);
    } catch (error) {
      if (shows(error, mine)) setLoad({ status: 'failed', error: errorText(error instanceof ApiError ? error.kind : 'unavailable') });
    }
  }, [api, name, shows]);

  const loadMore = useCallback(() => {
    const signal = abort.current?.signal;
    if (naming || !signal || load.status !== 'loaded' || count.current >= requests.current.length) return;
    void name(REQUESTS_PER_PAGE, reading.current, signal);
  }, [naming, load, name]);

  const stop = useCallback(() => {
    reading.current += 1;
    abort.current?.abort();
  }, []);

  return { load, shown, titles, naming, reload, loadMore, stop };
}
