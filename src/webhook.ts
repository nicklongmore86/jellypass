import type { IgnoredWebhook, SeerrWebhook } from './types.js';

const ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;
const NOTIFICATION_TYPE_PATTERN = /^[A-Z_]{1,64}$/;
// Seerr's MEDIA_AVAILABLE `{{event}}` texts: `[4K ]Movie|Series Request Now Available` when a request
// becomes available, `[4K ]Movie|Series Now Available` when a request is approved for media that is
// already available. Seerr has no template variable for a request's 4K flag or 4K Jellyfin media
// ID, so the event text is the only sign of which item became available.
const AVAILABLE_EVENT = /^(4K )?(Movie|Series)( Request)? Now Available$/;

export function parseWebhook(value: unknown): SeerrWebhook | IgnoredWebhook {
  if (!value || typeof value !== 'object') throw new Error('body must be a JSON object');
  const body = value as Record<string, unknown>;
  const notificationType = stringAt(body, 'notificationType');
  // An unfilled `{{notification_type}}` means the template is broken, not that the event is ignorable.
  if (!NOTIFICATION_TYPE_PATTERN.test(notificationType)) throw new Error('notificationType is invalid');
  // Only availability events grant access. Others, such as Seerr's TEST_NOTIFICATION, are
  // acknowledged without validating IDs that Seerr leaves empty for them.
  if (notificationType === 'TEST_NOTIFICATION') requireTemplate(body);
  if (notificationType !== 'MEDIA_AVAILABLE') return { notificationType };
  const request = objectAt(body, 'request');
  idAt(request, 'id');
  if (!('event' in body) || !('media' in body) || !('requestedBy' in request)) {
    throw new Error('webhook_payload_removed_use_current_seerr_template');
  }
  const media = objectAt(body, 'media');
  const requestedBy = objectAt(request, 'requestedBy');
  const mediaType = media ? optionalStringAt(media, 'mediaType') : undefined;
  const mediaId = media ? optionalIdAt(media, 'jellyfinMediaId') : undefined;
  const availableEvent = optionalStringAt(body, 'event');
  const eventMatch = availableEvent ? AVAILABLE_EVENT.exec(availableEvent) : null;
  const is4k = eventMatch ? eventMatch[1] !== undefined : undefined;
  const username = requestedBy ? optionalStringAt(requestedBy, 'username') : undefined;
  const userId = requestedBy ? optionalIdAt(requestedBy, 'jellyfinUserId') : undefined;

  const event: SeerrWebhook = {
    notificationType,
    ...(media ? { media: {
      ...(mediaId ? { jellyfinMediaId: mediaId } : {}),
      ...(mediaType ? { mediaType } : {}),
    } } : {}),
    request: {
      id: idAt(request, 'id'),
      ...(is4k !== undefined ? { is4k } : {}),
      ...(requestedBy ? { requestedBy: { ...(userId ? { jellyfinUserId: userId } : {}), ...(username ? { username } : {}) } } : {}),
    },
  };
  return event;
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(parent: Record<string, unknown>, key: string): string {
  const value = parent[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function optionalStringAt(parent: Record<string, unknown>, key: string): string | undefined {
  const value = parent[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function idAt(parent: Record<string, unknown>, key: string): string {
  const value = stringAt(parent, key);
  if (!ID_PATTERN.test(value) || value.includes('{{')) throw new Error(`${key} is invalid`);
  return value;
}

function optionalIdAt(parent: Record<string, unknown>, key: string): string | undefined {
  if (parent[key] === undefined || parent[key] === null || parent[key] === '') return undefined;
  return idAt(parent, key);
}

// Seerr v3.5.1 uses its configured JSON template for Test too, with empty ID values.
function requireTemplate(body: Record<string, unknown>): void {
  const request = body.request;
  const requestedBy = request && typeof request === 'object' ? (request as Record<string, unknown>).requestedBy : null;
  if (typeof body.event !== 'string' || !body.media || typeof body.media !== 'object' || Array.isArray(body.media)
    || !requestedBy || typeof requestedBy !== 'object' || Array.isArray(requestedBy)
    || typeof (requestedBy as Record<string, unknown>).jellyfinUserId !== 'string'
    || typeof (requestedBy as Record<string, unknown>).username !== 'string') {
    throw new Error('webhook_payload_removed_use_current_seerr_template');
  }
}
