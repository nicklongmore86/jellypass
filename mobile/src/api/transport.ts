// How the app reaches a household: expo/fetch with `redirect: 'manual'`, so a request carrying a password, a token or
// an Authorization header is only ever sent to the household address it was made for, and a 3xx is an error.
//
// React Native's own fetch cannot do this. It is whatwg-fetch over XMLHttpRequest over RCTNetworking
// (react-native/Libraries/Network/fetch.js, XMLHttpRequest.js, RCTNetworking.*.js): none of them passes a redirect
// option to the platform, and the platform follows every redirect before JavaScript hears of it.
// - iOS (RCTHTTPRequestHandler.mm, willPerformHTTPRedirection): NSURLSession's proposed request is followed, its headers
//   replaced by cookies. For a 307/308 that request keeps the method and the body, so a sign-in's password would go to
//   wherever the Location named.
// - Android (OkHttpClientProvider.kt, NetworkingModule.kt): OkHttp with its default followRedirects(true). OkHttp drops
//   Authorization on a redirect to another host, but a 307/308 keeps the method and the body, password included.
// So `response.url` checked afterwards is too late: the request has already been sent off the household.
//
// expo/fetch (expo/src/winter/fetch, part of the `expo` package already depended on) passes `redirect` to the platform:
// - iOS (ios/Expo/Fetch/NativeResponse.swift): any mode but `follow` answers willPerformHTTPRedirection with nil, so
//   NSURLSession sends no second request and hands back the 3xx itself.
// - Android (android/.../fetch/NativeRequest.kt): any mode but `follow` builds the call with followRedirects(false) and
//   followSslRedirects(false), so OkHttp returns the 3xx unfollowed.
// `manual` (not `error`) keeps the 3xx's status, which the clients then treat as an error without reading the body.

import { fetch as expoFetch } from 'expo/fetch';

import type { FetchLike, ResponseLike } from './client';

/** The fetch every household call goes through unless a test passes its own. */
export const householdFetch: FetchLike = (url, init) => expoFetch(url, init) as unknown as Promise<ResponseLike>;

/**
 * Whether an answer is anything but the household's own, unredirected one: a 3xx (or the opaque status 0 a web fetch
 * gives a manual redirect), an answer the platform says it reached through a redirect, or one from another URL.
 */
export function offHousehold(response: ResponseLike, origin: string): boolean {
  const { status, url } = response;
  if (status === 0 || (status >= 300 && status < 400)) return true;
  if (response.redirected === true) return true;
  return typeof url === 'string' && url !== '' && !url.startsWith(`${origin}/`);
}
