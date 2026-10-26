// A setup link (`jellypass://connect?address=...`) is only ever an offer: the member sees the address and confirms it
// before the app uses it, and even then it only opens the profile picker. A link never signs anyone in.
import { useState } from 'react';

import type { LinkOffer } from '../session/SessionProvider';
import { useSession } from '../session/SessionProvider';
import { ADDRESS_TEXT } from '../signin/wording';
import { Body, Button, Card, Heading, Page } from '../ui';

export function ConfirmLinkScreen({ offer }: { offer: LinkOffer }) {
  const { acceptLink, dismissLink, phase, household } = useSession();
  const [busy, setBusy] = useState(false);
  const { address } = offer;

  if (!address) {
    return (
      <Page>
        <Heading title="Can't use this link" intro={ADDRESS_TEXT.badLink} />
        <Button label="OK" onPress={dismissLink} />
      </Page>
    );
  }
  const signedIn = phase.kind === 'signedIn' || phase.kind === 'stalled' || phase.kind === 'checking';
  return (
    <Page>
      <Heading title="Connect to this household?" intro="This link sets the app up for this household's address:" />
      <Card>
        <Body strong>{address.host}</Body>
      </Card>
      {signedIn && household ? (
        <Body>{`You're signed in to ${household.host}. Continuing signs you out of it first.`}</Body>
      ) : (
        <Body>{"Continue only if your household sent you this link. You'll choose your profile next."}</Body>
      )}
      <Button
        label="Continue"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void acceptLink();
        }}
      />
      <Button label="Cancel" secondary disabled={busy} onPress={dismissLink} />
    </Page>
  );
}
