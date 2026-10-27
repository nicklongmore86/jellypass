import { FOCUS_ATTR, type PageContext, type PageView } from './page-host.js';

/**
 * `#/jellypass/about`: the first page on the page host, to show that a JellyPass page sits under Jellyfin web's own
 * header and Back button. Nothing links to it yet and it asks for nothing: the words are fixed.
 */
export const ABOUT_PATH = '/jellypass/about';
const TITLE = 'JellyPass';

export function renderAbout(context: PageContext): PageView {
  const { document, container } = context;
  const section = document.createElement('div');
  section.className = 'padded-left padded-right jellypass-tv-about';
  const heading = document.createElement('h1');
  heading.textContent = TITLE;
  const text = document.createElement('p');
  text.textContent = 'JellyPass is on for this household. Use Back to return.';
  // As Jellyfin web's own "page not found" offers a way home.
  const home = document.createElement('a');
  home.className = 'button-link';
  home.setAttribute('href', '#/home');
  home.setAttribute(FOCUS_ATTR, 'home');
  home.textContent = 'Home';
  section.appendChild(heading);
  section.appendChild(text);
  section.appendChild(home);
  container.appendChild(section);
  return { title: TITLE, focus: home };
}
