// The session's hidden titles (src/hidden/store.ts) and their words (src/hidden/text.ts) on their own: the latest mark
// wins over what an answer says, discovery lists leave out only what is marked hidden here, the toast follows each hide
// and goes with its own Undo, forget drops everything, and each failure has its one fixed message.
import { createHiddenTitles, type HideTarget } from '../src/hidden/store';
import { HIDE_TEXT, hideError, hideName, hiddenOnText, hideSubject, undoName, unhideName } from '../src/hidden/text';

const card = (mediaType: 'movie' | 'tv', tmdbId: number, hidden = false): HideTarget => ({ mediaType, tmdbId, title: `Title ${tmdbId}`, year: 2024, hidden });

describe('the hidden titles', () => {
  it("shows the server's word until the member chooses, then the latest choice whatever an answer says", () => {
    const titles = createHiddenTitles();
    expect(titles.isHidden(card('movie', 1, true))).toBe(true);
    expect(titles.isHidden(card('movie', 1))).toBe(false);
    titles.mark(card('movie', 1), true);
    expect(titles.isHidden(card('movie', 1, false))).toBe(true);
    // The same ID as a series is another title.
    expect(titles.isHidden(card('tv', 1))).toBe(false);
    titles.mark(card('movie', 1), false);
    expect(titles.isHidden(card('movie', 1, true))).toBe(false);
    expect(titles.card(card('movie', 1, true)).hidden).toBe(false);
    const same = card('movie', 2);
    expect(titles.card(same)).toBe(same);
  });

  it('leaves out of a discovery list only what was marked hidden here', () => {
    const titles = createHiddenTitles();
    const list = [card('movie', 1), card('tv', 2, true), card('movie', 3)];
    expect(titles.visible(list).map((item) => item.tmdbId)).toEqual([1, 2, 3]);
    titles.mark(card('movie', 3), true);
    titles.mark(card('tv', 2), false);
    expect(titles.visible(list).map((item) => item.tmdbId)).toEqual([1, 2]);
  });

  it('shows the toast for each hide, closes it on its own Undo only, and tells its listeners of every change', () => {
    const titles = createHiddenTitles();
    const listener = jest.fn();
    titles.subscribe(listener);
    titles.mark(card('movie', 1), true);
    const first = titles.toast();
    expect(first?.target).toEqual({ ...card('movie', 1), hidden: true });
    titles.mark(card('movie', 1), true);
    expect(titles.toast()!.id).toBeGreaterThan(first!.id);
    titles.mark(card('tv', 9), false);
    expect(titles.toast()?.target.tmdbId).toBe(1);
    titles.mark(card('movie', 1), false);
    expect(titles.toast()).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(4);
    const version = titles.version();
    titles.openMenu(card('movie', 5));
    expect(titles.menu()?.tmdbId).toBe(5);
    titles.closeMenu();
    expect(titles.menu()).toBeUndefined();
    expect(titles.version()).toBe(version + 2);
  });

  it('forgets every mark, the sheet and the toast', () => {
    const titles = createHiddenTitles();
    titles.mark(card('movie', 1), true);
    titles.openMenu(card('movie', 2));
    titles.forget();
    expect(titles.isHidden(card('movie', 1))).toBe(false);
    expect(titles.menu()).toBeUndefined();
    expect(titles.toast()).toBeUndefined();
    const listener = jest.fn();
    titles.subscribe(listener);
    titles.forget();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("hiding's words", () => {
  it('names a title with its kind and year, so two of a name are told apart', () => {
    expect(hideSubject({ title: 'Dune', year: 2021, mediaType: 'movie' })).toBe('Dune (Movie, 2021)');
    expect(hideSubject({ title: 'Dune', year: null, mediaType: 'tv' })).toBe('Dune (Series)');
    expect(hideSubject({ title: '', year: null, mediaType: 'tv' })).toBe('Series');
    const dune = { title: 'Dune', year: 2021, mediaType: 'movie' } as const;
    expect([hideName(dune), unhideName(dune), undoName(dune)]).toEqual(['Hide Dune (Movie, 2021) from Discover', 'Unhide Dune (Movie, 2021)', 'Undo hiding Dune (Movie, 2021)']);
  });

  it('has one fixed message per failure, the limit its own', () => {
    expect(hideError('hidden_limit_reached')).toBe('limit');
    expect(hideError('too_many_requests')).toBe('rate_limited');
    expect(hideError('network')).toBe('offline');
    for (const kind of ['unavailable', 'invalid_request', 'not_found', 'unexpected'] as const) expect(hideError(kind)).toBe('unavailable');
    expect(HIDE_TEXT.limit).toMatch(/2,000/);
  });

  it('says the day a title was hidden, or nothing for a time it cannot read', () => {
    expect(hiddenOnText('2026-10-30T12:00:00.000Z')).toMatch(/^Hidden on .*2026/);
    expect(hiddenOnText('not a time')).toBeUndefined();
  });

  it('never claims hiding cancels, deletes or downloads anything', () => {
    expect(HIDE_TEXT.note).toBe('Only for you in this household. It does not cancel requests or take anything out of your library.');
  });
});
