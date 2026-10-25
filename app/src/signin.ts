import { SignInError, type Profile, type SignInApi, type SignInErrorKind } from './api.js';
import { nameForm, passwordForm, profilePicker, SIGNIN_ERROR_TEXT, SIGNIN_NAME_TEXT, signInUnavailable } from './render.js';
import { storeSignIn } from './session.js';

export interface SignInScreenOptions {
  doc: Document;
  api: SignInApi;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  origin: string;
  /** Replaces the screen; `busy` also marks it as loading. */
  show: (...nodes: Node[]) => void;
  announce: (message: string) => void;
  setTitle: (title: string) => void;
  /** Moves focus to the screen's heading (not on the very first screen, so the page's own focus is kept). */
  focusHeading: () => void;
  /** The sign-in is stored: show the app. */
  signedIn: () => void;
  /** False once the person has gone to another screen. */
  current: () => boolean;
  signal: AbortSignal;
}

/**
 * Jellyfin's own profile picker, inside the app: the household's members (the gateway lists only them on this host), a
 * password step for members who have one and a single tap for members marked passwordless; and sign-in by name and
 * password for a member the picker does not list (Jellyfin's hidden users), the first screen when it lists nobody. The sign-in is the same call
 * Jellyfin web makes, through the same gateway, so its household scoping and rate limits apply, and it is stored where
 * Jellyfin web keeps its own (see session.ts). Every message is fixed text.
 */
export async function showSignIn(options: SignInScreenOptions, expired: boolean): Promise<void> {
  const { doc, api, show, announce, setTitle } = options;
  let profiles: Profile[];
  setTitle('Sign in');
  announce('Loading…');
  try {
    profiles = await api.profiles(options.signal);
  } catch (error) {
    if (!options.current() || options.signal.aborted) return;
    announce('');
    show(signInUnavailable(doc, error instanceof SignInError ? error.kind : 'unavailable', () => void showSignIn(options, expired)));
    options.focusHeading();
    return;
  }
  if (!options.current()) return;
  announce('');
  let submitting = false;

  /** Signs in; resolves to the failure to show, or undefined once the app has been told. */
  async function attempt(username: string, password: string): Promise<SignInErrorKind | undefined> {
    if (submitting) return undefined;
    submitting = true;
    try {
      const result = await api.signIn(username, password);
      if (!options.current()) return undefined;
      const stored = storeSignIn(options.storage, options.origin, { serverId: result.serverId, userId: result.userId, token: result.token });
      if (!stored) return 'storage';
      announce('Signed in.');
      options.signedIn();
      return undefined;
    } catch (error) {
      return error instanceof SignInError ? error.kind : 'unavailable';
    } finally {
      submitting = false;
    }
  }

  function showPicker(): void {
    const picker = profilePicker(doc, profiles, {
      expired,
      onName: () => showName(),
      onChoose: (profile, button) => {
        if (profile.hasPassword) return showPassword(profile);
        picker.message.textContent = '';
        for (const other of picker.root.querySelectorAll<HTMLButtonElement>('button.profile')) other.disabled = true;
        announce('Signing in…');
        void attempt(profile.name, '').then((failure) => {
          if (!options.current() || !failure) return;
          announce('');
          // A member who was passwordless and no longer is gets the password step rather than a dead end.
          if (failure === 'invalid') return showPassword(profile, failure);
          for (const other of picker.root.querySelectorAll<HTMLButtonElement>('button.profile')) other.disabled = false;
          picker.message.textContent = SIGNIN_ERROR_TEXT[failure];
          button.focus();
        });
      },
    });
    show(picker.root);
    options.focusHeading();
  }

  function showPassword(profile: Profile, failure?: SignInErrorKind): void {
    const step = passwordForm(doc, profile, {
      onBack: showPicker,
      onSubmit: (password) => {
        if (!password) {
          step.message.textContent = SIGNIN_ERROR_TEXT.invalid;
          step.input.setAttribute('aria-invalid', 'true');
          step.input.focus();
          return;
        }
        step.message.textContent = '';
        step.input.removeAttribute('aria-invalid');
        step.submit.disabled = true;
        step.submit.textContent = 'Signing in…';
        announce('Signing in…');
        void attempt(profile.name, password).then((problem) => {
          if (!options.current()) return;
          step.input.value = '';
          if (!problem) return;
          announce('');
          step.submit.disabled = false;
          step.submit.textContent = 'Sign in';
          step.message.textContent = SIGNIN_ERROR_TEXT[problem];
          if (problem === 'invalid') step.input.setAttribute('aria-invalid', 'true');
          step.input.focus();
        });
      },
    });
    if (failure) step.message.textContent = SIGNIN_ERROR_TEXT[failure];
    show(step.root);
    options.focusHeading();
    step.input.focus();
  }

  /** `focusName` is false for the very first screen, so the page's own focus is kept. */
  function showName(focusName = true): void {
    const step = nameForm(doc, {
      expired,
      ...(profiles.length ? { onBack: showPicker } : {}),
      onSubmit: (typed, password) => {
        const username = typed.trim();
        if (!username) {
          step.message.textContent = SIGNIN_NAME_TEXT.missing;
          step.username.setAttribute('aria-invalid', 'true');
          step.username.focus();
          return;
        }
        step.message.textContent = '';
        step.username.removeAttribute('aria-invalid');
        step.input.removeAttribute('aria-invalid');
        step.submit.disabled = true;
        step.submit.textContent = 'Signing in…';
        announce('Signing in…');
        void attempt(username, password).then((problem) => {
          if (!options.current() || !problem) return;
          announce('');
          step.submit.disabled = false;
          step.submit.textContent = 'Sign in';
          step.message.textContent = problem === 'invalid' ? SIGNIN_NAME_TEXT.invalid : SIGNIN_ERROR_TEXT[problem];
          if (problem === 'invalid') {
            step.username.setAttribute('aria-invalid', 'true');
            step.input.setAttribute('aria-invalid', 'true');
          }
          step.input.focus();
        });
      },
    });
    show(step.root);
    options.focusHeading();
    if (focusName) step.username.focus();
  }

  if (profiles.length) showPicker();
  else showName(false);
}
