// The one screen the app shows until it is signed in, by where it is in signing in (SessionProvider). A setup link
// waiting to be confirmed comes before everything but the start. Signed in, it hands over to the tabs
// (src/app/(tabs)), or to `signedIn` when given one (the sign-in tests, which run without the router).
import { router } from 'expo-router';
import { useEffect, type ReactNode } from 'react';

import type { Me } from '../api/types';
import { useSession } from '../session/SessionProvider';
import { Loading } from '../ui';
import { AddressScreen } from './AddressScreen';
import { ConfirmLinkScreen } from './ConfirmLinkScreen';
import { SignInScreen } from './SignInScreen';
import { StalledScreen } from './StalledScreen';

/**
 * On to the tabs. Back to them if they are under this screen (a setup link opened over them), so the stack never holds
 * two; in this screen's place otherwise.
 */
function ToTabs() {
  useEffect(() => {
    router.dismissTo('/home');
  }, []);
  return <Loading label="Loading…" />;
}

export function Root({ signedIn = () => <ToTabs /> }: { signedIn?: (me: Me) => ReactNode }) {
  const { phase, link } = useSession();
  if (phase.kind === 'starting') return <Loading label="Loading…" />;
  if (link) return <ConfirmLinkScreen offer={link} />;
  switch (phase.kind) {
    case 'address':
      return <AddressScreen />;
    case 'signin':
      return <SignInScreen key={phase.address.origin} address={phase.address} expired={phase.expired} />;
    case 'checking':
      return <Loading label="Loading…" />;
    case 'signedIn':
      return signedIn(phase.me);
    case 'stalled':
      return <StalledScreen key={phase.retryAt ?? 'now'} problem={phase.problem} retryAt={phase.retryAt} />;
    case 'signingOut':
      return <Loading label="Signing out…" />;
  }
}
