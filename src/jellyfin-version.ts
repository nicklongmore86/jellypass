/**
 * The Jellyfin releases JellyPass supports: the current release and the one before it, each tested in CI against the
 * images in scripts/jellyfin-versions.json. A version belongs to a release when its leading numbers are the release's:
 * every 10.11.x, and every 12.x (Jellyfin 12's minor releases are its bug-fix releases). Anything else, including any
 * build with a suffix (a pre-release or build metadata), is untested until an administrator confirms that exact version
 * (see JellyfinVersionGate).
 */
export const SUPPORTED_JELLYFIN_RELEASES: readonly string[] = ['10.11', '12'];

/**
 * What household hosts do on an untested version an administrator has not confirmed, or while the version is not known:
 * 'warn' keeps serving them as before and only warns (the log, the admin site, the admin API and metrics); 'refuse'
 * answers them a fixed 503. 3.x warns, since refusing would break requests that worked in 3.9.0; 4.0.0 sets 'refuse'.
 */
export type VersionEnforcement = 'warn' | 'refuse';
export const JELLYFIN_VERSION_ENFORCEMENT: VersionEnforcement = 'warn';

/** How often the version is read again once it is known; an upgrade is noticed within this. */
export const VERSION_CHECK_INTERVAL_MS = 5 * 60_000;
/** How often the version is read again while it is not known (Jellyfin unreachable, or not answering yet). */
export const VERSION_RETRY_INTERVAL_MS = 30_000;
/** The least time between two reads a household request starts while the version is not known. */
const ON_DEMAND_MIN_INTERVAL_MS = 5_000;
/** How long a household request waits for such a read before it is refused. */
const ON_DEMAND_WAIT_MS = 5_000;

/** The fixed answer household hosts give while they refuse to serve; it names nothing about the server. */
export const UNTESTED_VERSION_MESSAGE = 'This Jellyfin server runs a version JellyPass has not been tested with. '
  + 'Household access is paused until an administrator confirms it in JellyPass.\n';
export const UNKNOWN_VERSION_MESSAGE = 'JellyPass cannot read the Jellyfin version yet. Try again in a moment.\n';

export function isSupportedJellyfinVersion(version: string): boolean {
  if (!/^\d+(?:\.\d+)*$/.test(version)) return false;
  const parts = version.split('.').map(Number);
  return SUPPORTED_JELLYFIN_RELEASES.some((release) => release.split('.').map(Number).every((part, index) => parts[index] === part));
}

/** What household hosts do now: serve, refuse (an untested version not confirmed), or wait (version not known). Only
 * 'serve' while warning (see JELLYFIN_VERSION_ENFORCEMENT). */
export type HouseholdDecision = 'serve' | 'refuse' | 'unknown';

export interface JellyfinVersionStatus {
  /** The version Jellyfin last reported, or null while it is not known. */
  version: string | null;
  supported: boolean | null;
  /** The exact untested version an administrator allowed (stored in the state file), if any. */
  confirmedVersion: string | null;
  /** The exact untested version JELLYFIN_UNTESTED_VERSION_OK allows, if set. */
  environmentConfirmedVersion: string | null;
  /**
   * Whether the version needs and has a confirmation: 'not_needed' (supported), 'confirmed', or 'unconfirmed' (untested
   * and not confirmed, so it is warned about, or refused when enforcing); null while the version is not known.
   */
  confirmation: 'not_needed' | 'confirmed' | 'unconfirmed' | null;
  /** What household hosts do on an unconfirmed or unknown version (see JELLYFIN_VERSION_ENFORCEMENT). */
  enforcement: VersionEnforcement;
  householdHosts: 'serving' | 'refused' | 'waiting';
  supportedReleases: string[];
  /** When the version was last read successfully. */
  checkedAt: string | null;
  /** Why the last read failed, when it did. */
  error?: string;
}

export interface JellyfinVersionGateOptions {
  read: () => Promise<string>;
  /** JELLYFIN_UNTESTED_VERSION_OK: one exact untested version allowed without the admin site. */
  environmentConfirmed?: string;
  confirmation: { get(): string | undefined; set(version: string | undefined): Promise<void> };
  /** Defaults to JELLYFIN_VERSION_ENFORCEMENT. */
  enforcement?: VersionEnforcement;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export class VersionConfirmationError extends Error {}

/**
 * Reads Jellyfin's version at start and every VERSION_CHECK_INTERVAL_MS, and decides whether household hosts serve.
 * A supported version is served as before. An untested one is warned about once (each time the version changes) until
 * an administrator confirms that exact version, so an upgrade to another untested version asks again; household hosts
 * keep serving. When enforcing (enforcement 'refuse'), they are refused instead until it is confirmed, and refused too
 * while the version is not known (Jellyfin unreachable at start, or its last read failed): a household request then
 * reads it again (at most every five seconds, waiting up to five), and so does a retry every VERSION_RETRY_INTERVAL_MS,
 * so they serve as soon as Jellyfin answers. The admin site never waits on any of this.
 */
export class JellyfinVersionGate {
  readonly #read: () => Promise<string>;
  readonly #environmentConfirmed: string | undefined;
  readonly #confirmation: JellyfinVersionGateOptions['confirmation'];
  readonly #enforcement: VersionEnforcement;
  readonly #now: () => number;
  readonly #log: (entry: Record<string, unknown>) => void;
  #version: string | undefined;
  #checkedAt: number | undefined;
  #error: string | undefined;
  #reading: Promise<void> | undefined;
  #lastStarted = Number.NEGATIVE_INFINITY;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  /** The last version read, so each new one is logged once. */
  #lastRead: string | undefined;
  /** The last version a warning was logged for, so each untested version is logged once while it lasts. */
  #warned: string | undefined;

  public constructor(options: JellyfinVersionGateOptions) {
    this.#read = options.read;
    this.#environmentConfirmed = options.environmentConfirmed?.trim() || undefined;
    this.#confirmation = options.confirmation;
    this.#enforcement = options.enforcement ?? JELLYFIN_VERSION_ENFORCEMENT;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  }

  /** Reads the version now (sharing a read already in flight) and schedules the next read. Never rejects. */
  public check(): Promise<void> {
    if (this.#reading) return this.#reading;
    this.#lastStarted = this.#now();
    const reading = this.#read().then((version) => {
      if (version !== this.#lastRead) {
        this.#log({ level: 'info', message: 'read the Jellyfin version', version, supported: isSupportedJellyfinVersion(version) });
        this.#lastRead = version;
      }
      this.#version = version;
      this.#checkedAt = this.#now();
      this.#error = undefined;
      this.#report();
    }, (error: unknown) => {
      const known = this.#version;
      this.#version = undefined;
      this.#error = error instanceof Error ? error.message : String(error);
      this.#log({
        level: 'warn',
        message: this.#enforcement === 'refuse'
          ? 'could not read the Jellyfin version; household hosts refuse to serve until it is read'
          : 'could not read the Jellyfin version; household hosts keep serving, unchecked, until it is read',
        ...(known ? { lastVersion: known } : {}),
        detail: this.#error,
      });
    }).finally(() => {
      this.#reading = undefined;
      this.#schedule();
    });
    this.#reading = reading;
    return reading;
  }

  /** Stops the scheduled reads (shutdown). */
  public stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  public decision(): HouseholdDecision {
    return this.#enforcement === 'refuse' ? this.#verdict() : 'serve';
  }

  /**
   * The decision for a household request: while the version is not known, it is read again first (at most every five
   * seconds, sharing a read in flight) and waited for up to five seconds.
   */
  public async householdDecision(): Promise<HouseholdDecision> {
    const decision = this.decision();
    if (decision !== 'unknown') return decision;
    const reading = this.#reading ?? (this.#now() - this.#lastStarted >= ON_DEMAND_MIN_INTERVAL_MS ? this.check() : undefined);
    if (!reading) return 'unknown';
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([reading, new Promise<void>((resolve) => { timer = setTimeout(resolve, ON_DEMAND_WAIT_MS); })]);
    clearTimeout(timer);
    return this.decision();
  }

  public status(): JellyfinVersionStatus {
    const decision = this.decision();
    const version = this.#version;
    return {
      version: version ?? null,
      supported: version === undefined ? null : isSupportedJellyfinVersion(version),
      confirmedVersion: this.#confirmation.get() ?? null,
      environmentConfirmedVersion: this.#environmentConfirmed ?? null,
      confirmation: version === undefined ? null
        : isSupportedJellyfinVersion(version) ? 'not_needed' : this.#isConfirmed(version) ? 'confirmed' : 'unconfirmed',
      enforcement: this.#enforcement,
      householdHosts: decision === 'serve' ? 'serving' : decision === 'refuse' ? 'refused' : 'waiting',
      supportedReleases: [...SUPPORTED_JELLYFIN_RELEASES],
      checkedAt: this.#checkedAt === undefined ? null : new Date(this.#checkedAt).toISOString(),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  /**
   * Allows the untested version Jellyfin runs now, by its exact string; `version` must be that one, so a page that
   * still shows an earlier version cannot confirm a later one.
   */
  public async confirm(version: string): Promise<JellyfinVersionStatus> {
    if (this.#version === undefined) throw new VersionConfirmationError('jellyfin_version_unknown');
    if (version !== this.#version) throw new VersionConfirmationError('jellyfin_version_changed');
    if (isSupportedJellyfinVersion(version)) throw new VersionConfirmationError('jellyfin_version_supported');
    await this.#confirmation.set(version);
    this.#log({
      level: 'warn',
      message: this.#enforcement === 'refuse'
        ? 'an administrator confirmed an untested Jellyfin version; household hosts serve again'
        : 'an administrator confirmed an untested Jellyfin version',
      version,
    });
    this.#warned = undefined;
    return this.status();
  }

  /** Withdraws the stored confirmation; an untested version Jellyfin runs is warned about (or refused) again. */
  public async clearConfirmation(): Promise<JellyfinVersionStatus> {
    await this.#confirmation.set(undefined);
    this.#report();
    return this.status();
  }

  public renderMetrics(): string {
    const status = this.status();
    const lines = [
      '# HELP jfa_jellyfin_version_info The Jellyfin version last read, whether JellyPass supports it, and whether an administrator confirmed it.',
      '# TYPE jfa_jellyfin_version_info gauge',
      '# HELP jfa_jellyfin_version_supported 1 when the Jellyfin version is a supported release, 0 when it is not, -1 while it is not known.',
      '# TYPE jfa_jellyfin_version_supported gauge',
      '# HELP jfa_household_hosts_refusing 1 while household hosts refuse to serve (an untested Jellyfin version not confirmed, or its version not known).',
      '# TYPE jfa_household_hosts_refusing gauge',
    ];
    if (status.version !== null) {
      const confirmed = status.confirmation === 'not_needed' ? 'not_needed' : String(status.confirmation === 'confirmed');
      lines.push(`jfa_jellyfin_version_info{confirmed="${confirmed}",supported="${String(status.supported)}",version="${escapeLabel(status.version)}"} 1`);
    }
    lines.push(`jfa_jellyfin_version_supported ${status.supported === null ? -1 : status.supported ? 1 : 0}`);
    lines.push(`jfa_household_hosts_refusing ${status.householdHosts === 'serving' ? 0 : 1}`);
    return `${lines.join('\n')}\n`;
  }

  /** The decision when enforcing. */
  #verdict(): HouseholdDecision {
    if (this.#version === undefined) return 'unknown';
    return isSupportedJellyfinVersion(this.#version) || this.#isConfirmed(this.#version) ? 'serve' : 'refuse';
  }

  #isConfirmed(version: string): boolean {
    return version === this.#environmentConfirmed || version === this.#confirmation.get();
  }

  #report(): void {
    const version = this.#version;
    if (version === undefined || isSupportedJellyfinVersion(version)) {
      this.#warned = undefined;
      return;
    }
    if (this.#warned === version) return;
    this.#warned = version;
    const confirmed = this.#isConfirmed(version);
    this.#log({
      level: 'warn',
      message: confirmed
        ? 'Jellyfin runs a version JellyPass has not been tested with; an administrator confirmed it, so household hosts serve'
        : this.#enforcement === 'refuse'
          ? 'Jellyfin runs a version JellyPass has not been tested with; household hosts refuse to serve until an administrator confirms it in the admin site or sets JELLYFIN_UNTESTED_VERSION_OK to this exact version'
          : 'Jellyfin runs a version JellyPass has not been tested with; household hosts keep serving, but its household checks are unverified on it. Confirm it in the admin site or set JELLYFIN_UNTESTED_VERSION_OK to this exact version; JellyPass 4.0.0 refuses household requests on an unconfirmed version',
      version,
      supportedReleases: SUPPORTED_JELLYFIN_RELEASES,
    });
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.check(), this.#version === undefined ? VERSION_RETRY_INTERVAL_MS : VERSION_CHECK_INTERVAL_MS);
    this.#timer.unref();
  }
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}
