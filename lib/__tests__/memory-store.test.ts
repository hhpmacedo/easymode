import { describe, it, expect } from "vitest";
import { MemoryStore, MEMORY_KEY } from "../memory-store";

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

describe("MemoryStore", () => {
  it("starts empty and survives corrupt JSON", () => {
    const s = fakeStorage();
    s.setItem(MEMORY_KEY, "{nope");
    expect(new MemoryStore(s).list()).toEqual([]);
  });
  it("adds, updates, archives, restores and clears", () => {
    const store = new MemoryStore(fakeStorage(), () => 1000);
    const m = store.add("prefers pnpm", "preference", "user");
    expect(m).toMatchObject({
      text: "prefers pnpm",
      kind: "preference",
      source: "user",
      status: "active",
      createdAt: 1000,
    });
    store.update(m.id, "  prefers   pnpm over npm ");
    expect(store.active()[0].text).toBe("prefers pnpm over npm");
    store.archive(m.id);
    expect(store.active()).toEqual([]);
    expect(store.list()[0].status).toBe("archived");
    store.restore(m.id);
    expect(store.active()).toHaveLength(1);
    store.clearAll();
    expect(store.list()).toEqual([]);
  });
  it("replaceAll persists a merged set", () => {
    const store = new MemoryStore(fakeStorage(), () => 5);
    const a = store.add("a", "fact", "extracted");
    store.replaceAll([{ ...a, text: "a2" }]);
    expect(store.list().map((m) => m.text)).toEqual(["a2"]);
  });
  it("tracks extraction cost per month", () => {
    const store = new MemoryStore(fakeStorage(), () => Date.UTC(2026, 8, 18));
    store.recordCost(0.002);
    store.recordCost(0.003);
    expect(store.monthCost()).toBeCloseTo(0.005, 10);
    expect(store.monthCost("2026-08")).toBe(0);
  });
});
