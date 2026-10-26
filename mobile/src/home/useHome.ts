// Home's data, as the PWA's home() in app/src/main.ts asks for it: under the chosen filter, the eager rows and
// /discover/sources at once, then each lazy row (the rest of the discover rows and each service's row) only when the
// screen says it has come near (`near`). Each row loads and fails on its own; a failure stays until the member taps
// Try again (nothing is ever retried by itself). Choosing another filter drops the old one's rows and fetches the new
// one's the same way; the networks and studios are asked for once per visit. A 401 anywhere signs the member out.
//
// Everything is kept in memory only, for as long as Home is on screen: no answer is ever written to the device.
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';
import { ApiError, isAbortError } from '../api/errors';
import type { Network, Page, Sources } from '../api/types';
import type { Asked } from '../title/asked';
import { HOME_LAYOUT, NETWORK_LIST, networkKey, rowKey, type HomeRow } from './layout';
import { errorText, type ErrorText, type HomeFilter } from './text';

export type RowState =
  /** A lazy row that has not come near the screen yet. */
  | { status: 'waiting' }
  | { status: 'loading' }
  | { status: 'loaded'; page: Page }
  | { status: 'failed'; error: ErrorText };

export type SourcesState = { status: 'loading' } | { status: 'loaded'; sources: Sources } | { status: 'failed'; error: ErrorText };

export interface HomeData {
  filter: HomeFilter;
  /** Each row's state by its key (layout.ts); a row with none is waiting. */
  rows: Readonly<Record<string, RowState>>;
  sources: SourcesState;
  /** True once everything asked for at once has answered: only then are lazy rows loaded as they near the screen. */
  started: boolean;
  choose: (filter: HomeFilter) => void;
  /** Lazy rows that have come near the screen: each is fetched once per filter. */
  near: (keys: readonly string[]) => void;
  /** The member's Try again on one row. */
  retry: (key: string) => void;
  /** The member's Try again on the networks and studios. */
  retrySources: () => void;
  /** Pull to refresh: the filter's rows and the networks and studios again, the lazy rows as they near the screen. */
  refresh: () => Promise<void>;
}

/** The services a filter shows a row for: Movies only those with films. */
export function listedNetworks(filter: HomeFilter, sources: Sources): Network[] {
  return sources.networks.filter((network) => filter !== 'movies' || network.hasFilms);
}

/** What a service's row lists under a filter (only its series when it has no films). */
export function networkList(filter: HomeFilter, network: Network) {
  return network.hasFilms ? NETWORK_LIST[filter] : 'series';
}

function homeRows(filter: HomeFilter): HomeRow[] {
  return HOME_LAYOUT[filter].filter((part): part is HomeRow => part.part === 'row');
}

/**
 * `overlay` is the session's Requested overlay (src/title/asked.ts): each row's page is seen by it as it arrives, so a
 * fresher answer for a title (its page opened since) is what the row's card shows.
 */
export function useHome(api: ApiClient | undefined, expire: () => Promise<void>, overlay?: Asked, initial: HomeFilter = 'all'): HomeData {
  const [filter, setFilter] = useState<HomeFilter>(initial);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [sources, setSources] = useState<SourcesState>({ status: 'loading' });
  const [started, setStarted] = useState(false);

  // Each drawing (a filter chosen, or a refresh) gets a new number and its own abort; an answer for an older one is dropped.
  const drawing = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const shown = useRef<HomeFilter>(initial);
  /** The networks and studios, once known: asked for once per visit, however often the filter changes. */
  const found = useRef<Sources | undefined>(undefined);
  /** The lazy rows already asked for in this drawing. */
  const asked = useRef(new Set<string>());
  const live = useRef(true);

  const failed = useCallback(
    (error: unknown, mine: number): ErrorText | undefined => {
      if (!live.current || drawing.current !== mine || isAbortError(error)) return undefined;
      if (error instanceof ApiError && error.kind === 'unauthorized') {
        void expire();
        return undefined;
      }
      return errorText(error instanceof ApiError ? error.kind : 'unavailable');
    },
    [expire],
  );

  /** How each row of the shown filter is fetched, by its key. */
  const loader = useCallback(
    (key: string, signal: AbortSignal): (() => Promise<Page>) | undefined => {
      if (!api) return undefined;
      const part = homeRows(shown.current).find((candidate) => rowKey(candidate) === key);
      if (part) return () => api.discover(part.list, 1, { signal });
      const network = found.current && listedNetworks(shown.current, found.current).find((candidate) => networkKey(candidate.id) === key);
      if (!network) return undefined;
      const list = networkList(shown.current, network);
      return () => api.network(network.id, list === 'series' ? undefined : list, 1, { signal });
    },
    [api],
  );

  const run = useCallback(
    async (key: string): Promise<void> => {
      const mine = drawing.current;
      const signal = abort.current?.signal;
      const load = signal && loader(key, signal);
      if (!load) return;
      setRows((current) => ({ ...current, [key]: { status: 'loading' } }));
      try {
        const page = await load();
        if (!live.current || drawing.current !== mine) return;
        overlay?.seen(page);
        setRows((current) => ({ ...current, [key]: { status: 'loaded', page } }));
      } catch (error) {
        const kind = failed(error, mine);
        if (kind) setRows((current) => ({ ...current, [key]: { status: 'failed', error: kind } }));
      }
    },
    [loader, failed, overlay],
  );

  const loadSources = useCallback(async (): Promise<void> => {
    const mine = drawing.current;
    const signal = abort.current?.signal;
    if (found.current) return setSources({ status: 'loaded', sources: found.current });
    if (!api || !signal) return;
    setSources({ status: 'loading' });
    try {
      const listing = await api.sources({ signal });
      if (!live.current || drawing.current !== mine) return;
      found.current = listing;
      setSources({ status: 'loaded', sources: listing });
    } catch (error) {
      const kind = failed(error, mine);
      if (kind) setSources({ status: 'failed', error: kind });
    }
  }, [api, failed]);

  const draw = useCallback(
    async (next: HomeFilter): Promise<void> => {
      abort.current?.abort();
      abort.current = new AbortController();
      const mine = ++drawing.current;
      shown.current = next;
      asked.current = new Set();
      setFilter(next);
      setStarted(false);
      const eager = homeRows(next).filter((part) => part.eager);
      setRows(Object.fromEntries(eager.map((part) => [rowKey(part), { status: 'loading' } as RowState])));
      await Promise.all([loadSources(), ...eager.map((part) => run(rowKey(part)))]);
      if (live.current && drawing.current === mine) setStarted(true);
    },
    [loadSources, run],
  );

  useEffect(() => {
    live.current = true;
    if (api) void draw(shown.current);
    return () => {
      live.current = false;
      abort.current?.abort();
    };
  }, [api, draw]);

  const choose = useCallback(
    (next: HomeFilter) => {
      if (next !== shown.current) void draw(next);
    },
    [draw],
  );

  const near = useCallback(
    (keys: readonly string[]) => {
      for (const key of keys) {
        if (asked.current.has(key)) continue;
        asked.current.add(key);
        void run(key);
      }
    },
    [run],
  );

  const refresh = useCallback(async () => {
    found.current = undefined;
    await draw(shown.current);
  }, [draw]);

  return {
    filter,
    rows,
    sources,
    started,
    choose,
    near,
    retry: (key) => void run(key),
    retrySources: () => void loadSources(),
    refresh,
  };
}
