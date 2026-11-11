// A film page's look at its collection (a film series): one GET /collection/<id>, made once the film's page is drawn and
// never again while it is open (no retry, no poll, and not the collection page's GET /requests: the preview draws each
// film's state as the collection answer gives it). A failure leaves the page's plain "Part of …" link; a 401 signs the
// member out, as every other read does. Leaving the page aborts the read. Its section is keyed by the collection's ID,
// so a page that comes to name another collection starts over at loading.
import { useEffect, useState } from 'react';

import { ApiError, isAbortError } from '../api/errors';
import type { Collection } from '../api/types';
import { useSession } from '../session/SessionProvider';

export type CollectionPreview = { status: 'loading' } | { status: 'loaded'; collection: Collection } | { status: 'failed' };

export function useCollectionPreview(id: number): CollectionPreview {
  const { api, asked, expire } = useSession();
  const [preview, setPreview] = useState<CollectionPreview>({ status: 'loading' });

  useEffect(() => {
    if (!api) return undefined;
    const controller = new AbortController();
    let live = true;
    api.collection(id, { signal: controller.signal }).then(
      (collection) => {
        if (!live) return;
        // The films' states, as the latest the server said, for every other screen that shows them (as the collection page does).
        asked.seen({ page: 1, nextPage: null, results: collection.films });
        setPreview({ status: 'loaded', collection });
      },
      (error: unknown) => {
        if (!live || isAbortError(error)) return;
        if (error instanceof ApiError && error.kind === 'unauthorized') {
          void expire();
          return;
        }
        setPreview({ status: 'failed' });
      },
    );
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, asked, expire, id]);

  return preview;
}
