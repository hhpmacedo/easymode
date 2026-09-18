/** User settings, stored in this browser only (spec §8). The pure read/write
 *  pair takes a Storage so it is unit-testable; the client wrappers below bind
 *  window.localStorage and fire SETTINGS_CHANGE_EVENT so open views react. */
export const SETTINGS_KEY = "easymode:settings";
export const SETTINGS_CHANGE_EVENT = "easymode:settings-change";
/** Spec §4.2: "How I like answers" is capped at 2,000 characters. */
export const INSTRUCTIONS_MAX = 2000;
/** Spec §6.1: compact when the last turn's context exceeds this. The ceiling
 *  keeps the compaction input inside the Haiku 4.5 window. */
export const COMPACT_THRESHOLD_DEFAULT = 60_000;
export const COMPACT_THRESHOLD_MIN = 30_000;
export const COMPACT_THRESHOLD_MAX = 150_000;

export interface Settings {
  instructions: string;
  compactThreshold: number;
  memoryEnabled: boolean;
}

const DEFAULTS: Settings = {
  instructions: "",
  compactThreshold: COMPACT_THRESHOLD_DEFAULT,
  memoryEnabled: true,
};

function normalize(value: unknown): Settings {
  const o = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const instructions =
    typeof o.instructions === "string"
      ? o.instructions.trim().slice(0, INSTRUCTIONS_MAX)
      : DEFAULTS.instructions;
  const compactThreshold =
    typeof o.compactThreshold === "number" && Number.isFinite(o.compactThreshold)
      ? Math.min(COMPACT_THRESHOLD_MAX, Math.max(COMPACT_THRESHOLD_MIN, o.compactThreshold))
      : DEFAULTS.compactThreshold;
  const memoryEnabled =
    typeof o.memoryEnabled === "boolean" ? o.memoryEnabled : DEFAULTS.memoryEnabled;
  return { instructions, compactThreshold, memoryEnabled };
}

/** Normalizes on read so a hand-edited or older value can never make the
 *  server reject every send. */
export function readSettings(storage: Storage): Settings {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    return raw ? normalize(JSON.parse(raw)) : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(storage: Storage, settings: Settings): void {
  storage.setItem(SETTINGS_KEY, JSON.stringify(normalize(settings)));
}

/** Client wrappers (safe to call during SSR: they no-op without window). */
export function getSettings(): Settings {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    return readSettings(window.localStorage);
  } catch {
    return { ...DEFAULTS }; // storage blocked (sandboxed iframe, cookies off)
  }
}

export function setInstructions(instructions: string): void {
  try {
    writeSettings(window.localStorage, { ...getSettings(), instructions });
    window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
  } catch {
    // storage disabled (private mode / quota) — the setting just won't persist
  }
}

export function setCompactThreshold(compactThreshold: number): void {
  try {
    writeSettings(window.localStorage, { ...getSettings(), compactThreshold });
    window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
  } catch {
    // ignore, as above
  }
}

export function setMemoryEnabled(memoryEnabled: boolean): void {
  try {
    writeSettings(window.localStorage, { ...getSettings(), memoryEnabled });
    window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
  } catch {
    // ignore, as above
  }
}
