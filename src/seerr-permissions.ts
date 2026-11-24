import { isSeerrUserId, normalizeJellyfinUserId, SeerrError, type SeerrClient, type SeerrUserId } from './seerr.js';

/**
 * Seerr's permission bits that the admin Users tab reads or writes, as Seerr 3.5.1 defines them
 * (`server/lib/permissions.ts`, compiled to `/app/dist/lib/permissions.js` in the image). Every other bit is kept as it
 * is: AUTO_REQUEST, MANAGE_*, the 4K bits and any bit a later Seerr adds.
 */
export const SEERR_PERMISSION = {
  ADMIN: 2,
  MANAGE_REQUESTS: 16,
  REQUEST: 32,
  AUTO_APPROVE: 128,
  AUTO_APPROVE_MOVIE: 256,
  AUTO_APPROVE_TV: 512,
  REQUEST_MOVIE: 262_144,
  REQUEST_TV: 524_288,
} as const;

const { ADMIN, MANAGE_REQUESTS, REQUEST, AUTO_APPROVE, AUTO_APPROVE_MOVIE, AUTO_APPROVE_TV, REQUEST_MOVIE, REQUEST_TV } = SEERR_PERMISSION;
const AUTO_APPROVE_BITS = AUTO_APPROVE | AUTO_APPROVE_MOVIE | AUTO_APPROVE_TV;
/** Seerr's owner account: Seerr refuses to change its permissions, and it is always an administrator. */
const SEERR_OWNER = 1;
const LOOKUPS_AT_ONCE = 4;

/**
 * What the Auto-approve switch shows: `on` (AUTO_APPROVE, or both kind bits), `off` (none of the three bits), or
 * `partial_movie` / `partial_tv` (only that kind's own bit, set in Seerr: shown as it is until the switch is changed).
 */
export type AutoApproveState = 'on' | 'off' | 'partial_movie' | 'partial_tv';

/** What the Users tab shows of a permission mask. */
export interface RequestPermissions {
  /** REQUEST: may request films and series (an administrator always may). */
  canRequest: boolean;
  /** Whether requests are approved at once; always `on` when {@link implicit}. */
  autoApprove: AutoApproveState;
  /** REQUEST_MOVIE and REQUEST_TV, set in Seerr itself and kept as they are: they allow one kind without REQUEST. */
  requestMovie: boolean;
  requestTv: boolean;
  /**
   * Why requests are approved at once whatever the auto-approve bits say: `admin` (ADMIN, or Seerr's owner) or
   * `manage_requests` (MANAGE_REQUESTS). Either way nothing is editable here: the admin site shows them read-only as
   * "Auto-approves (admin)", and they are changed in Seerr itself.
   */
  implicit?: 'admin' | 'manage_requests';
  /** What may be changed here. */
  editable: { canRequest: boolean; autoApprove: boolean };
}

/** A change to a mask: each field given is set, each left out kept. */
export interface RequestPermissionsChange {
  canRequest?: boolean;
  autoApprove?: boolean;
}

function autoApproveState(mask: number): AutoApproveState {
  const movie = (mask & AUTO_APPROVE_MOVIE) !== 0;
  const tv = (mask & AUTO_APPROVE_TV) !== 0;
  if ((mask & AUTO_APPROVE) !== 0 || (movie && tv)) return 'on';
  return movie ? 'partial_movie' : tv ? 'partial_tv' : 'off';
}

/** What a mask means for requests. `owner`: the mask is Seerr's owner's (user 1), read-only like an administrator's. */
export function requestPermissions(mask: number, { owner = false } = {}): RequestPermissions {
  const admin = owner || (mask & ADMIN) !== 0;
  const managesRequests = (mask & MANAGE_REQUESTS) !== 0;
  const implicit = admin ? 'admin' : managesRequests ? 'manage_requests' : undefined;
  return {
    canRequest: admin || (mask & REQUEST) !== 0,
    autoApprove: implicit !== undefined ? 'on' : autoApproveState(mask),
    requestMovie: (mask & REQUEST_MOVIE) !== 0,
    requestTv: (mask & REQUEST_TV) !== 0,
    ...(implicit ? { implicit } : {}),
    editable: { canRequest: implicit === undefined, autoApprove: implicit === undefined },
  };
}

/** A change this mask's holder may not have: answered `409` with `code`. */
export class PermissionsReadOnlyError extends Error {
  public constructor(message: string, public readonly code: 'seerr_admin_read_only') {
    super(message);
    this.name = 'PermissionsReadOnlyError';
  }
}

/**
 * The mask with `change` applied, touching only REQUEST and the three auto-approve bits. Auto-approve on sets
 * AUTO_APPROVE (a kind's own bit already set stays); off clears AUTO_APPROVE, AUTO_APPROVE_MOVIE and AUTO_APPROVE_TV, so
 * off is off for both kinds. Every other bit (4K, AUTO_REQUEST, MANAGE_*, unknown) is kept. Throws
 * {@link PermissionsReadOnlyError} for an administrator's mask (or the owner's) and for a MANAGE_REQUESTS mask, both of
 * which already approve every request and are read-only here.
 */
export function applyRequestPermissions(mask: number, change: RequestPermissionsChange, { owner = false } = {}): number {
  const current = requestPermissions(mask, { owner });
  if (current.implicit !== undefined) {
    throw new PermissionsReadOnlyError('Seerr administrators and users who manage requests are read-only here; change them in Seerr', 'seerr_admin_read_only');
  }
  let next = mask;
  if (change.canRequest !== undefined) next = change.canRequest ? next | REQUEST : next & ~REQUEST;
  if (change.autoApprove === true) next |= AUTO_APPROVE;
  if (change.autoApprove === false) next &= ~AUTO_APPROVE_BITS;
  // `&` and `|` answer signed 32-bit integers; masks are below 2^31 (see seerr.ts permissionMask), so this is a no-op.
  return next >>> 0;
}

/** A Seerr failure or refusal the admin API answers with `status` and a fixed `code`; `seerrStatus` is Seerr's own. */
export class SeerrPermissionsError extends Error {
  public constructor(message: string, public readonly status: number, public readonly code: string, public readonly seerrStatus?: number) {
    super(message);
    this.name = 'SeerrPermissionsError';
  }
}

/** One Jellyfin user in the listing, with the Seerr user Seerr links to it (`seerr: null`: not in Seerr). */
export interface PermissionsListingUser {
  jellyfinUserId: string;
  name: string;
  isJellyfinAdministrator: boolean;
  seerr: ({ id: number } & RequestPermissions) | null;
}

export interface SeerrPermissionsOptions {
  seerr: Pick<SeerrClient, 'linkedUserPermissions' | 'findUserByJellyfinId' | 'userPermissions' | 'setUserPermissions' | 'defaultPermissions' | 'setDefaultPermissions'>;
  /** Jellyfin's users, as the admin API lists them. */
  users: () => Promise<Array<{ id: string; name: string; isAdministrator: boolean }>>;
}

/**
 * Seerr's request and auto-approve permissions, for the admin Users tab (docs/server-reference.md, "Seerr request
 * permissions"). Every call is made with the admin key, never as a member. Each write reads the mask from Seerr just
 * before it, changes only its own bits (see {@link applyRequestPermissions}) and writes the whole mask back; writes run
 * one at a time, so two administrators' changes made through JellyPass never undo each other (a change made in Seerr's
 * own UI between the read and the write still can be: Seerr has no conditional write). A write that changes nothing is
 * not sent. Each change is logged at info level with the action, the Seerr user and the old and new mask.
 */
export class SeerrPermissions {
  readonly #seerr: SeerrPermissionsOptions['seerr'];
  readonly #users: SeerrPermissionsOptions['users'];
  #writes: Promise<unknown> = Promise.resolve();

  public constructor(options: SeerrPermissionsOptions) {
    this.#seerr = options.seerr;
    this.#users = options.users;
  }

  /**
   * Seerr's defaults for new users and every Jellyfin user with the Seerr user linked to it. Fails whole if Seerr cannot
   * be read for any of them: nothing is shown that Seerr did not say.
   */
  public async list(): Promise<{ defaults: RequestPermissions; users: PermissionsListingUser[] }> {
    const [defaults, jellyfinUsers] = await Promise.all([
      seerrCall('read', () => this.#seerr.defaultPermissions()),
      this.#users(),
    ]);
    const users: PermissionsListingUser[] = new Array(jellyfinUsers.length);
    let next = 0;
    const worker = async () => {
      while (next < jellyfinUsers.length) {
        const index = next++;
        const user = jellyfinUsers[index]!;
        const linked = await seerrCall('read', () => this.#seerr.linkedUserPermissions(user.id));
        users[index] = {
          jellyfinUserId: user.id,
          name: user.name,
          isJellyfinAdministrator: user.isAdministrator,
          seerr: linked ? { id: linked.id, ...requestPermissions(linked.permissions, { owner: linked.id === SEERR_OWNER }) } : null,
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, jellyfinUsers.length) }, worker));
    return { defaults: requestPermissions(defaults), users };
  }

  /** Seerr's defaults for new users alone (the create-user dialog shows them). */
  public async defaults(): Promise<{ defaults: RequestPermissions }> {
    return { defaults: requestPermissions(await seerrCall('read', () => this.#seerr.defaultPermissions())) };
  }

  /** Changes the request permissions of the Seerr user linked to a Jellyfin user. */
  public setUser(jellyfinUserId: string, change: RequestPermissionsChange): Promise<{ seerrUserId: number; changed: boolean; permissions: RequestPermissions }> {
    const normalized = normalizeJellyfinUserId(jellyfinUserId);
    if (!normalized) throw new Error('jellyfinUserId is invalid');
    return this.#serialized(async () => {
      const linked = await seerrCall('read', () => this.#seerr.findUserByJellyfinId(normalized));
      if (!linked || !isSeerrUserId(linked.id)) throw new SeerrPermissionsError('This Jellyfin user is not in Seerr', 404, 'not_in_seerr');
      const id: SeerrUserId = linked.id;
      const owner = id === SEERR_OWNER;
      const old = await seerrCall('read', () => this.#seerr.userPermissions(id));
      if (old === undefined) throw new SeerrPermissionsError('This Jellyfin user is not in Seerr', 404, 'not_in_seerr');
      const wanted = applyRequestPermissions(old, change, { owner });
      if (wanted === old) return { seerrUserId: id, changed: false, permissions: requestPermissions(old, { owner }) };
      const saved = await seerrCall('write', () => this.#seerr.setUserPermissions(id, wanted), { user: true });
      logChange('set_user_request_permissions', old, saved, id);
      if (saved !== wanted) throw new SeerrPermissionsError('Seerr saved other permissions than JellyPass sent', 502, 'seerr_unexpected_answer');
      return { seerrUserId: id, changed: true, permissions: requestPermissions(saved, { owner }) };
    });
  }

  /** Changes the request permissions Seerr gives users it creates or imports from now on (`defaultPermissions`). */
  public setDefaults(change: RequestPermissionsChange): Promise<{ changed: boolean; permissions: RequestPermissions }> {
    return this.#serialized(async () => {
      const old = await seerrCall('read', () => this.#seerr.defaultPermissions());
      const wanted = applyRequestPermissions(old, change);
      if (wanted === old) return { changed: false, permissions: requestPermissions(old) };
      const saved = await seerrCall('write', () => this.#seerr.setDefaultPermissions(wanted));
      logChange('set_default_request_permissions', old, saved);
      if (saved !== wanted) throw new SeerrPermissionsError('Seerr saved other permissions than JellyPass sent', 502, 'seerr_unexpected_answer');
      return { changed: true, permissions: requestPermissions(saved) };
    });
  }

  #serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(task, task);
    this.#writes = run.catch(() => undefined);
    return run;
  }
}

/** A body of `PUT /v1/seerr/permissions/...`: only the two booleans, at least one of them. */
export function permissionsChange(body: Record<string, unknown>): RequestPermissionsChange {
  const keys = Object.keys(body);
  const allowed = ['canRequest', 'autoApprove'];
  if (!keys.length || keys.some((key) => !allowed.includes(key))) throw new Error('body must contain only canRequest and/or autoApprove');
  if (keys.some((key) => typeof body[key] !== 'boolean')) throw new Error('canRequest and autoApprove must be booleans');
  return body as RequestPermissionsChange;
}

/** Runs a Seerr call, answering its failure as a {@link SeerrPermissionsError}: Seerr's status, never its body or key. */
async function seerrCall<T>(kind: 'read' | 'write', call: () => Promise<T>, { user = false } = {}): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SeerrPermissionsError) throw error;
    // SeerrError messages carry only the method, route template and status (see guardedSeerrJson); others are logged
    // by name only, as a network error's message may name the Seerr URL.
    console.error(JSON.stringify({
      level: 'error',
      message: `Seerr permissions ${kind} failed`,
      error: error instanceof SeerrError ? error.message : error instanceof Error ? error.name : 'unknown',
    }));
    if (!(error instanceof SeerrError)) throw new SeerrPermissionsError('Seerr could not be reached', 502, 'seerr_unavailable');
    const status = error.status;
    if (status === 401 || status === 403) {
      throw new SeerrPermissionsError(kind === 'write' ? `Seerr refused the change (${status})` : `Seerr refused JellyPass's API key (${status})`, 502, 'seerr_refused', status);
    }
    if (status === 404 && user) throw new SeerrPermissionsError('Seerr does not have that user any more', 404, 'not_in_seerr', status);
    throw new SeerrPermissionsError(`Seerr could not do that (it answered ${status})`, 502, 'seerr_failed', status);
  }
}

function logChange(action: string, old: number, saved: number, seerrUserId?: number): void {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Seerr request permissions changed',
    action,
    ...(seerrUserId !== undefined ? { seerrUserId } : {}),
    oldMask: old,
    newMask: saved,
    mask: `${old}→${saved}`,
  }));
}
