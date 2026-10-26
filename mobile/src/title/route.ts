// A title page's route parameters: a whole number in the address, written plainly ("12", never "012" or "1e3"), or
// nothing. A page whose address holds anything else is Not found without a call.

/** The number in a route parameter, from `min` up, or undefined. */
export function routeNumber(param: string | string[] | undefined, min = 1): number | undefined {
  if (typeof param !== 'string' || !/^(0|[1-9]\d{0,9})$/.test(param)) return undefined;
  const value = Number(param);
  return Number.isSafeInteger(value) && value >= min ? value : undefined;
}
