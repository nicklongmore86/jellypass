// My requests' filters, kept while the app is open: one store per signed-in session (SessionProvider), so a sign-out, a
// 401 or any other sign-in (household, member or token) starts it unfiltered. In memory only: never written to the
// device. Choosing a filter reads nothing; it only changes which of the entries already listed are shown.
import { useSyncExternalStore } from 'react';

import { NO_REQUEST_FILTER, type RequestFilter } from './text';

export interface RequestFilterStore {
  get(): RequestFilter;
  set(filter: RequestFilter): void;
  /** Back to no filter. */
  reset(): void;
  subscribe(listener: () => void): () => void;
}

export function createRequestFilterStore(): RequestFilterStore {
  let filter: RequestFilter = { ...NO_REQUEST_FILTER };
  const listeners = new Set<() => void>();
  const change = (next: RequestFilter) => {
    if (next.status === filter.status && next.kind === filter.kind && next.byYou === filter.byYou) return;
    filter = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => filter,
    set: (next) => change({ ...next }),
    reset: () => change({ ...NO_REQUEST_FILTER }),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export function useRequestFilter(store: RequestFilterStore): RequestFilter {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
