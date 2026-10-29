// The sign-in screens' fixed text. Failures use the PWA's wording (app/src/render.ts, SIGNIN_ERROR_TEXT and
// SIGNIN_NAME_TEXT): none of it says whether a name exists, and no answer's body, status or upstream message is shown.

import type { SignInErrorKind } from './signin-api';

export const SIGNIN_ERROR_TEXT: Record<SignInErrorKind, string> = {
  invalid: "That didn't work. Check your password and try again.",
  rate_limited: 'Too many attempts. Wait a few minutes, then try again.',
  unavailable: "Can't sign in right now. Try again in a moment.",
  offline: 'Check your connection, then try again.',
  // The app's own: the PWA is always on its household's address, so never meets these two.
  not_found: "There's no JellyPass household at this address. Check it, then try again.",
  storage: "Can't keep your sign-in on this device. Try again in a moment.",
};

/** The name form's own fixed text: its refusal cannot say whether the name or the password was wrong. */
export const SIGNIN_NAME_TEXT = {
  missing: 'Enter your name.',
  invalid: "That didn't work. Check your name and password and try again.",
} as const;

export const ADDRESS_TEXT = {
  /** What the app is, for a reviewer or anyone who installed it without a household. */
  about: 'JellyPass is a companion app for a JellyPass household server. You get the address from whoever runs your Jellyfin.',
  learnMore: 'What is JellyPass?',
  invalid: "That isn't a JellyPass household address. Check the one your household gave you, then try again.",
  badLink: "That link doesn't have a JellyPass household address in it.",
} as const;

/** Why a signed-in app could not check its sign-in at start (the sign-in is kept). */
export const STALLED_TEXT = {
  offline: 'Check your connection, then try again.',
  rate_limited: 'Too many requests. Wait a few minutes, then try again.',
  not_found: "There's no JellyPass household at this address any more.",
  unavailable: "Can't reach your household right now. Try again in a moment.",
} as const;

export type StalledKind = keyof typeof STALLED_TEXT;

/** Up to two letters for a profile's avatar: the first letter of the first two words. */
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();
  return letters || '?';
}
