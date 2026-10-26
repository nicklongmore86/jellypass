// A kept sign-in that could not be checked at start (no connection, the household busy or gone). The sign-in is
// kept: only a 401 drops it. After a 429 that said how long to wait (Retry-After), Try again is held until then; the
// app never retries by itself.
import { useEffect, useState } from 'react';

import { useSession } from '../session/SessionProvider';
import { STALLED_TEXT, type StalledKind } from '../signin/wording';
import { Button, Heading, Message, Page } from '../ui';

/** Shown afresh for each stall (Root keys it by `retryAt`), so the hold starts from that stall's Retry-After. */
export function StalledScreen({ problem, retryAt }: { problem: StalledKind; retryAt: number | undefined }) {
  const { retry, signOut, now } = useSession();
  const [held, setHeld] = useState(() => retryAt !== undefined && now() < retryAt);

  useEffect(() => {
    if (retryAt === undefined) return undefined;
    const timer = setTimeout(() => setHeld(false), Math.max(0, retryAt - now()));
    return () => clearTimeout(timer);
  }, [retryAt, now]);

  return (
    <Page>
      <Heading title="JellyPass" />
      <Message text={STALLED_TEXT[problem]} />
      <Button label="Try again" disabled={held} onPress={retry} />
      <Button label="Sign out" secondary onPress={() => void signOut()} />
    </Page>
  );
}
