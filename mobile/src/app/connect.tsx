// `jellypass://connect?address=https://jelly-<household>.<domain>`: a household's setup link. It only offers the
// address (SessionProvider shows it for the member to confirm) and goes on to the one screen; it never signs anyone in.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { useSession } from '@/session/SessionProvider';
import { Loading } from '@/ui';

export default function Connect() {
  const { address } = useLocalSearchParams<{ address?: string | string[] }>();
  const { offerLink } = useSession();
  useEffect(() => {
    offerLink(address);
    router.replace('/');
  }, [address, offerLink]);
  return <Loading label="Loading…" />;
}
