// The one screen the app shows now, by where it is in signing in (SessionProvider). A setup link waiting to be
// confirmed comes before everything but the start.
import { useSession } from '../session/SessionProvider';
import { Loading } from '../ui';
import { AddressScreen } from './AddressScreen';
import { ConfirmLinkScreen } from './ConfirmLinkScreen';
import { SignedInScreen } from './SignedInScreen';
import { SignInScreen } from './SignInScreen';
import { StalledScreen } from './StalledScreen';

export function Root() {
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
      return <SignedInScreen me={phase.me} />;
    case 'stalled':
      return <StalledScreen key={phase.retryAt ?? 'now'} problem={phase.problem} retryAt={phase.retryAt} />;
    case 'signingOut':
      return <Loading label="Signing out…" />;
  }
}
