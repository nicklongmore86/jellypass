// A collection's page data and its "Get all missing films": one GET /collection/<id> on opening (and on Try again), and
// asking for the films chosen one "Get this" at a time, in the page's order, never two at once. A film asked for counts
// once against the household's Get this limits, as from its own page. The first refusal stops the run: the films after
// it are not sent, and the page says which films were asked for and which were not, with the wait a 429 gave. Once
// anything was asked for the collection is read again. Nothing is retried by itself; a 401 signs the member out.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { ApiError, isAbortError } from '../api/errors';
import type { Collection, CollectionFilm } from '../api/types';
import { errorText, type ErrorText } from '../home/text';
import { useSession } from '../session/SessionProvider';
import { getThisError, getThisErrorText, GET_THIS_TEXT, type GetThisError } from '../title/text';
import { askedForText, notAskedForText } from './text';

/**
 * `failed`: the films (TMDB IDs) whose request the household made and could not get, from GET /requests as a film's page
 * reads them. They are never offered: asking again changes nothing until an administrator acts.
 */
export type CollectionLoad =
  | { status: 'loading' }
  | { status: 'loaded'; collection: Collection; failed: ReadonlySet<number> }
  | { status: 'failed'; error: ErrorText };

/** How the last "Get all missing films" (or "Get selected") went. */
export interface FilmsOutcome {
  asked: CollectionFilm[];
  notAsked: CollectionFilm[];
  error: GetThisError | undefined;
  retryAfterSeconds: number | undefined;
}

export interface CollectionData {
  load: CollectionLoad;
  /** A run is out: nothing can send again, and the boxes are disabled. */
  sending: boolean;
  outcome: FilmsOutcome | undefined;
  /** Films (TMDB IDs) asked for on this page: not offered again until it is left. */
  askedHere: ReadonlySet<number>;
  /** Asks for `films`, in this order, one at a time. */
  send: (films: readonly CollectionFilm[]) => void;
  reload: () => void;
}

/** What the outcome says, in order: the films asked for, those not, and why not. */
export function outcomeLines(outcome: FilmsOutcome): string[] {
  const lines: string[] = [];
  if (outcome.asked.length) lines.push(outcome.error ? askedForText(outcome.asked) : GET_THIS_TEXT.confirmation);
  if (outcome.error) {
    if (outcome.notAsked.length) lines.push(notAskedForText(outcome.notAsked));
    lines.push(getThisErrorText(outcome.error, outcome.retryAfterSeconds));
  }
  return lines;
}

export function useCollection(id: number): CollectionData {
  const { api, asked, expire, getThis } = useSession();
  const [load, setLoad] = useState<CollectionLoad>({ status: 'loading' });
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<FilmsOutcome | undefined>(undefined);
  const [askedHere, setAskedHere] = useState<ReadonlySet<number>>(new Set());
  const abort = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  const opening = useRef(0);
  const [attempt, setAttempt] = useState(0);

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

  /** The household's failed movie requests, by TMDB ID. Best effort, but a 401 (or an abort) is thrown. */
  const failedFilms = useCallback(
    async (signal: AbortSignal): Promise<Set<number>> => {
      try {
        const list = await api!.requests({ signal });
        return new Set(list.results.filter((entry) => entry.mediaType === 'movie' && entry.status === 'failed').map((entry) => entry.tmdbId));
      } catch (error) {
        if (isAbortError(error) || (error instanceof ApiError && error.kind === 'unauthorized')) throw error;
        return new Set();
      }
    },
    [api],
  );

  const read = useCallback(
    async (signal: AbortSignal): Promise<{ collection: Collection; failed: ReadonlySet<number> }> => {
      // Both reads settle first: the requests read fails only for a 401 (or an abort), which wins over the collection's own
      // failure whichever answers first, so a refused sign-in signs the member out rather than offering Try again.
      const [found, listed] = await Promise.allSettled([api!.collection(id, { signal }), failedFilms(signal)]);
      if (listed.status === 'rejected') throw listed.reason;
      if (found.status === 'rejected') throw found.reason;
      const collection = found.value;
      const failed = listed.value;
      // The films' states, as the latest the server said, for every other screen that shows them.
      asked.seen({ page: 1, nextPage: null, results: collection.films });
      return { collection, failed };
    },
    [api, asked, id, failedFilms],
  );

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    const mine = ++opening.current;
    busy.current = false;
    if (!api) return undefined;
    read(controller.signal).then(
      (found) => {
        if (opening.current === mine) setLoad({ status: 'loaded', ...found });
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
  }, [api, read, failure, attempt]);

  const send = useCallback(
    (films: readonly CollectionFilm[]) => {
      const signal = abort.current?.signal;
      if (!api || !signal || busy.current || films.length === 0) return;
      busy.current = true;
      const mine = opening.current;
      setSending(true);
      setOutcome(undefined);
      void (async () => {
        const done: CollectionFilm[] = [];
        let error: GetThisError | undefined;
        let wait: number | undefined;
        for (const film of films) {
          try {
            await getThis('movie', film.tmdbId, [], signal);
          } catch (caught) {
            if (opening.current !== mine || isAbortError(caught)) return;
            if (caught instanceof ApiError && caught.kind === 'unauthorized') {
              busy.current = false;
              void expire();
              return;
            }
            error = getThisError(caught instanceof ApiError ? caught.kind : 'unavailable');
            wait = error === 'rate_limited' && caught instanceof ApiError ? caught.retryAfterSeconds : undefined;
            break;
          }
          if (opening.current !== mine) return;
          done.push(film);
          setAskedHere((current) => new Set([...current, film.tmdbId]));
        }
        const result: FilmsOutcome = { asked: done, notAsked: films.slice(done.length), error, retryAfterSeconds: wait };
        setOutcome(result);
        AccessibilityInfo.announceForAccessibility?.(outcomeLines(result).join(' '));
        if (done.length) {
          try {
            const found = await read(signal);
            if (opening.current !== mine) return;
            setLoad({ status: 'loaded', ...found });
          } catch (caught) {
            if (opening.current !== mine) return;
            failure(caught);
          }
        }
        if (opening.current !== mine) return;
        busy.current = false;
        setSending(false);
      })();
    },
    [api, getThis, expire, failure, read],
  );

  const reload = useCallback(() => {
    setLoad({ status: 'loading' });
    setOutcome(undefined);
    setAskedHere(new Set());
    setAttempt((count) => count + 1);
  }, []);

  return { load, sending, outcome, askedHere, send, reload };
}
