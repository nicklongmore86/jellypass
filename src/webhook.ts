import type { SeerrWebhook } from './types.js';

const ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;

export function parseWebhook(value: unknown): SeerrWebhook {
  if (!value || typeof value !== 'object') throw new Error('body must be a JSON object');
  const body = value as Record<string, unknown>;
  const request = objectAt(body, 'request');
  const media = optionalObjectAt(body, 'media');
  const requestedBy = optionalObjectAt(request, 'requestedBy');
  const mediaType = media ? optionalStringAt(media, 'mediaType') : undefined;
  const mediaId = media ? optionalIdAt(media, 'jellyfinMediaId') : undefined;
  const username = requestedBy ? optionalStringAt(requestedBy, 'username') : undefined;
  const userId = requestedBy ? optionalIdAt(requestedBy, 'jellyfinUserId') : undefined;

  const event: SeerrWebhook = {
    notificationType: stringAt(body, 'notificationType'),
    ...(media ? { media: { ...(mediaId ? { jellyfinMediaId: mediaId } : {}), ...(mediaType ? { mediaType } : {}) } } : {}),
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
