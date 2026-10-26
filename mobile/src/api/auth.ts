// The two `Authorization: MediaBrowser ...` headers the contract asks for (docs/app-design.md, "Native clients
// (contract)"). Values are percent-encoded, as the PWA does for the token, and Jellyfin decodes them. Neither header
// is ever logged.

/** Every API call (and sign-out): the token, and nothing else that identifies the caller. */
export function tokenAuthorization(token: string): string {
  return `MediaBrowser Token="${encodeValue(token)}"`;
}

/** Who is signing in, as Jellyfin lists the session. All four are required and non-empty, or the gateway answers 400. */
export interface ClientIdentity {
  /** The app's name: `JellyPass`. */
  client: string;
  /** The device model, for Jellyfin's device list. */
  device: string;
  /** Random, generated once and kept on the device. */
  deviceId: string;
  /** The app's version. */
  version: string;
}

/** `POST /Users/AuthenticateByName` (step 2.3): the client, device, device ID and version, and no token. */
export function signInAuthorization(identity: ClientIdentity): string {
  const fields = (['client', 'device', 'deviceId', 'version'] as const).map((key) => {
    const value = identity[key].trim();
    if (!value) throw new TypeError(`${key} is required`);
    return `${key === 'deviceId' ? 'DeviceId' : key[0]!.toUpperCase() + key.slice(1)}="${encodeValue(value)}"`;
  });
  return `MediaBrowser ${fields.join(', ')}`;
}

/** Percent-encoded: no quote, comma or space survives to end a field early. */
function encodeValue(value: string): string {
  return encodeURIComponent(value);
}
