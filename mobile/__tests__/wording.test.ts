// The sign-in's fixed text: the PWA's failure wording, word for word, and the avatars' initials.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { initials, SIGNIN_ERROR_TEXT, SIGNIN_NAME_TEXT } from '../src/signin/wording';

describe('wording', () => {
  it("matches the PWA's sign-in failures", () => {
    const render = readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'render.ts'), 'utf8');
    for (const text of [
      SIGNIN_ERROR_TEXT.invalid,
      SIGNIN_ERROR_TEXT.rate_limited,
      SIGNIN_ERROR_TEXT.unavailable,
      SIGNIN_ERROR_TEXT.offline,
      SIGNIN_NAME_TEXT.missing,
      SIGNIN_NAME_TEXT.invalid,
    ]) {
      expect(render.includes(JSON.stringify(text)) || render.includes(`'${text}'`)).toBe(true);
    }
  });

  it.each([
    ['Ana Lima', 'AL'],
    ['ben', 'B'],
    ['  mary  ann  smith ', 'MA'],
    ['émile', 'É'],
    ['😀 Kid', '😀K'],
    ['   ', '?'],
  ])('gives %j the initials %j', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});
