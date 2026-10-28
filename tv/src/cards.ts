import type { Card, HouseholdState } from './api.js';
import { JELLYFIN_CLASSES } from './jellyfin-web.js';

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
} as const;

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
  /** A card was chosen. */
  choose: (card: Card) => void;
}

/** A card's accessible name: the title, the year and the status, said once. */
export function cardLabel(card: Card, state: HouseholdState): string {
  const label = STATE_LABELS[state];
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
  const list = element('div', `jellypass-tv-row-list ${JELLYFIN_CLASSES.row}`);
  // Jellyfin web's TV layout draws its cards with a focus ring and a focus zoom: its CSS keys on these two classes.
  const tv = document.documentElement.classList.contains('layout-tv');
  const drawn: Drawn[] = [];
  for (const card of cards) {
    const button = element('button', `${JELLYFIN_CLASSES.card} jellypass-tv-card${tv ? ` ${JELLYFIN_CLASSES.cardTv}` : ''}`) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute('data-media-type', card.mediaType);
    button.setAttribute('data-tmdb-id', String(card.tmdbId));
    button.setAttribute('aria-label', cardLabel(card, options.state(card)));
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
    button.appendChild(box);
    button.addEventListener('click', () => options.choose(card));
    drawn.push({ card, button });
    list.appendChild(button);
  }
  scroller.appendChild(list);
  section.appendChild(scroller);
  return { section, drawn };
}
