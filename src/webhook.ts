import type { IgnoredWebhook, SeerrWebhook } from './types.js';

const ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;
const NOTIFICATION_TYPE_PATTERN = /^[A-Z_]{1,64}$/;
// Seerr's MEDIA_AVAILABLE `{{event}}` texts. Seerr has no template variable for a request's 4K flag
// or 4K Jellyfin media ID, so the event text is the only sign of which item became available.
const HD_AVAILABLE_EVENT = /^(Movie|Series) Request Now Available$/;
const UHD_AVAILABLE_EVENT = /^4K (Movie|Series) Request Now Available$/;

export function parseWebhook(value: unknown): SeerrWebhook | IgnoredWebhook {
  if (!value || typeof value !== 'object') throw new Error('body must be a JSON object');
  const body = value as Record<string, unknown>;
  const notificationType = stringAt(body, 'notificationType');
  // An unfilled `{{notification_type}}` means the template is broken, not that the event is ignorable.
  if (!NOTIFICATION_TYPE_PATTERN.test(notificationType)) throw new Error('notificationType is invalid');
  // Only availability events grant access. Others, such as Seerr's TEST_NOTIFICATION, are
  // acknowledged without validating IDs that Seerr leaves empty for them.
  if (notificationType !== 'MEDIA_AVAILABLE') return { notificationType };
  const request = objectAt(body, 'request');
  const media = optionalObjectAt(body, 'media');
  const requestedBy = optionalObjectAt(request, 'requestedBy');
  const mediaType = media ? optionalStringAt(media, 'mediaType') : undefined;
  const mediaId = media ? optionalIdAt(media, 'jellyfinMediaId') : undefined;
  const availableEvent = optionalStringAt(body, 'event');
  const is4k = availableEvent && UHD_AVAILABLE_EVENT.test(availableEvent) ? true
    : availableEvent && HD_AVAILABLE_EVENT.test(availableEvent) ? false
      : undefined;
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

function optionalObjectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (parent[key] === undefined || parent[key] === null) return undefined;
  return objectAt(parent, key);
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
