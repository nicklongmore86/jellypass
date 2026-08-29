import type { SeerrWebhook } from './types.js';

const ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;

export function parseWebhook(value: unknown): SeerrWebhook {
  if (!value || typeof value !== 'object') throw new Error('body must be a JSON object');
  const body = value as Record<string, unknown>;
  const media = objectAt(body, 'media');
  const request = objectAt(body, 'request');
  const requestedBy = objectAt(request, 'requestedBy');
  const mediaType = optionalStringAt(media, 'mediaType');
  const username = optionalStringAt(requestedBy, 'username');

  const event: SeerrWebhook = {
    notificationType: stringAt(body, 'notificationType'),
    media: {
      jellyfinMediaId: idAt(media, 'jellyfinMediaId'),
      ...(mediaType ? { mediaType } : {}),
    },
    request: {
      id: idAt(request, 'id'),
      requestedBy: {
        jellyfinUserId: idAt(requestedBy, 'jellyfinUserId'),
        ...(username ? { username } : {}),
      },
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
