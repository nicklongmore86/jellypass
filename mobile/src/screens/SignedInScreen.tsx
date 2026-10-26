// A placeholder for the signed-in app until its screens come (phase 3): who is signed in, to which household, and the
// way out.
import { useState } from 'react';

import type { Me } from '../api/types';
import { useSession } from '../session/SessionProvider';
import { Body, Button, Card, Heading, Page } from '../ui';

/** "name · household", as the PWA's Account card shows it. */
export function accountText(me: Pick<Me, 'name' | 'household'>): string {
  return [me.name, me.household].filter(Boolean).join(' · ');
}

export function SignedInScreen({ me }: { me: Me }) {
  const { signOut, changeHousehold } = useSession();
  const [busy, setBusy] = useState(false);
  const leave = (how: () => Promise<void>) => {
    setBusy(true);
    void how();
  };
  return (
    <Page>
      <Heading title="JellyPass" />
      <Card>
        <Body strong>{accountText(me)}</Body>
        <Body>{"You're signed in. Browsing your household's library comes in the next version of the app."}</Body>
      </Card>
      <Button label="Sign out" secondary disabled={busy} onPress={() => leave(signOut)} />
      <Button label="Change household" secondary disabled={busy} onPress={() => leave(changeHousehold)} />
    </Page>
  );
}
