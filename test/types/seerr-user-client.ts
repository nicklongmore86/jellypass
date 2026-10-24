// Compile-time checks, run by `pnpm check`: each @ts-expect-error fails the check if its line ever compiles.
import { SeerrCatalogueClient, SeerrClient, SeerrMemberClient, seerrUserId, type SeerrUserId } from '../../src/seerr.js';
import { SeerrUserMap } from '../../src/seerr-users.js';

const admin = new SeerrClient('http://seerr.test', 'key');
const user: SeerrUserId = seerrUserId(2);
const map = new SeerrUserMap(admin);
const jellyfinUserId = '00000000000000000000000000000002';

new SeerrCatalogueClient(admin, user);
new SeerrMemberClient(admin, jellyfinUserId);
void map.member(jellyfinUserId)?.quota();

// @ts-expect-error a catalogue client needs a Seerr user
new SeerrCatalogueClient(admin);
// @ts-expect-error a plain number is not a validated Seerr user ID
new SeerrCatalogueClient(admin, 2);
// @ts-expect-error nor is a string
new SeerrCatalogueClient(admin, '2');
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
// @ts-expect-error a member client reads only the member's own data, never the catalogue
void map.member(jellyfinUserId)?.search('x');
// @ts-expect-error the catalogue client reads no one's own data
void new SeerrCatalogueClient(admin, user).quota();
// @ts-expect-error nor makes requests
void new SeerrCatalogueClient(admin, user).createRequest({ mediaType: 'movie', tmdbId: 1 });
// @ts-expect-error requests never name another user
void map.member(jellyfinUserId)?.createRequest({ mediaType: 'movie', tmdbId: 1, userId: 3 });
// @ts-expect-error the catalogue user is fixed when the client is made
new SeerrCatalogueClient(admin, user).userId = seerrUserId(3);
// @ts-expect-error there is no generic pass-through
void map.member(jellyfinUserId)?.relay('/api/v1/user');
