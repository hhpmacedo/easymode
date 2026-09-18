import { describe, it, expect, beforeEach } from "vitest";
import { ConversationStore } from "../storage";
import type { EasyUIMessage } from "../types";

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

const msg: EasyUIMessage = {
  id: "m1",
  role: "user",
  parts: [{ type: "text", text: "hello world this is a longer message" }],
} as EasyUIMessage;

describe("ConversationStore", () => {
  let store: ConversationStore;
  beforeEach(() => {
    store = new ConversationStore(fakeStorage());
  });

  it("creates and lists conversations, newest first", () => {
    const a = store.create();
    const b = store.create();
    const list = store.list();
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
  });

  it("saves messages and titles from the first user message", () => {
    const c = store.create();
    store.saveMessages(c.id, [msg]);
    expect(store.getMessages(c.id)).toHaveLength(1);
    expect(store.list()[0].title).toBe("hello world this is a longer messag…");
  });

  it("does not bump updatedAt when saving unchanged messages", () => {
    const a = store.create();
    const b = store.create();
    store.saveMessages(a.id, [msg]);
    const savedAt = store.list().find((c) => c.id === a.id)!.updatedAt;
    store.saveMessages(b.id, [msg]); // b is now the most recently updated
    store.saveMessages(a.id, [msg]); // unchanged content → no-op
    expect(store.list().find((c) => c.id === a.id)!.updatedAt).toBe(savedAt);
    expect(store.list()[0].id).toBe(b.id);
  });

  it("renames and deletes", () => {
    const c = store.create();
    store.rename(c.id, "My chat");
    expect(store.list()[0].title).toBe("My chat");
    store.remove(c.id);
    expect(store.list()).toHaveLength(0);
    expect(store.getMessages(c.id)).toEqual([]);
  });

  it("survives corrupt JSON gracefully", () => {
    const s = fakeStorage();
    s.setItem("easymode:index", "{not json");
    const st = new ConversationStore(s);
    expect(st.list()).toEqual([]);
  });
});

describe("compaction meta", () => {
  const compaction = {
    throughMessageId: "a2",
    summary: { goal: "g", decisions: [], facts: [], artifacts: [], open: [] },
    tokensBefore: 52_000,
    createdAt: 1,
    edited: false,
  };
  it("stores and clears a conversation's compaction without touching updatedAt", () => {
    const store = new ConversationStore(fakeStorage());
    const meta = store.create();
    store.setCompaction(meta.id, compaction);
    expect(store.getMeta(meta.id)?.compaction).toEqual(compaction);
    expect(store.getMeta(meta.id)?.updatedAt).toBe(meta.updatedAt);
    store.setCompaction(meta.id, undefined);
    expect(store.getMeta(meta.id)?.compaction).toBeUndefined();
  });
  it("getMeta returns undefined for an unknown id", () => {
    expect(new ConversationStore(fakeStorage()).getMeta("nope")).toBeUndefined();
  });
});

describe("extractedThrough", () => {
  it("records the last message memory extraction has read, without touching updatedAt", () => {
    const store = new ConversationStore(fakeStorage());
    const meta = store.create();
    store.setExtractedThrough(meta.id, "m7");
    expect(store.getMeta(meta.id)?.extractedThrough).toBe("m7");
    expect(store.getMeta(meta.id)?.updatedAt).toBe(meta.updatedAt);
  });
});
