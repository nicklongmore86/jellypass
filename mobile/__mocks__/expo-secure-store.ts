// The credential store in tests: an in-memory map, used automatically wherever the app imports expo-secure-store (a
// root __mocks__ entry for a package needs no jest.mock call). Each value keeps the options it was written with.
const items = new Map<string, { value: string; options: unknown }>();

export const AFTER_FIRST_UNLOCK = 0;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;
export const ALWAYS = 2;
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3;
export const ALWAYS_THIS_DEVICE_ONLY = 4;
export const WHEN_UNLOCKED = 5;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;

export const getItemAsync = jest.fn(async (key: string, _options?: unknown) => items.get(key)?.value ?? null);
export const setItemAsync = jest.fn(async (key: string, value: string, options?: unknown) => {
  items.set(key, { value, options });
});
export const deleteItemAsync = jest.fn(async (key: string, _options?: unknown) => {
  items.delete(key);
});

/** For tests only: what is stored now. */
export const __items = items;
