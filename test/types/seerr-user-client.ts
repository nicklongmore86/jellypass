// Compile-time checks, run by `pnpm check`: each @ts-expect-error fails the check if its line ever compiles.
import { SeerrClient, SeerrUserClient, seerrUserId, type SeerrUserId } from '../../src/seerr.js';

const admin = new SeerrClient('http://seerr.test', 'key');
const user: SeerrUserId = seerrUserId(2);

new SeerrUserClient('http://seerr.test', 'key', user);
admin.asUser(user);

// @ts-expect-error an acting-user client needs a Seerr user
new SeerrUserClient('http://seerr.test', 'key');
// @ts-expect-error a plain number is not a validated Seerr user ID
new SeerrUserClient('http://seerr.test', 'key', 2);
// @ts-expect-error nor is a string
new SeerrUserClient('http://seerr.test', 'key', '2');
// @ts-expect-error asUser needs a validated Seerr user ID
admin.asUser(2);
// @ts-expect-error asUser needs a Seerr user
admin.asUser();
// @ts-expect-error a Seerr user ID is only made by seerrUserId()
const forged: SeerrUserId = 2;
void forged;
// @ts-expect-error requests never name another user
user && admin.asUser(user).createRequest({ mediaType: 'movie', tmdbId: 1, userId: 3 });
// @ts-expect-error the acting user is fixed when the client is made
admin.asUser(user).userId = seerrUserId(3);
// @ts-expect-error there is no generic pass-through
admin.asUser(user).relay('/api/v1/user');
