// The first step: the member's own household address, typed or pasted. There is no list to pick from, and no
// address is suggested: a list would tell each household that the others exist.
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text } from 'react-native';

import { useSession } from '../session/SessionProvider';
import { readTypedAddress } from '../signin/address-input';
import { allowedUrls } from '../credits';
import { storeLink } from '../links';
import { ADDRESS_PROBLEM_TEXT, ADDRESS_TEXT } from '../signin/wording';
import { colors, layout, radii, typography } from '../theme';
import { Button, Field, Heading, Message, Page } from '../ui';

/** Opens the owner's configured "What is JellyPass?" page in the system browser, if it is one of the allowed links. */
export function openAbout(url: string): void {
  if (!allowedUrls().includes(url)) return;
  Linking.openURL(url).catch(() => {
    // No browser to open it in: nothing to do, and nothing to log.
  });
}

export function AddressScreen() {
  const { chooseAddress } = useSession();
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState('');

  const submit = () => {
    const reading = readTypedAddress(typed);
    if ('problem' in reading) {
      setMessage(ADDRESS_PROBLEM_TEXT[reading.problem]);
      return;
    }
    setMessage('');
    chooseAddress(reading.address);
  };

  const aboutUrl = storeLink('aboutUrl');
  return (
    <Page>
      <Heading title="Connect to your household" intro={ADDRESS_TEXT.intro} />
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
      <Text style={styles.about}>{ADDRESS_TEXT.about}</Text>
      {aboutUrl ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={ADDRESS_TEXT.learnMore}
          onPress={() => openAbout(aboutUrl)}
          style={({ pressed }) => [styles.link, pressed && styles.pressed]}
        >
          <Text style={styles.linkText}>{ADDRESS_TEXT.learnMore}</Text>
        </Pressable>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  about: { ...typography.body, color: colors.muted },
  link: { minHeight: layout.touchTarget, justifyContent: 'center', alignSelf: 'flex-start', borderRadius: radii.chip },
  linkText: { ...typography.body, color: colors.accentText, textDecorationLine: 'underline' },
  pressed: { opacity: 0.6 },
});
