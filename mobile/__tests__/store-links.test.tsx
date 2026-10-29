// The store-readiness pieces of the app (mobile/README.md, "Distribution"): the privacy-policy, support and "What is
// JellyPass?" links come from the app config (`extra`), which ships the jellypass.app pages, and are hidden in a config
// that leaves one unset or not https (driven here through a test config); only those
// URLs and the credits' own can reach the system browser; About says the app is unofficial; the address screen says
// what the app is; and nobody is told a request "downloads" anything.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import config from '../app.config';
import { allowedUrls, JUSTWATCH_URL, TMDB_URL, UNOFFICIAL_TEXT } from '../src/credits';
import { cleanStoreUrl, storeLink, storeLinks } from '../src/links';
import { CANCEL_TEXT } from '../src/requests/text';
import { AddressScreen, openAbout } from '../src/screens/AddressScreen';
import { AccountScreen, openCredit } from '../src/screens/AccountScreen';
import { SessionProvider } from '../src/session/SessionProvider';
import { ADDRESS_TEXT } from '../src/signin/wording';
import { layout } from '../src/theme';
import { IDENTITY, METRICS, fakeGateway, fixture, settle, shows } from './support/household';

// What the app config says, swapped per test (`config.extra` for the shipped one); jest-expo's expo-constants has none
// of this repo's.
let mockExtra: Record<string, unknown> | undefined;
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { name: 'JellyPass', slug: 'jellypass', version: '1.2.1', extra: mockExtra };
    },
  },
}));

const PRIVACY = 'https://example.org/jellypass/privacy';
const SUPPORT = 'https://example.org/jellypass/support';
const ABOUT = 'https://example.org/jellypass/about';
const ALL = { privacyPolicyUrl: PRIVACY, supportUrl: SUPPORT, aboutUrl: ABOUT };

// The pages the app ships with (app.config.ts).
const SITE = { privacyPolicyUrl: 'https://jellypass.app/privacy/', supportUrl: 'https://jellypass.app/support/', aboutUrl: 'https://jellypass.app/' };
const shipped = () => config.extra as Record<string, unknown>;

const wrap = (child: React.ReactNode) => (
  <SafeAreaProvider initialMetrics={METRICS}>
    <SessionProvider deps={{ fetch: fakeGateway({}).fetch, identity: async () => IDENTITY }}>{child}</SessionProvider>
  </SafeAreaProvider>
);

// Not a plain https URL as written: padding, odd characters, other schemes, unnormalised forms.
const EDGE_CASES = [
  ` ${PRIVACY}`,
  `${PRIVACY} `,
  `\n${PRIVACY}\n`,
  `\t${PRIVACY}`,
  `\u00a0${PRIVACY}`,
  `${PRIVACY}\u00a0`,
  `https://example.org/\u200bprivacy`,
  `https://exam\u200bple.org/privacy`,
  `\ufeff${PRIVACY}`,
  `https://example.org/pri\u0000vacy`,
  `https://example.org\u0000/`,
  'https:example.org',
  'https:/example.org',
  'https:///example.org',
  'https:\\\\example.org',
  'javascript:alert(1)',
  'intent://example.org/#Intent;scheme=https;end',
  'HTTPS://example.org/privacy',
  'Https://example.org/privacy',
  'https://localhost/',
  'https://münchen.example/',
  'https://example.org:443/',
  'https://@example.org/',
  'https://example.org',
];

const link = (name: string) => screen.queryByRole('link', { name });
const minHeight = (name: string) => StyleSheet.flatten(link(name)!.props.style).minHeight;
const tap = (name: string) => fireEvent.press(link(name)!);

beforeEach(() => {
  mockExtra = undefined;
});

describe('the configured links', () => {
  it('ship as the jellypass.app pages, each in its exact normalised https form', () => {
    expect(config.extra).toMatchObject(SITE);
    for (const url of Object.values(SITE)) expect(cleanStoreUrl(url)).toBe(url);
    expect(storeLinks(shipped())).toEqual([SITE.privacyPolicyUrl, SITE.supportUrl, SITE.aboutUrl]);
  });

  it('are null while unset, empty, blank or missing', () => {
    for (const extra of [undefined, {}, { privacyPolicyUrl: '' }, { privacyPolicyUrl: '   ' }, { privacyPolicyUrl: 7 }]) {
      expect(storeLink('privacyPolicyUrl', extra)).toBeNull();
    }
    expect(storeLinks({})).toEqual([]);
  });

  it('accept only a plain https URL', () => {
    expect(cleanStoreUrl(PRIVACY)).toBe(PRIVACY);
    for (const bad of [
      'http://example.org/privacy',
      'javascript:alert(1)',
      'jellypass://connect?address=https://jelly-x.example.org',
      'file:///etc/passwd',
      'https://user:secret@example.org/',
      'https://example.org/a b',
      ...EDGE_CASES,
      'example.org/privacy',
      'https://',
      `https://example.org/${'a'.repeat(500)}`,
    ]) {
      expect(cleanStoreUrl(bad)).toBeNull();
    }
  });

  it('accept an IP literal host and a normalised path, query and port', () => {
    for (const ok of ['https://203.0.113.7/privacy', 'https://[2001:db8::1]/privacy', 'https://example.org:8443/a?b=c', 'https://xn--mnchen-3ya.example/']) {
      expect(cleanStoreUrl(ok)).toBe(ok);
    }
  });

  it('are read from the config, one key each', () => {
    expect([storeLink('privacyPolicyUrl', ALL), storeLink('supportUrl', ALL), storeLink('aboutUrl', ALL)]).toEqual([PRIVACY, SUPPORT, ABOUT]);
  });
});

describe('the allow-list', () => {
  let open: jest.SpyInstance;
  beforeEach(() => {
    open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  });
  afterEach(() => open.mockRestore());

  it('is the credits and the three jellypass.app pages as shipped', () => {
    expect(allowedUrls(shipped())).toEqual([TMDB_URL, JUSTWATCH_URL, SITE.privacyPolicyUrl, SITE.supportUrl, SITE.aboutUrl]);
  });

  it('is the credits alone while nothing is configured', () => {
    expect(allowedUrls({})).toEqual([TMDB_URL, JUSTWATCH_URL]);
  });

  it('adds exactly the configured https pages', () => {
    expect(allowedUrls({ ...ALL, supportUrl: 'http://example.org/insecure' })).toEqual([TMDB_URL, JUSTWATCH_URL, PRIVACY, ABOUT]);
  });

  it('opens a configured page, and still nothing else', () => {
    mockExtra = ALL;
    openCredit(PRIVACY);
    openAbout(ABOUT);
    openCredit('https://elsewhere.example.test/');
    openAbout('https://elsewhere.example.test/');
    openCredit(`${PRIVACY}?token=abc`);
    expect(open.mock.calls).toEqual([[PRIVACY], [ABOUT]]);
  });

  it('opens none of them while unset', () => {
    openCredit(PRIVACY);
    openAbout(ABOUT);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('About & credits', () => {
  const me = fixture('me') as unknown as Parameters<typeof AccountScreen>[0]['me'];

  it('says the app is an unofficial companion, not affiliated with Jellyfin or Seerr', async () => {
    await render(wrap(<AccountScreen me={me} />));
    expect(UNOFFICIAL_TEXT).toBe('Unofficial companion; not affiliated with Jellyfin or Seerr.');
    expect(shows(UNOFFICIAL_TEXT)).toBe(true);
  });

  it('shows Privacy policy and Support as shipped, opening the jellypass.app pages in the system browser', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    try {
      mockExtra = shipped();
      await render(wrap(<AccountScreen me={me} />));
      expect(minHeight('Privacy policy')).toBeGreaterThanOrEqual(layout.touchTarget);
      expect(minHeight('Support')).toBeGreaterThanOrEqual(layout.touchTarget);
      await tap('Privacy policy');
      await tap('Support');
      expect(open.mock.calls).toEqual([[SITE.privacyPolicyUrl], [SITE.supportUrl]]);
    } finally {
      open.mockRestore();
    }
  });

  it('hides Privacy policy and Support while unset', async () => {
    await render(wrap(<AccountScreen me={me} />));
    expect(link('Privacy policy')).toBeNull();
    expect(link('Support')).toBeNull();
  });

  it('shows each configured link on its own, 44 pt tall, and opens it in the system browser', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    try {
      mockExtra = { privacyPolicyUrl: PRIVACY };
      await render(wrap(<AccountScreen me={me} />));
      expect(link('Support')).toBeNull();
      expect(minHeight('Privacy policy')).toBeGreaterThanOrEqual(layout.touchTarget);
      await tap('Privacy policy');
      expect(open.mock.calls).toEqual([[PRIVACY]]);
    } finally {
      open.mockRestore();
    }
  });

  it('shows Support when it alone is configured, and hides a link that is not https', async () => {
    mockExtra = { supportUrl: SUPPORT, privacyPolicyUrl: 'http://example.org/privacy' };
    await render(wrap(<AccountScreen me={me} />));
    expect(link('Support')).not.toBeNull();
    expect(link('Privacy policy')).toBeNull();
  });
});

describe('the address screen', () => {
  it('shows "What is JellyPass?" as shipped, opening jellypass.app', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    try {
      mockExtra = shipped();
      await render(wrap(<AddressScreen />));
      await settle();
      await tap(ADDRESS_TEXT.learnMore);
      expect(open.mock.calls).toEqual([[SITE.aboutUrl]]);
    } finally {
      open.mockRestore();
    }
  });

  it('says what the app is, and hides "What is JellyPass?" while unset', async () => {
    await render(wrap(<AddressScreen />));
    await settle();
    expect(ADDRESS_TEXT.about).toContain('companion app for a JellyPass household server');
    expect(ADDRESS_TEXT.about).toContain('whoever runs your Jellyfin');
    expect(shows(ADDRESS_TEXT.about)).toBe(true);
    expect(link(ADDRESS_TEXT.learnMore)).toBeNull();
  });

  it('shows "What is JellyPass?" once configured: 44 pt tall, opening the configured page', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    try {
      mockExtra = { aboutUrl: ABOUT };
      await render(wrap(<AddressScreen />));
      await settle();
      expect(minHeight(ADDRESS_TEXT.learnMore)).toBeGreaterThanOrEqual(layout.touchTarget);
      await tap(ADDRESS_TEXT.learnMore);
      expect(open.mock.calls).toEqual([[ABOUT]]);
    } finally {
      open.mockRestore();
    }
  });

  it('lets its text scale with the member\'s font size', () => {
    const source = readFileSync(path.join(__dirname, '..', 'src', 'screens', 'AddressScreen.tsx'), 'utf8');
    expect(source).not.toMatch(/allowFontScaling=\{?false|maxFontSizeMultiplier/);
  });
});

describe('the words members read', () => {
  it('never say a request downloads anything', () => {
    expect(CANCEL_TEXT.body).toBe(
      "This withdraws your household's request. If it has already been approved, it may still be added to the server, but it won't be added for your household.",
    );
    const roots = [path.join(__dirname, '..', 'src')];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && /\b(download\w*|torrent\w*)\b/i.test(readFileSync(full, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''))) {
          offenders.push(path.relative(path.join(__dirname, '..'), full));
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
