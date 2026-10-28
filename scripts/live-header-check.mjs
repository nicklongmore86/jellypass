#!/usr/bin/env node
/**
 * Live header check for the TV add-on's compass button (docs/tv-addon.md, "The Discover page", "Live header check").
 *
 * Runs the built add-on (dist/tv) in a headless Chromium against a REAL jellyfin/jellyfin:12.3 container, signed in, and
 * exercises Jellyfin web's desktop MUI toolbar re-rendering: moving between pages, resizing, replacing the toolbar, and
 * switching layouts. After each step it checks that there is exactly one compass button, immediately before Search, that
 * focus is where the member left it, and that Search still works. The household API is answered by a stub (the button
 * needs only the Jellyfin session). It prints one line per check and exits 1 if any fails.
 *
 *   JELLYFIN=http://127.0.0.1:18123 JF_USER=tester JF_PASS=tester-pass-1 \
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/path/to/chrome \
 *   node scripts/live-header-check.mjs
 *
 * playwright-core is not a dependency of this repository: point PLAYWRIGHT_CORE at an installed copy.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const JELLYFIN = process.env.JELLYFIN ?? 'http://127.0.0.1:18123';
const USER = process.env.JF_USER ?? 'tester';
const PASS = process.env.JF_PASS ?? 'tester-pass-1';
const CORE = process.env.PLAYWRIGHT_CORE;
const DIST = path.join(import.meta.dirname, '..', 'dist', 'tv');
const ENTRY = '[data-jellypass-tv-discover-entry]';
const BAR = 'header.MuiAppBar-root';
const SEARCH = `${BAR} a[aria-label="Search"][href="#/search"]`;

if (!CORE) {
  console.error('Set PLAYWRIGHT_CORE to an installed playwright-core directory.');
  process.exit(2);
}
const { chromium } = (await import(pathToFileURL(path.join(CORE, 'index.js')).href)).default;
const files = readdirSync(DIST);
const script = files.find((name) => name.endsWith('.js'));
const sheet = files.find((name) => name.endsWith('.css'));
if (!script || !sheet) throw new Error('run pnpm build first');

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

// The add-on's files, from this checkout, and a stub household API.
await page.route(`${JELLYFIN}/jellypass-tv/*`, (route) => {
  const name = path.basename(new URL(route.request().url()).pathname);
  const type = name.endsWith('.css') ? 'text/css' : 'text/javascript';
  route.fulfill({ status: 200, contentType: type, body: readFileSync(path.join(DIST, name)) });
});
await page.route(`${JELLYFIN}/jellypass/app/v1/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ page: 1, nextPage: null, results: [], networks: [], studios: [] }) }));

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` (${detail})`}`);
};
const settle = (ms = 400) => page.waitForTimeout(ms);

/** What the header holds: how many compass buttons, where, and what has focus. */
const state = () => page.evaluate(({ entry, bar, search }) => {
  const buttons = [...document.querySelectorAll(entry)];
  const link = document.querySelector(search);
  const active = document.activeElement;
  return {
    buttons: buttons.length,
    inBar: buttons.filter((button) => button.closest(bar)).length,
    beforeSearch: Boolean(link && buttons.length === 1 && buttons[0].nextElementSibling === link),
    focus: active && active !== document.body ? (active.matches(entry) ? 'compass' : active.getAttribute('aria-label') ?? active.tagName) : 'none',
    tv: document.documentElement.classList.contains('layout-tv'),
    hash: location.hash,
  };
}, { entry: ENTRY, bar: BAR, search: SEARCH });
const one = async (name) => {
  const now = await state();
  check(name, now.buttons === 1 && now.inBar === 1 && now.beforeSearch, JSON.stringify(now));
  return now;
};

// Sign in to Jellyfin web (the real one), then load the add-on as its Custom CSS/JS injection would.
await page.goto(`${JELLYFIN}/web/#/home`);
await page.waitForSelector('#txtManualName, #txtManualPassword, .btnManual', { state: 'attached', timeout: 30_000 });
const manual = await page.$('.btnManual');
if (manual && (await manual.isVisible())) await manual.click();
await page.fill('#txtManualName', USER);
await page.fill('#txtManualPassword', PASS);
await page.click('.manualLoginForm button[type=submit], form button[type=submit]');
await page.screenshot({ path: process.env.SHOT ?? '/dev/null' }).catch(() => {});
await page.waitForFunction(() => !location.hash.startsWith('#/login') && !location.hash.startsWith('#/selectserver'), null, { timeout: 30_000 });
await page.waitForSelector(SEARCH, { timeout: 30_000 });
await page.evaluate(({ src }) => {
  const el = document.createElement('script');
  el.setAttribute('data-jellypass-tv', '');
  el.src = src;
  document.head.appendChild(el);
}, { src: `${JELLYFIN}/jellypass-tv/${script}` });
await settle(800);

check('desktop layout (no layout-tv)', !(await state()).tv);
await one('signed in: one compass button, in the toolbar, before Search');

// 1. Pages: the toolbar re-renders as the route changes.
for (const hash of ['#/search', '#/mypreferencesmenu', '#/home', '#/jellypass/discover', '#/search', '#/home']) {
  await page.evaluate((to) => { location.hash = to; }, hash);
  await settle();
  await one(`navigated to ${hash}`);
}
await page.goBack();
await settle();
await one('after Back');

// 2. Resize: the toolbar changes its breakpoints.
for (const [width, height] of [[700, 900], [1920, 1080], [1280, 800]]) {
  await page.setViewportSize({ width, height });
  await settle();
  await one(`resized to ${width}x${height}`);
}

// 4. Focus is kept where the member left it, across a re-render.
await page.focus(ENTRY);
await page.evaluate(({ bar }) => { const header = document.querySelector(bar); header.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('resize')); }, { bar: BAR });
await settle();
check('focus on the compass button survives a resize', (await state()).focus === 'compass', JSON.stringify(await state()));
await page.focus(SEARCH);
await page.setViewportSize({ width: 900, height: 800 });
await settle();
await page.setViewportSize({ width: 1280, height: 800 });
await settle();
check('focus on Search survives a resize', (await state()).focus === 'Search', JSON.stringify(await state()));

await page.evaluate(() => { location.hash = '#/home'; });
await settle();
// 5. Search still works, and the compass opens Discover.
await page.click(SEARCH);
await settle();
const searching = await state();
check('Search opens the Search page', searching.hash === '#/search' && Boolean(await page.$('#searchTextInput')), JSON.stringify(searching));
await one('on the Search page');
await page.click(ENTRY);
await settle(800);
check('the compass opens Discover', (await state()).hash === '#/jellypass/discover' && Boolean(await page.$('[data-jellypass-tv-discover]')), JSON.stringify(await state()));
await one('on the Discover page');
await page.click(SEARCH);
await settle();
check('Search works from Discover', (await state()).hash === '#/search');

// 6. Layouts: Jellyfin web's TV layout draws the legacy header; the desktop layout its toolbar.
// Jellyfin web sets the layout once, at load: the class is toggled here, with a page change after it for the add-on to see.
const poke = () => page.evaluate(() => { const node = document.createElement('div'); document.body.appendChild(node); node.remove(); });
await page.evaluate(() => { document.documentElement.classList.add('layout-tv'); });
await poke();
await settle();
const tv = await state();
check('layout-tv: the button is drawn once, in the legacy header', tv.buttons === 1 && (await page.$$eval('.skinHeader [data-jellypass-tv-discover-entry]', (nodes) => nodes.length)) === 1, JSON.stringify(tv));
await page.evaluate(() => { document.documentElement.classList.remove('layout-tv'); });
await poke();
await page.evaluate(() => { location.hash = '#/home'; });
await settle(800);
await one('back to the desktop layout: one button, in the toolbar');

await page.evaluate(() => { location.hash = '#/home'; });
await settle(800);
// 7. Toolbar replacement (last: a copy is no longer React's, so it is not driven on): the whole header drawn again (a clone with our button in it, then a pristine copy without it).
await page.evaluate(({ bar }) => { const header = document.querySelector(bar); header.replaceWith(header.cloneNode(true)); }, { bar: BAR });
await settle();
await one('toolbar replaced by a copy that carried the button (no duplicate)');
await page.click(ENTRY);
await settle(800);
check('the compass of the replaced toolbar opens Discover, once', (await state()).hash === '#/jellypass/discover' && (await page.$$eval('[data-jellypass-tv-discover]', (nodes) => nodes.length)) === 1, JSON.stringify(await state()));
await page.evaluate(() => { location.hash = '#/home'; });
await settle(800);
await one('back home: still one compass');
await page.evaluate(({ bar, entry }) => {
  const header = document.querySelector(bar);
  const copy = header.cloneNode(true);
  for (const button of copy.querySelectorAll(entry)) button.remove();
  header.replaceWith(copy);
}, { bar: BAR, entry: ENTRY });
await settle();
await one('toolbar replaced by a pristine copy (button put back)');
await page.evaluate(({ bar, entry }) => {
  const header = document.querySelector(bar);
  const copy = header.cloneNode(true);
  for (const button of copy.querySelectorAll(entry)) button.remove();
  window.__pristineHeader = copy;
  header.remove();
}, { bar: BAR, entry: ENTRY });
await settle();
const gone = await state();
check('toolbar removed: no button anywhere (the hidden legacy header is not used)', gone.buttons === 0, JSON.stringify(gone));
await page.evaluate(() => { document.body.prepend(window.__pristineHeader); });
await settle(800);
await one('toolbar drawn again (a pristine copy): the button is back');

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
