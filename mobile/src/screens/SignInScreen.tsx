// The PWA's sign-in (app/src/signin.ts), for one household address: its profile picker (the members the gateway lists,
// with a password step for members who have one and a single tap for members marked passwordless), and sign-in by name
// and password for a member the picker does not list (Jellyfin's hidden users), the first screen when it lists nobody.
// Sign-in is always by name (POST /Users/AuthenticateByName), never by a user's ID. Every message is fixed text.
//
// A 429 that says how long to wait (Retry-After) holds the buttons that would try again until then; the app never
// retries by itself.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { HouseholdAddress } from '../api/address';
import { useSession } from '../session/SessionProvider';
import { SignInError, type Profile, type SignInErrorKind } from '../signin/signin-api';
import { initials, SIGNIN_ERROR_TEXT, SIGNIN_NAME_TEXT } from '../signin/wording';
import { Body, Button, Field, Heading, Message, Page } from '../ui';
import { colors, layout, radii, spacing, typography } from '@/theme';

type Step =
  | { kind: 'loading' }
  | { kind: 'failed'; problem: SignInErrorKind }
  | { kind: 'picker' }
  | { kind: 'password'; profile: Profile }
  | { kind: 'name' };

function failureOf(error: unknown): SignInError {
  return error instanceof SignInError ? error : new SignInError('unavailable');
}

export function SignInScreen({ address, expired }: { address: HouseholdAddress; expired: boolean }) {
  const session = useSession();
  const { signInApi, completeSignIn, changeHousehold, epoch } = session;
  const [api] = useState(() => signInApi(address));
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const mounted = useRef(true);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(holdTimer.current);
    };
  }, []);

  /** Holds the retrying buttons for as long as a 429's Retry-After asked. */
  const hold = useCallback((failure: SignInError) => {
    const seconds = failure.kind === 'rate_limited' ? failure.retryAfterSeconds : undefined;
    if (!seconds) return;
    setHeld(true);
    clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      if (mounted.current) setHeld(false);
    }, seconds * 1000);
  }, []);

  /** Loads the profiles: the picker, the name step when it lists nobody, or the failure. */
  const load = useCallback(
    (signal?: AbortSignal) =>
      api.profiles(signal).then(
        (list) => {
          if (signal?.aborted || !mounted.current) return;
          setProfiles(list);
          setStep(list.length ? { kind: 'picker' } : { kind: 'name' });
        },
        (error: unknown) => {
          if (signal?.aborted || !mounted.current) return;
          const failure = failureOf(error);
          hold(failure);
          setStep({ kind: 'failed', problem: failure.kind });
        },
      ),
    [api, hold],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** Signs in; resolves to the failure, or undefined once the app has the sign-in (and has moved on). */
  async function attempt(username: string, secret: string): Promise<SignInError | undefined> {
    setBusy(true);
    setMessage('');
    // Where the app is as the sign-in goes out: if it has moved on by the answer, the sign-in is not kept.
    const sentAt = epoch();
    try {
      const result = await api.signIn(username, secret);
      await completeSignIn(address, result, sentAt);
      return undefined;
    } catch (error) {
      const failure = failureOf(error);
      if (mounted.current) hold(failure);
      return failure;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const blocked = busy || held;
  const intro = (signedOut: string, again: string) => (expired ? again : signedOut);
  const changeLink = <Button label="Change household" secondary disabled={busy} onPress={() => void changeHousehold()} />;
  const where = <Body>{address.host}</Body>;

  if (step.kind === 'loading') {
    return (
      <Page>
        <Heading title="Sign in" intro="Loading…" />
        {where}
      </Page>
    );
  }

  if (step.kind === 'failed') {
    return (
      <Page>
        <Heading title="Sign in" />
        {where}
        <Message text={SIGNIN_ERROR_TEXT[step.problem]} />
        <Button
          label="Try again"
          disabled={held}
          onPress={() => {
            setStep({ kind: 'loading' });
            void load();
          }}
        />
        {changeLink}
      </Page>
    );
  }

  if (step.kind === 'picker') {
    const choose = (profile: Profile) => {
      if (profile.hasPassword) {
        setPassword('');
        setMessage('');
        setStep({ kind: 'password', profile });
        return;
      }
      void attempt(profile.name, '').then((failure) => {
        if (!failure || !mounted.current) return;
        // A member who was passwordless and no longer is gets the password step rather than a dead end.
        if (failure.kind === 'invalid') {
          setPassword('');
          setStep({ kind: 'password', profile });
        }
        setMessage(SIGNIN_ERROR_TEXT[failure.kind]);
      });
    };
    return (
      <Page>
        <Heading
          title="Sign in"
          intro={intro('Choose your profile to sign in.', 'Your sign-in has expired. Choose your profile to sign in again.')}
        />
        {where}
        <View style={styles.profiles}>
          {profiles.map((profile) => (
            <Pressable
              key={profile.id}
              accessibilityRole="button"
              accessibilityLabel={profile.name}
              accessibilityState={{ disabled: blocked }}
              disabled={blocked}
              onPress={() => choose(profile)}
              style={({ pressed }) => [styles.profile, (pressed || blocked) && styles.dimmed]}
            >
              <View style={styles.avatar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Text style={styles.avatarText}>{initials(profile.name)}</Text>
              </View>
              <Text style={styles.profileName} numberOfLines={2}>
                {profile.name}
              </Text>
            </Pressable>
          ))}
        </View>
        <Message text={message} />
        {/* Jellyfin leaves hidden members off the list; they, and anyone who prefers to, sign in by name. */}
        <Button
          label="Sign in with a different name"
          secondary
          disabled={busy}
          onPress={() => {
            setName('');
            setPassword('');
            setMessage('');
            setStep({ kind: 'name' });
          }}
        />
        {changeLink}
      </Page>
    );
  }

  if (step.kind === 'password') {
    const { profile } = step;
    const submit = () => {
      if (blocked) return;
      // The field is emptied as it is read, so the password is held by nothing but the one call that sends it.
      const secret = password;
      setPassword('');
      if (!secret) {
        setMessage(SIGNIN_ERROR_TEXT.invalid);
        return;
      }
      void attempt(profile.name, secret).then((failure) => {
        if (failure && mounted.current) setMessage(SIGNIN_ERROR_TEXT[failure.kind]);
      });
    };
    return (
      <Page>
        <Heading title={`Sign in as ${profile.name}`} intro="Enter your Jellyfin password." />
        {where}
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          maxLength={256}
          autoFocus
        />
        <Message text={message} />
        <Button label={busy ? 'Signing in…' : 'Sign in'} disabled={blocked} onPress={submit} />
        <Button
          label="Choose another profile"
          secondary
          disabled={busy}
          onPress={() => {
            setPassword('');
            setMessage('');
            setStep({ kind: 'picker' });
          }}
        />
      </Page>
    );
  }

  const submitName = () => {
    if (blocked) return;
    const username = name.trim();
    const secret = password;
    setPassword('');
    if (!username) {
      setMessage(SIGNIN_NAME_TEXT.missing);
      return;
    }
    void attempt(username, secret).then((failure) => {
      if (failure && mounted.current) setMessage(failure.kind === 'invalid' ? SIGNIN_NAME_TEXT.invalid : SIGNIN_ERROR_TEXT[failure.kind]);
    });
  };
  return (
    <Page>
      <Heading
        title="Sign in"
        intro={intro('Enter your Jellyfin name and password.', 'Your sign-in has expired. Enter your name and password to sign in again.')}
      />
      {where}
      <Field
        label="Name"
        value={name}
        onChangeText={setName}
        autoComplete="username"
        textContentType="username"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="next"
        maxLength={256}
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        onSubmitEditing={submitName}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        maxLength={256}
      />
      <Message text={message} />
      <Button label={busy ? 'Signing in…' : 'Sign in'} disabled={blocked} onPress={submitName} />
      {profiles.length ? (
        <Button
          label="Choose a profile"
          secondary
          disabled={busy}
          onPress={() => {
            setPassword('');
            setMessage('');
            setStep({ kind: 'picker' });
          }}
        />
      ) : null}
      {changeLink}
    </Page>
  );
}

const styles = StyleSheet.create({
  profiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  profile: {
    width: 120,
    minHeight: layout.touchTarget,
    padding: spacing.md,
    gap: spacing.sm,
    alignItems: 'center',
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  dimmed: { opacity: 0.6 },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentTint,
  },
  avatarText: { ...typography.rowHeading, color: colors.text },
  profileName: { ...typography.label, color: colors.text, textAlign: 'center' },
});
