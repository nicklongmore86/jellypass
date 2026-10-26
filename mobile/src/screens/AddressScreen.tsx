// The first step: the member's own household address, typed or pasted. There is no list to pick from, and no
// address is suggested: a list would tell each household that the others exist.
import { useState } from 'react';

import { useSession } from '../session/SessionProvider';
import { parseTypedAddress } from '../signin/address-input';
import { ADDRESS_TEXT } from '../signin/wording';
import { Button, Field, Heading, Message, Page } from '../ui';

export function AddressScreen() {
  const { chooseAddress } = useSession();
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState('');

  const submit = () => {
    const address = parseTypedAddress(typed);
    if (!address) {
      setMessage(ADDRESS_TEXT.invalid);
      return;
    }
    setMessage('');
    chooseAddress(address);
  };

  return (
    <Page>
      <Heading
        title="Connect to your household"
        intro="Enter your household's JellyPass address, or open the setup link your household sent you."
      />
      <Field
        label="Household address"
        value={typed}
        onChangeText={setTyped}
        onSubmitEditing={submit}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="url"
        keyboardType="url"
        textContentType="URL"
        returnKeyType="go"
        spellCheck={false}
        maxLength={300}
      />
      <Message text={message} />
      <Button label="Continue" onPress={submit} />
    </Page>
  );
}
