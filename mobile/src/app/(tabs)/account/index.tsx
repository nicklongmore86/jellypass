import { AccountScreen } from '@/screens/AccountScreen';
import { useSession } from '@/session/SessionProvider';

export default function Account() {
  const { phase } = useSession();
  // The tabs are only ever shown signed in ((tabs)/_layout.tsx); on the way out this draws nothing.
  return phase.kind === 'signedIn' ? <AccountScreen me={phase.me} /> : null;
}
