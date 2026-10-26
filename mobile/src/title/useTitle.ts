// A title page's data and its Get this, as the PWA's title() and season() (app/src/main.ts) ask for them: the movie or
// series (a season page: the season, and its series for the backdrop and name, best effort) and, at the same time,
// GET /requests for the seasons the household asked for that did not work out. That is docs/app-api/fetch-budget.json's
// movie, series and season screens (with the start-up /me). Nothing is retried by itself; a 401 anywhere signs the
// member out.
//
// Get this is disabled while it is out, and says only whether it was accepted: the same fixed confirmation whatever
// followed. Once accepted the screen is read again (as the PWA does), and if that fails the confirmation stays, with
// the one fixed error and Try again. Everything is kept in memory only, for as long as the page is on screen.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import type { ApiClient } from '../api/client';
import { ApiError, isAbortError } from '../api/errors';
import type { MediaType, Movie, Season, Series } from '../api/types';
import { errorText, type ErrorText } from '../home/text';
import { useSession } from '../session/SessionProvider';
import { GET_THIS_TEXT, getThisError, type GetThisError } from './text';

export type TitleRoute = { mediaType: MediaType; tmdbId: number } | { mediaType: 'season'; tmdbId: number; seasonNumber: number };

export interface TitleAnswer {
  /** The movie or series; on a season page, the series when it could be read. */
  title: Movie | Series | undefined;
  /** A season page's season. */
  season: Season | undefined;
  /** Seasons (0 for a movie) the household asked for that failed, from GET /requests. */
  failed: ReadonlySet<number>;
}

export type TitleLoad = { status: 'loading' } | { status: 'loaded'; answer: TitleAnswer } | { status: 'failed'; error: ErrorText };

export interface GetThisState {
  /** The call is out: everything that could send again is disabled. */
  sending: boolean;
  /** Accepted, and the screen is being read again: the controls are gone until it has been. */
  reloading: boolean;
  /** The one fixed confirmation is showing. */
  confirmed: boolean;
  /** Accepted, but the screen could not be read again. */
  refreshFailed: boolean;
  error: GetThisError | undefined;
  /** Seasons (0 for a movie) asked for on this screen: not offered again until it is left. */
  asked: ReadonlySet<number>;
}

const IDLE: GetThisState = { sending: false, reloading: false, confirmed: false, refreshFailed: false, error: undefined, asked: new Set() };

export interface TitleData {
  load: TitleLoad;
  get: GetThisState;
  /** Get this for these seasons (none for a movie). */
  send: (seasons: readonly number[]) => void;
  /** Opens the page again from the start (Try again). */
  reload: () => void;
}

/** The seasons (0 for a movie) of a title the household asked for that did not work out. Best effort, but a 401 is thrown. */
async function failedSeasons(api: ApiClient, mediaType: MediaType, tmdbId: number, signal: AbortSignal): Promise<Set<number>> {
  try {
    const list = await api.requests({ signal });
    const entry = list.results.find((candidate) => candidate.mediaType === mediaType && candidate.tmdbId === tmdbId);
    if (!entry) return new Set();
    if (mediaType === 'movie') return new Set(entry.status === 'failed' ? [0] : []);
    return new Set(entry.seasons.filter((season) => season.status === 'failed').map((season) => season.seasonNumber));
  } catch (error) {
    if (isAbortError(error) || (error instanceof ApiError && error.kind === 'unauthorized')) throw error;
    return new Set();
  }
}

async function read(api: ApiClient, route: TitleRoute, signal: AbortSignal): Promise<TitleAnswer> {
  if (route.mediaType === 'season') {
    const [season, title, failed] = await Promise.all([
      api.season(route.tmdbId, route.seasonNumber, { signal }),
      api.tv(route.tmdbId, { signal }).then(
        (series) => series,
        () => undefined,
      ),
      failedSeasons(api, 'tv', route.tmdbId, signal),
    ]);
    return { title, season, failed };
  }
  const [title, failed] = await Promise.all([
    route.mediaType === 'tv' ? api.tv(route.tmdbId, { signal }) : api.movie(route.tmdbId, { signal }),
    failedSeasons(api, route.mediaType, route.tmdbId, signal),
  ]);
  return { title, season: undefined, failed };
}

export function useTitle(route: TitleRoute): TitleData {
  const { api, expire, getThis } = useSession();
  const [load, setLoad] = useState<TitleLoad>({ status: 'loading' });
  const [get, setGet] = useState<GetThisState>(IDLE);
  const abort = useRef<AbortController | undefined>(undefined);
  /** A Get this is out, or its screen is being read again: a second tap before the screen is drawn sends nothing. */
  const busy = useRef(false);
  // Each opening gets a number; an answer for an older one is dropped.
  const opening = useRef(0);
  const { mediaType, tmdbId } = route;
  const seasonNumber = route.mediaType === 'season' ? route.seasonNumber : undefined;

  /** A failure's fixed wording, or undefined when there is nothing to show (an abort, or a 401 that signs out). */
  const failure = useCallback(
    (error: unknown): ErrorText | undefined => {
      if (isAbortError(error)) return undefined;
      if (error instanceof ApiError && error.kind === 'unauthorized') {
        void expire();
        return undefined;
      }
      return errorText(error instanceof ApiError ? error.kind : 'unavailable');
    },
    [expire],
  );

  // Each opening (and each Try again) reads the page once; leaving the page, or opening it again, drops what was out.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    const mine = ++opening.current;
    busy.current = false;
    if (!api) return undefined;
    const at: TitleRoute = seasonNumber === undefined ? { mediaType: mediaType as MediaType, tmdbId } : { mediaType: 'season', tmdbId, seasonNumber };
    read(api, at, controller.signal).then(
      (answer) => {
        if (opening.current === mine) setLoad({ status: 'loaded', answer });
      },
      (error: unknown) => {
        const kind = opening.current === mine ? failure(error) : undefined;
        if (kind) setLoad({ status: 'failed', error: kind });
      },
    );
    return () => {
      opening.current += 1;
      controller.abort();
    };
  }, [api, mediaType, tmdbId, seasonNumber, failure, attempt]);

  const send = useCallback(
    (seasons: readonly number[]) => {
      const signal = abort.current?.signal;
      if (!api || !signal || busy.current) return;
      busy.current = true;
      const mine = opening.current;
      const target: MediaType = mediaType === 'movie' ? 'movie' : 'tv';
      setGet((current) => ({ ...current, sending: true, error: undefined }));
      void (async () => {
        try {
          await getThis(target, tmdbId, seasons, signal);
        } catch (error) {
          if (opening.current !== mine || isAbortError(error)) return;
          busy.current = false;
          if (error instanceof ApiError && error.kind === 'unauthorized') {
            void expire();
            return;
          }
          const message = getThisError(error instanceof ApiError ? error.kind : 'unavailable');
          setGet((current) => ({ ...current, sending: false, error: message }));
          AccessibilityInfo.announceForAccessibility?.(GET_THIS_TEXT[message]);
          return;
        }
        if (opening.current !== mine) return;
        // Accepted: the confirmation at once, whatever reading the screen again does. Nothing here can send again.
        setGet((current) => ({
          ...current,
          sending: false,
          reloading: true,
          confirmed: true,
          asked: new Set([...current.asked, ...(seasons.length ? seasons : [0])]),
        }));
        AccessibilityInfo.announceForAccessibility?.(GET_THIS_TEXT.confirmation);
        const at: TitleRoute = seasonNumber === undefined ? { mediaType: mediaType as MediaType, tmdbId } : { mediaType: 'season', tmdbId, seasonNumber };
        try {
          const answer = await read(api, at, signal);
          if (opening.current !== mine) return;
          busy.current = false;
          setLoad({ status: 'loaded', answer });
          setGet((current) => ({ ...current, reloading: false }));
        } catch (error) {
          if (opening.current !== mine || !failure(error)) return;
          setGet((current) => ({ ...current, reloading: false, refreshFailed: true }));
        }
      })();
    },
    [api, getThis, expire, failure, mediaType, tmdbId, seasonNumber],
  );

  const reload = useCallback(() => {
    setLoad({ status: 'loading' });
    setGet(IDLE);
    setAttempt((count) => count + 1);
  }, []);

  return { load, get, send, reload };
}
