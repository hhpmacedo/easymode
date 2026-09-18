/** User settings, stored in this browser only (spec §8). The pure read/write
 *  pair takes a Storage so it is unit-testable; the client wrappers below bind
 *  window.localStorage and fire SETTINGS_CHANGE_EVENT so open views react. */
export const SETTINGS_KEY = "easymode:settings";
export const SETTINGS_CHANGE_EVENT = "easymode:settings-change";
/** Spec §4.2: "How I like answers" is capped at 2,000 characters. */
export const INSTRUCTIONS_MAX = 2000;

export interface Settings {
  instructions: string;
}

const DEFAULTS: Settings = { instructions: "" };

export function readSettings(storage: Storage): Settings {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    const instructions =
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { instructions?: unknown }).instructions === "string"
        ? (parsed as { instructions: string }).instructions
        : DEFAULTS.instructions;
    return { instructions };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(storage: Storage, settings: Settings): void {
  const instructions = settings.instructions.trim().slice(0, INSTRUCTIONS_MAX);
  storage.setItem(SETTINGS_KEY, JSON.stringify({ instructions }));
}

/** Client wrappers (safe to call during SSR: they no-op without window). */
export function getSettings(): Settings {
  if (typeof window === "undefined") return { ...DEFAULTS };
  return readSettings(window.localStorage);
}

export function setInstructions(instructions: string): void {
  try {
    writeSettings(window.localStorage, { ...getSettings(), instructions });
    window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
  } catch {
    // storage disabled (private mode / quota) — the setting just won't persist
  }
}
