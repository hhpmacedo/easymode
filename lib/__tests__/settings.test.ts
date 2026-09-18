import { describe, it, expect } from "vitest";
import { readSettings, writeSettings, INSTRUCTIONS_MAX, SETTINGS_KEY } from "../settings";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("settings", () => {
  it("defaults to empty instructions", () => {
    expect(readSettings(fakeStorage())).toEqual({ instructions: "" });
  });
  it("round-trips instructions", () => {
    const s = fakeStorage();
    writeSettings(s, { instructions: "be terse" });
    expect(readSettings(s)).toEqual({ instructions: "be terse" });
  });
  it("trims and caps instructions at INSTRUCTIONS_MAX characters", () => {
    const s = fakeStorage();
    writeSettings(s, { instructions: "  " + "x".repeat(INSTRUCTIONS_MAX + 50) + "  " });
    expect(readSettings(s).instructions).toHaveLength(INSTRUCTIONS_MAX);
  });
  it("falls back to defaults on corrupt or foreign JSON", () => {
    const s = fakeStorage();
    s.setItem(SETTINGS_KEY, "{not json");
    expect(readSettings(s)).toEqual({ instructions: "" });
    s.setItem(SETTINGS_KEY, JSON.stringify({ instructions: 42 }));
    expect(readSettings(s)).toEqual({ instructions: "" });
  });
});
