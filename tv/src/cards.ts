import type { Card, HouseholdState } from './api.js';
import { HIDDEN_TEXT } from './hidden-model.js';
import { JELLYFIN_CLASSES, listClasses } from './jellyfin-web.js';

/**
 * The "Discover" section both rows draw, one component so Home and Search look and move alike: a Jellyfin web section
 * (`verticalSection`) with its heading, and a strip of its own portrait cards, as `cardBuilder` writes them. Everything
 * shown is a fixed string or a DTO field set with `textContent`; no HTML is parsed, and a poster is only ever a TMDB
 * URL (api.ts checks it). It runs no navigation of its own: Jellyfin web's focus manager moves between the cards.
 */

/** The coarse statuses, worded as the household app words them. */
export const STATE_LABELS: Record<HouseholdState, string> = {
  in_library: 'Ready to watch',
  get_this: 'Available to get',
  unavailable: "Can't request",
  requested: 'Requested',
};

export const ROW_TEXT = {
  heading: 'Discover',
  requests: 'My requests',
} as const;

/** On the strip's link card (Home's "My requests"), which is not a title. */
export const LINK_ATTRIBUTE = 'data-jellypass-tv-link';

/** A drawn card, with what its status is drawn from. */
export interface Drawn {
  card: Card;
  button: HTMLElement;
}

export interface DrawOptions {
  /** The attribute that marks the section (one of ours), so the row that drew it can find it again. */
  attribute: string;
  /** A card's status, as the "Get this" overlay has it. */
  state: (card: Card) => HouseholdState;
  /** Whether a card is one the member hid: it says so, in words, under its title (Search keeps such titles). */
  hidden?: (card: Card) => boolean;
  /** A card was chosen. */
  choose: (card: Card) => void;
  /** A last card in the strip that is a link, not a title (Home's "My requests"): not one of the drawn cards. */
  link?: { label: string; open: () => void };
}

/** A card's accessible name: the title, the year and the status, said once. */
export function cardLabel(card: Card, state: HouseholdState, hidden = false): string {
  const label = hidden ? `${STATE_LABELS[state]}, ${HIDDEN_TEXT.tag}` : STATE_LABELS[state];
  return card.year === null ? `${card.title}, ${label}` : `${card.title}, ${card.year}, ${label}`;
}

export function drawCards(document: Document, cards: Card[], options: DrawOptions): { section: Element; drawn: Drawn[] } {
  const element = (tag: string, className: string, text?: string): HTMLElement => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const section = element('div', `${JELLYFIN_CLASSES.section} jellypass-tv-row`);
  section.setAttribute(options.attribute, '');
  const headingContainer = element('div', JELLYFIN_CLASSES.headingContainer);
  headingContainer.appendChild(element('h2', JELLYFIN_CLASSES.heading, ROW_TEXT.heading));
  section.appendChild(headingContainer);
  const scroller = element('div', 'jellypass-tv-row-scroller padded-left padded-right');
  // Not `itemsContainer`: Jellyfin web's pages call `.pause()` on every element with that class when they are left, and
  // that is a method of its own custom element, which this plain `div` is not (the page would fail with a TypeError).
  // Jellyfin web's TV layout draws its cards with a focus ring and a focus zoom (its CSS keys on `show-focus show-animation`)
  // and sizes them by the list's `itemsContainer-tv`.
  const tv = document.documentElement.classList.contains('layout-tv');
  const list = element('div', listClasses(`jellypass-tv-row-list ${JELLYFIN_CLASSES.row}`, tv));
  const drawn: Drawn[] = [];
  for (const card of cards) {
    const button = element('button', `${JELLYFIN_CLASSES.card} jellypass-tv-card${tv ? ` ${JELLYFIN_CLASSES.cardTv}` : ''}`) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute('data-media-type', card.mediaType);
    button.setAttribute('data-tmdb-id', String(card.tmdbId));
    const hidden = options.hidden !== undefined && options.hidden(card);
    button.setAttribute('aria-label', cardLabel(card, options.state(card), hidden));
    const box = element('div', 'cardBox cardBox-bottompadded');
    const frame = element('div', 'cardScalable');
    frame.appendChild(element('div', 'cardPadder cardPadder-overflowPortrait'));
    const image = element('div', 'cardImageContainer coveredImage cardContent');
    if (card.posterUrl) {
      const poster = document.createElement('img');
      poster.className = 'jellypass-tv-card-image';
      poster.setAttribute('alt', '');
      poster.setAttribute('referrerpolicy', 'no-referrer');
      poster.setAttribute('src', card.posterUrl);
      image.appendChild(poster);
    }
    frame.appendChild(image);
    box.appendChild(frame);
    box.appendChild(element('div', 'cardText cardTextCentered cardText-first jellypass-tv-card-title', card.title));
    if (card.year !== null) box.appendChild(element('div', 'cardText cardText-secondary cardTextCentered jellypass-tv-card-year', String(card.year)));
    if (hidden) box.appendChild(element('div', 'cardText cardText-secondary cardTextCentered jellypass-tv-card-hidden', HIDDEN_TEXT.tag));
    button.appendChild(box);
    button.addEventListener('click', () => options.choose(card));
    drawn.push({ card, button });
    list.appendChild(button);
  }
  if (options.link) {
    const { label, open } = options.link;
    const button = element('button', `${JELLYFIN_CLASSES.card} jellypass-tv-card jellypass-tv-card-link${tv ? ` ${JELLYFIN_CLASSES.cardTv}` : ''}`) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute(LINK_ATTRIBUTE, '');
    button.setAttribute('aria-label', label);
    const box = element('div', 'cardBox cardBox-bottompadded');
    const frame = element('div', 'cardScalable');
    frame.appendChild(element('div', 'cardPadder cardPadder-overflowPortrait'));
    frame.appendChild(element('div', 'cardImageContainer coveredImage cardContent jellypass-tv-card-link-face', label));
    box.appendChild(frame);
    button.appendChild(box);
    button.addEventListener('click', open);
    list.appendChild(button);
  }
  scroller.appendChild(list);
  section.appendChild(scroller);
  return { section, drawn };
}
