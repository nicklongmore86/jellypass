// The only failures the app tells apart. Each is a fixed kind the screens give fixed wording of their own: a body,
// an upstream message or a status line is never shown. An ApiError carries no URL, token or answer text, so logging
// one (or crashing with one) can leak nothing.

export type ApiErrorKind =
  /** 400: the call was not one the API takes. */
  | 'invalid_request'
  /** 401: the token is no longer good; drop it and show the profile picker. */
  | 'unauthorized'
  /** 404: an unknown title or path, or (with `householdNotFound`) an address no household has. */
  | 'not_found'
  /** 409: hiding one more title past the caller's 2,000 (`hidden_limit_reached`); unhiding some makes room. */
  | 'hidden_limit_reached'
  /** 429: stop, and offer a retry (with `retryAfterSeconds` when the server said); never retry by itself. */
  | 'too_many_requests'
  /** 502, or any status the contract does not list. */
  | 'unavailable'
  /** No answer: offline, the connection failed, or the call timed out (`timedOut`). */
  | 'network'
  /** A success whose body is not the documented shape, or an answer from somewhere other than the household. */
  | 'unexpected';

export interface ApiErrorDetails {
  status?: number;
  householdNotFound?: boolean;
  retryAfterSeconds?: number;
  timedOut?: boolean;
}

export class ApiError extends Error {
  public readonly kind: ApiErrorKind;
  /** The HTTP status, when there was an answer. */
  public readonly status: number | undefined;
  /** 404 `household_not_found`: the household was removed, or the address is mistyped. */
  public readonly householdNotFound: boolean;
  /** 429 with a usable `Retry-After`, in whole seconds. */
  public readonly retryAfterSeconds: number | undefined;
  public readonly timedOut: boolean;

  public constructor(kind: ApiErrorKind, details: ApiErrorDetails = {}) {
    super(kind);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = details.status;
    this.householdNotFound = details.householdNotFound ?? false;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.timedOut = details.timedOut ?? false;
  }
}

/** The kind for an error status, by the status alone: an unknown error code is treated by its status. */
export function kindOfStatus(status: number): ApiErrorKind {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'unauthorized';
    case 404:
      return 'not_found';
    case 409:
      return 'hidden_limit_reached';
    case 429:
      return 'too_many_requests';
    default:
      return 'unavailable';
  }
}

/** The longest `Retry-After` taken at its word; a longer one is capped. */
const MAX_RETRY_AFTER_SECONDS = 3600;

/** A `Retry-After` header (seconds, or an HTTP date) in whole seconds from `now`, or undefined if it is not one. */
export function retryAfterSeconds(header: string | null | undefined, now: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  let seconds: number;
  if (/^\d+$/.test(value)) seconds = Number(value);
  else {
    // An HTTP date in the one form servers send (IMF-fixdate); Date.parse alone takes "-5" for a year.
    if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
    const at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER_SECONDS);
}

/** The error a non-2xx answer stands for. `body` is the parsed answer, or undefined when it was not JSON. */
export function errorForAnswer(status: number, body: unknown, retryAfter: string | null, now: number): ApiError {
  const kind = kindOfStatus(status);
  const code = typeof body === 'object' && body !== null && Object.hasOwn(body, 'error') ? (body as { error: unknown }).error : undefined;
  return new ApiError(kind, {
    status,
    householdNotFound: kind === 'not_found' && code === 'household_not_found',
    ...(kind === 'too_many_requests' ? { retryAfterSeconds: retryAfterSeconds(retryAfter, now) } : {}),
  });
}

/** Whether `error` is a call the caller cancelled (its AbortSignal), which is never an ApiError. */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}
