import type { IgnoredWebhook, SeerrWebhook } from './types.js';

const ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;
const NOTIFICATION_TYPE_PATTERN = /^[A-Z_]{1,64}$/;

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
  const tmdbId = media ? optionalPositiveIntegerAt(media, 'tmdbId') : undefined;
  const username = requestedBy ? optionalStringAt(requestedBy, 'username') : undefined;
  const userId = requestedBy ? optionalIdAt(requestedBy, 'jellyfinUserId') : undefined;

  const event: SeerrWebhook = {
    notificationType,
    ...(media ? { media: {
      ...(mediaId ? { jellyfinMediaId: mediaId } : {}),
      ...(mediaType ? { mediaType } : {}),
      ...(tmdbId !== undefined ? { tmdbId } : {}),
    } } : {}),
    request: {
      id: idAt(request, 'id'),
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

function optionalPositiveIntegerAt(parent: Record<string, unknown>, key: string): number | undefined {
  const value = parent[key];
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) <= 0) throw new Error(`${key} must be a positive integer`);
  return Number(number);
}
