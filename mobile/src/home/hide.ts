// "New only" on Home and the network and studio pages (the TV add-on's chip, the same choices): on by default
// at every sign-in, kept only for the session. One store per signed-in session (SessionProvider), so a sign-out, a 401
// or any other sign-in (household, member or token) starts it on again. In memory only: never written to the device.
// Choosing it reads nothing; it only changes which of the cards already loaded are drawn.
import { useSyncExternalStore } from "react";

import type { Card } from "../api/types";

export interface HideStore {
  get(): boolean;
  set(hide: boolean): void;
  /** Back to the default: on. */
  reset(): void;
  subscribe(listener: () => void): () => void;
}

export function createHideStore(): HideStore {
  let hide = true;
  const listeners = new Set<() => void>();
  const change = (next: boolean) => {
    if (next === hide) return;
    hide = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => hide,
    set: change,
    reset: () => change(true),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export function useHideHeld(store: HideStore): boolean {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** What the member has: in the library, or asked for (by anyone in the household, or just now through the overlay). */
export function isHeld(card: Pick<Card, "state">): boolean {
  return card.state === "in_library" || card.state === "requested";
}

/** A row's cards with what the member has left out (all of them when `hide` is off). Cards must already be overlaid. */
export function visibleCards<T extends Pick<Card, "state">>(
  cards: readonly T[],
  hide: boolean,
): T[] {
  return hide ? cards.filter((card) => !isHeld(card)) : [...cards];
}

/**
 * The hero's slides from the first row's answer (cards already overlaid), at most `max`. Off: its first `max` titles.
 * On: those not held, with a wide picture to draw, the next ones filling the place of any left out.
 */
export function heroSlides<T extends Pick<Card, "state" | "backdropUrl">>(
  cards: readonly T[],
  hide: boolean,
  max: number,
): T[] {
  if (!hide) return cards.slice(0, max);
  return cards
    .filter((card) => !isHeld(card) && card.backdropUrl !== null)
    .slice(0, max);
}
