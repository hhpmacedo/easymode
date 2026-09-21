import { describe, it, expect } from "vitest";
import {
  readSettings,
  writeSettings,
  INSTRUCTIONS_MAX,
  SETTINGS_KEY,
  COMPACT_THRESHOLD_DEFAULT,
  COMPACT_THRESHOLD_MIN,
  COMPACT_THRESHOLD_MAX,
} from "../settings";

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
    expect(readSettings(fakeStorage())).toEqual({
      instructions: "",
      compactThreshold: COMPACT_THRESHOLD_DEFAULT,
      memoryEnabled: true,
    });
  });
  it("round-trips instructions", () => {
    const s = fakeStorage();
    writeSettings(s, {
      instructions: "be terse",
      compactThreshold: COMPACT_THRESHOLD_DEFAULT,
      memoryEnabled: true,
    });
    expect(readSettings(s)).toEqual({
      instructions: "be terse",
      compactThreshold: COMPACT_THRESHOLD_DEFAULT,
      memoryEnabled: true,
    });
  });
  it("trims surrounding whitespace from instructions", () => {
    const s = fakeStorage();
    writeSettings(s, {
      instructions: "  be terse  ",
      compactThreshold: COMPACT_THRESHOLD_DEFAULT,
      memoryEnabled: true,
    });
    expect(readSettings(s).instructions).toBe("be terse");
  });
  it("trims and caps instructions at INSTRUCTIONS_MAX characters", () => {
    const s = fakeStorage();
    writeSettings(s, {
      instructions: "  " + "x".repeat(INSTRUCTIONS_MAX + 50) + "  ",
      compactThreshold: COMPACT_THRESHOLD_DEFAULT,
      memoryEnabled: true,
    });
    expect(readSettings(s).instructions).toBe("x".repeat(INSTRUCTIONS_MAX));
  });
  it("falls back to defaults on corrupt or foreign JSON", () => {
    const s = fakeStorage();
    s.setItem(SETTINGS_KEY, "{not json");
    expect(readSettings(s)).toEqual({
      instructions: "",
      compactThreshold: COMPACT_THRESHOLD_DEFAULT,
      memoryEnabled: true,
    });
    s.setItem(SETTINGS_KEY, JSON.stringify({ instructions: 42 }));
    expect(readSettings(s)).toEqual({
      instructions: "",
      compactThreshold: COMPACT_THRESHOLD_DEFAULT,
      memoryEnabled: true,
    });
  });
  it("round-trips the compaction threshold", () => {
    const s = fakeStorage();
    writeSettings(s, { instructions: "", compactThreshold: 90_000, memoryEnabled: true });
    expect(readSettings(s).compactThreshold).toBe(90_000);
  });
  it("clamps the threshold into its allowed range and ignores junk", () => {
    const s = fakeStorage();
    writeSettings(s, { instructions: "", compactThreshold: 5, memoryEnabled: true });
    expect(readSettings(s).compactThreshold).toBe(COMPACT_THRESHOLD_MIN);
    writeSettings(s, { instructions: "", compactThreshold: 10_000_000, memoryEnabled: true });
    expect(readSettings(s).compactThreshold).toBe(COMPACT_THRESHOLD_MAX);
    s.setItem(SETTINGS_KEY, JSON.stringify({ instructions: "", compactThreshold: "lots" }));
    expect(readSettings(s).compactThreshold).toBe(COMPACT_THRESHOLD_DEFAULT);
  });
  it("round-trips memoryEnabled and treats junk as the default (on)", () => {
    const s = fakeStorage();
    writeSettings(s, {
      instructions: "",
      compactThreshold: COMPACT_THRESHOLD_DEFAULT,
      memoryEnabled: false,
    });
    expect(readSettings(s).memoryEnabled).toBe(false);
    s.setItem(SETTINGS_KEY, JSON.stringify({ memoryEnabled: "no" }));
    expect(readSettings(s).memoryEnabled).toBe(true);
  });
});
