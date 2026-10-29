// `pnpm lint` covers the whole app, tests included: `expo lint` with no paths only lints src, app and components, so
// for a while nothing under __tests__ was linted. The script lints the package root, CI runs it, and a mistake in a
// test or support file is reported by the same config the app's source is.
import { readFileSync } from 'fs';
import { join } from 'path';

import { Linter } from 'eslint';

import config from '../eslint.config.js';

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { scripts: Record<string, string> };
const workflow = readFileSync(join(__dirname, '../../.github/workflows/mobile.yaml'), 'utf8');

// Hooks may only be called from components and hooks: an error in eslint-config-expo, whichever file it is in.
const BAD = "import { useState } from 'react';\nexport function run() {\n  return useState(0);\n}\n";

function lint(file: string) {
  return new Linter({ configType: 'flat', cwd: join(__dirname, '..') })
    .verify(BAD, config, join(__dirname, '..', file))
    .map((message) => message.ruleId ?? message.message);
}

describe('the lint script', () => {
  it('lints the package root with no warnings allowed', () => {
    expect(pkg.scripts.lint).toBe('eslint . --max-warnings 0');
    expect(pkg.scripts.check).toContain('pnpm lint');
  });

  it('runs in CI', () => {
    expect(workflow).toMatch(/^\s+- run: pnpm lint$/m);
  });

  it.each(['__tests__/bad.test.ts', '__tests__/bad.test.tsx', '__tests__/support/bad.ts', 'src/bad.ts', 'app.config.ts'])(
    'reports a mistake in %s',
    (file) => {
      expect(lint(file)).toContain('react-hooks/rules-of-hooks');
    },
  );

  it('leaves out build output and generated native code', () => {
    for (const file of ['dist/bad.js', '.expo/types/bad.ts', 'ios/bad.ts', 'android/bad.ts', 'coverage/bad.js']) {
      expect(lint(file)).toEqual([expect.stringMatching(/No matching configuration/)]);
    }
  });
});
