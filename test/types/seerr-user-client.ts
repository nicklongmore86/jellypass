// Compile-time checks, run by `pnpm check`: each @ts-expect-error fails the check if its line ever compiles.
import { SeerrClient, SeerrMemberClient, seerrUserId, type SeerrUserId } from '../../src/seerr.js';
import { SeerrUserMap } from '../../src/seerr-users.js';
import { TmdbClient } from '../../src/tmdb.js';

const admin = new SeerrClient('http://seerr.test', 'key');
const user: SeerrUserId = seerrUserId(2);
const map = new SeerrUserMap(admin);
const jellyfinUserId = '00000000000000000000000000000002';
const tmdb = new TmdbClient('f00dfeedf00dfeedf00dfeedf00dfeed');

new SeerrMemberClient(admin, jellyfinUserId);
void map.member(jellyfinUserId)?.quota();
void tmdb.movie(1);

// @ts-expect-error a Seerr user ID is only made by seerrUserId()
const forged: SeerrUserId = 2;
void forged;
// @ts-expect-error the admin client no longer makes a client fixed to a Seerr user
admin.asUser(user);
// @ts-expect-error nor does the map hand one out
void map.clientFor(jellyfinUserId);
// @ts-expect-error nor a client confirmed only once, when it was made
void map.verifiedClientFor(jellyfinUserId);
// @ts-expect-error a member client holds a Jellyfin user, not a Seerr user
new SeerrMemberClient(admin, user);
// @ts-expect-error and exposes no Seerr user to act as
void map.member(jellyfinUserId)?.userId;
// @ts-expect-error a member client reads only the member's own data, never titles
void map.member(jellyfinUserId)?.search('x');
// @ts-expect-error requests never name another user
void map.member(jellyfinUserId)?.createRequest({ mediaType: 'movie', tmdbId: 1, userId: 3 });
// @ts-expect-error there is no generic pass-through
void map.member(jellyfinUserId)?.relay('/api/v1/user');
// @ts-expect-error the catalogue client is gone: titles come from TMDB
void import('../../src/seerr.js').then((module) => new module.SeerrCatalogueClient(admin, user));
// @ts-expect-error TMDB reads no one's own data
void tmdb.quota();
// @ts-expect-error nor does it act as a Seerr user
new TmdbClient('f00dfeedf00dfeedf00dfeedf00dfeed', { user });
// @ts-expect-error nor relay arbitrary TMDB routes
void tmdb.get('/3/account');
// @ts-expect-error discover lists are fixed
void tmdb.discover('watchlist');
