// Nothing in the app writes to the console: a log line is somewhere a token, a password or a title could end up.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('the app', () => {
  it('has no console call and no other storage than the credential store', () => {
    const files = sources(path.join(__dirname, '..', 'src'));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((file) =>
      /\bconsole\s*\.|from '(@react-native-async-storage\/[^']*|expo-file-system[^']*|expo-sqlite[^']*)'|\blocalStorage\./.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => path.relative(path.join(__dirname, '..'), file))).toEqual([]);
    const pkg = require('../package.json') as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).filter((name) => /async-storage|file-system|sqlite|mmkv/.test(name))).toEqual([]);
  });

  it('never signs in by user ID', () => {
    const files = sources(path.join(__dirname, '..', 'src'));
    const offenders = files.filter((file) => /\/Users\/\$\{[^}]*\}\/Authenticate|\/Authenticate['"`]/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
