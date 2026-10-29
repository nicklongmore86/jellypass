import type { DiscoverCard, HouseholdState } from './api.js';
import { badgeOf, STATE_LABELS } from './discover-model.js';
import { JELLYFIN_CLASSES } from './jellyfin-web.js';
import { FOCUS_ATTR } from './page-host.js';

/**
 * What the Discover page (discover.ts) and the service and studio pages (discover-source.ts) share: a title card in Jellyfin
 * web's own markup with the household's state on it in words, and the images that are set only while the part of the page
 * holding them is near the screen (docs/tv-addon.md, "The Discover page"). Nothing here reads a session, makes a call or
 * handles a key; every string is set as text and every image URL is one the API's reader has already checked.
 */

/** Images that are set only while the element holding them is near the screen. */
export interface Unit {
  element: Element;
  images: Array<{ image: HTMLImageElement; url: string }>;
  near: boolean;
}

/** A card drawn: its title, its button and the badge on it. */
export interface Drawn {
  card: DiscoverCard;
  button: HTMLElement;
  badge: HTMLElement;
}

/** Sets the images of what is near the screen, and takes them from what is not (their boxes keep their size). */
export function setNear(unit: Unit, on: boolean): void {
  unit.near = on;
  for (const one of unit.images) {
    if (on) {
      if (one.image.getAttribute('src') !== one.url) one.image.setAttribute('src', one.url);
    } else if (one.image.hasAttribute('src')) {
      one.image.removeAttribute('src');
    }
  }
}

/** An image for `unit`: set now only if the unit is near the screen. Never `loading="lazy"` (Chromium 63 has none). */
export function imageIn(document: Document, unit: Unit, className: string, url: string): HTMLImageElement {
  const image = document.createElement('img');
  image.className = className;
  image.setAttribute('alt', '');
  image.setAttribute('referrerpolicy', 'no-referrer');
  unit.images.push({ image, url });
  if (unit.near) image.setAttribute('src', url);
  return image;
}

/** A card's accessible name: the title, its year when it has one, and the state in words. */
export function cardLabel(card: DiscoverCard, state: HouseholdState): string {
  return card.year === null ? `${card.title}, ${STATE_LABELS[state]}` : `${card.title}, ${card.year}, ${STATE_LABELS[state]}`;
}

/** A card's badge and name, from its state now: the words are always there, and the colour goes with them. */
export function markCard(one: Drawn, state: HouseholdState): void {
  const badge = badgeOf(state);
  one.badge.textContent = badge.word;
  one.badge.className = `jellypass-tv-discover-badge jellypass-tv-discover-badge-${badge.tone}`;
  one.button.setAttribute('aria-label', cardLabel(one.card, state));
}

function element(document: Document, tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The sizes of Jellyfin web's cards the page draws, by the name its `cardBuilder` gives the shape: a scrolling row's poster
 * (`overflowPortrait`) or wide card (`overflowBackdrop`), and a wrapping grid's poster (`portrait`, a share of the grid's width).
 * Each has its card class and the class of its padder (the poster's 2:3 or the wide card's 16:9), so Jellyfin web's CSS sizes it.
 */
export type CardShape = 'overflowPortrait' | 'overflowBackdrop' | 'portrait';
const CARD_CLASS: Record<CardShape, string> = {
  overflowPortrait: JELLYFIN_CLASSES.card,
  overflowBackdrop: JELLYFIN_CLASSES.cardBackdrop,
  portrait: JELLYFIN_CLASSES.cardGrid,
};

/**
 * A card that is still being asked for: Jellyfin web's own card markup of the shape (so it takes the shape's size and leaves no
 * jump when the cards come), with only the padder's dark box showing.
 */
export function skeletonCard(document: Document, shape: CardShape): HTMLElement {
  const card = element(document, 'div', `${CARD_CLASS[shape]} jellypass-tv-discover-skeleton-card`);
  const box = element(document, 'div', 'cardBox cardBox-bottompadded');
  const frame = element(document, 'div', 'cardScalable');
  frame.appendChild(element(document, 'div', `cardPadder cardPadder-${shape}`));
  box.appendChild(frame);
  card.appendChild(box);
  return card;
}

/**
 * Jellyfin web's portrait or backdrop card as a button (the shared `jellypass-tv-card` focus ring), `key` being what Back
 * returns focus to. The caller binds its click (it checks the session first) and calls {@link markCard}.
 */
export function drawCard(document: Document, unit: Unit, options: { card: DiscoverCard; shape: CardShape; tv: boolean; key: string }): Drawn {
  const { card, shape, tv, key } = options;
  const backdrop = shape === 'overflowBackdrop';
  const button = element(document, 'button', `${CARD_CLASS[shape]} jellypass-tv-card${tv ? ` ${JELLYFIN_CLASSES.cardTv}` : ''}`) as HTMLButtonElement;
  button.type = 'button';
  button.setAttribute('data-media-type', card.mediaType);
  button.setAttribute('data-tmdb-id', String(card.tmdbId));
  button.setAttribute(FOCUS_ATTR, key);
  const box = element(document, 'div', 'cardBox cardBox-bottompadded');
  const frame = element(document, 'div', 'cardScalable');
  frame.appendChild(element(document, 'div', `cardPadder cardPadder-${shape}`));
  const picture = element(document, 'div', 'cardImageContainer coveredImage cardContent');
  const url = backdrop ? card.backdropUrl || card.posterUrl : card.posterUrl;
  if (url) picture.appendChild(imageIn(document, unit, 'jellypass-tv-card-image', url));
  frame.appendChild(picture);
  const badge = element(document, 'div', 'jellypass-tv-discover-badge');
  frame.appendChild(badge);
  box.appendChild(frame);
  box.appendChild(element(document, 'div', 'cardText cardTextCentered cardText-first jellypass-tv-card-title', card.title));
  if (card.year !== null) box.appendChild(element(document, 'div', 'cardText cardText-secondary cardTextCentered jellypass-tv-card-year', String(card.year)));
  button.appendChild(box);
  return { card, button, badge };
}
