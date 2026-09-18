"use client";
/** The user's own Anthropic key, stored in the browser only.
 *
 *  It never touches our server storage: it lives in localStorage and is sent
 *  per request as the `x-anthropic-key` header so Anthropic bills the user's
 *  own account. "Disconnect" wipes it. A `key-change` event lets open tabs and
 *  the transport react immediately. */
const STORAGE_KEY = "easymode:anthropic-key";
export const KEY_CHANGE_EVENT = "easymode:key-change";

export function getUserKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setUserKey(key: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, key.trim());
    window.dispatchEvent(new Event(KEY_CHANGE_EVENT));
  } catch {
    // storage disabled (private mode / quota) — the key just won't persist
  }
}

export function clearUserKey(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(KEY_CHANGE_EVENT));
  } catch {
    // ignore
  }
}

/** `sk-ant-…a1b2` — enough to recognize, never the whole secret. */
export function maskKey(key: string): string {
  const t = key.trim();
  return t.length <= 12 ? "sk-ant-…" : `${t.slice(0, 7)}…${t.slice(-4)}`;
}
