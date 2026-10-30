import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(`${ROOT}${path}`, 'utf8');

// Every heading anchor the README had before its reference sections moved to
// docs/ (3.9.0, origin/main 3f3bc6c). Links to them exist outside this
// repository, so each must keep landing somewhere in README.md.
const ANCHORS_BEFORE_THE_MOVE = [
  'jellypass', 'what-it-does', 'how-access-enforcement-works', 'catalog-items-are-not-grants',
  'household-scoped-request-grants', 'requirements', 'supported-jellyfin-versions', 'quick-start-with-docker-compose',
  'build-locally-instead', 'configuration', 'request-backfill', 'network-addresses', 'running-behind-a-reverse-proxy',
  'chains-of-proxies-and-cdns', 'cdns-and-html-pages', 'login-lockouts-are-best-effort', 'forwarding-to-jellyfin',
  'configure-seerr', 'administrator-ui', 'household-jellyfin-urls', 'add-to-my-library', 'household-app-api',
  'get-this', 'household-app-pwa', 'operations', 'health-and-logs', 'administrative-api-examples',
  'backup-and-restore', 'upgrade', 'troubleshooting', 'a-new-download-appears-in-library-but-not-grants',
  'webhooks-never-arrive', 'webhook-returns-401', 'webhook-reports-missing-jellyfin-ids', 'library-is-empty-or-stale',
  'a-household-hostname-returns-404', 'a-re-imported-title-is-public-or-a-grant-is-orphaned',
  'changes-do-not-reach-every-user', 'api-reference', 'security-and-privacy', 'limitations', 'development',
  'releases-and-free-distribution', 'license',
];

// GitHub's heading slug: lower case, punctuation other than hyphens dropped,
// spaces to hyphens; a repeated slug gets -1, -2, ...
function githubSlug(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

// The anchors a Markdown file offers on GitHub: its headings' slugs (outside
// code fences) and explicit <a id> / <a name> anchors.
function anchors(markdown) {
  const counts = new Map();
  const found = new Set();
  let fence = null;
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence) continue;
    for (const match of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) found.add(match[1]);
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const slug = githubSlug(heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, ''));
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    found.add(count ? `${slug}-${count}` : slug);
  }
  return found;
}

describe('README anchors', () => {
  const readme = read('README.md');
  const readmeAnchors = anchors(readme);

  it('keeps every anchor the README had before the reference moved to docs/', () => {
    const missing = ANCHORS_BEFORE_THE_MOVE.filter((anchor) => !readmeAnchors.has(anchor));
    assert.deepEqual(missing, []);
  });

  it('links only to anchors that exist, in README.md and the docs it links to', () => {
    const broken = [];
    for (const [, target, anchor] of readme.matchAll(/\]\((?!https?:)([^)#\s]*)#([^)\s]+)\)/g)) {
      const file = target || 'README.md';
      if (!anchors(read(file)).has(anchor)) broken.push(`${file}#${anchor}`);
    }
    assert.deepEqual(broken, []);
  });

  it('computes GitHub heading slugs', () => {
    assert.deepEqual([...anchors('# Webhook returns `401`\n## A re-imported title\n## Upgrade\n## Upgrade\n```\n# not a heading\n```')],
      ['webhook-returns-401', 'a-re-imported-title', 'upgrade', 'upgrade-1']);
    assert.ok(anchors('- <a name="configure-seerr"></a>[Configure Seerr](x.md#configure-seerr)').has('configure-seerr'));
  });
});
