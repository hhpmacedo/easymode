import { describe, it, expect } from "vitest";
import {
  extractionSchema,
  isNearDuplicate,
  memoryLines,
  mergeMemories,
  needsConsolidation,
  newUserTurnsSince,
  normalizeMemoryText,
  parseRememberCommand,
  turnsSince,
  MEMORY_CAP_TOKENS,
  MEMORY_TEXT_MAX,
} from "../memory";
import type { EasyUIMessage, Memory } from "../types";

function mem(id: string, text: string, over: Partial<Memory> = {}): Memory {
  return {
    id,
    text,
    kind: "fact",
    source: "extracted",
    createdAt: Number(id),
    updatedAt: Number(id),
    status: "active",
    ...over,
  };
}
function user(id: string, text: string): EasyUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as EasyUIMessage;
}
function assistant(id: string, text: string): EasyUIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] } as EasyUIMessage;
}
let nextId = 100;
const ctx = { now: 1000, conversationId: "c1", newId: () => String(nextId++) };

describe("normalizeMemoryText", () => {
  it("collapses whitespace, trims and caps", () => {
    expect(normalizeMemoryText("  prefers   pnpm \n over npm ")).toBe("prefers pnpm over npm");
    expect(normalizeMemoryText("x".repeat(MEMORY_TEXT_MAX + 10))).toHaveLength(MEMORY_TEXT_MAX);
  });
});

describe("isNearDuplicate", () => {
  it("matches the same fact in different words or with more detail", () => {
    expect(isNearDuplicate("Prefers pnpm over npm", "prefers pnpm rather than npm")).toBe(true);
    expect(isNearDuplicate("Works in TypeScript", "Works in TypeScript and Next.js")).toBe(true);
    expect(isNearDuplicate("Lives in Lisbon", "Lives in Lisbon, Portugal")).toBe(true);
    expect(isNearDuplicate("Uses React", "uses  REACT")).toBe(true);
  });
  it("does not match different facts that share words", () => {
    expect(isNearDuplicate("Prefers pnpm", "Lives in Lisbon")).toBe(false);
    expect(isNearDuplicate("Lives in Lisbon", "Lives in London")).toBe(false);
    expect(isNearDuplicate("Wants concise answers", "Wants detailed answers")).toBe(false);
    expect(isNearDuplicate("Uses Python 3", "Uses Python 2")).toBe(false);
    expect(isNearDuplicate("Team of 4", "Team of 40")).toBe(false);
  });
  it("compares whole words, so a prefix or a short token is not a match", () => {
    expect(isNearDuplicate("Uses R", "Uses React")).toBe(false);
    expect(isNearDuplicate("Has a cat", "Has a category system for notes")).toBe(false);
    expect(isNearDuplicate("Likes Go", "Likes Google Docs")).toBe(false);
    expect(isNearDuplicate("Uses Go", "Uses C")).toBe(false);
  });
  it("treats negation as content", () => {
    expect(isNearDuplicate("Not a morning person", "Morning person")).toBe(false);
    expect(isNearDuplicate("Not interested in Rust", "Interested in Rust")).toBe(false);
    expect(isNearDuplicate("Doesn't like Rust", "Likes Rust")).toBe(false);
  });
});

describe("mergeMemories", () => {
  const existing = [
    mem("1", "Prefers pnpm"),
    mem("2", "Lives in Lisbon"),
    mem("3", "Old job at Acme"),
  ];
  it("adds new facts, skips near-duplicates, updates and archives by id", () => {
    const out = mergeMemories(
      existing,
      {
        add: [
          { text: "Uses Next.js 16 at work", kind: "project" },
          { text: "prefers pnpm rather than npm", kind: "preference" },
        ],
        update: [{ id: "2", text: "Lives in Lisbon, Portugal" }],
        archive: ["3"],
      },
      ctx,
    );
    expect(out.filter((m) => m.status === "active").map((m) => m.text)).toEqual([
      "Prefers pnpm",
      "Lives in Lisbon, Portugal",
      "Uses Next.js 16 at work",
    ]);
    const added = out.find((m) => m.text === "Uses Next.js 16 at work")!;
    expect(added).toMatchObject({
      kind: "project",
      source: "extracted",
      conversationId: "c1",
      status: "active",
    });
    expect(out.find((m) => m.id === "3")?.status).toBe("archived");
    expect(out.find((m) => m.id === "2")?.updatedAt).toBe(1000);
  });
  it("ignores unknown ids and does not resurrect archived memories", () => {
    const out = mergeMemories(
      [mem("9", "gone", { status: "archived" })],
      {
        add: [],
        update: [
          { id: "9", text: "x" },
          { id: "nope", text: "y" },
        ],
        archive: ["nope"],
      },
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("archived");
    expect(out[0].text).toBe("gone");
  });
  it("never mutates its input", () => {
    const before = structuredClone(existing);
    mergeMemories(
      existing,
      {
        add: [{ text: "Uses Next.js 16 at work", kind: "project" }],
        update: [{ id: "2", text: "Lives in Lisbon, Portugal" }],
        archive: ["3"],
      },
      ctx,
    );
    expect(existing).toEqual(before);
  });
  it("dedupes adds against memories added earlier in the same batch", () => {
    const out = mergeMemories(
      [],
      {
        add: [
          { text: "Prefers pnpm over npm", kind: "preference" },
          { text: "prefers pnpm rather than npm", kind: "preference" },
        ],
        update: [],
        archive: [],
      },
      ctx,
    );
    expect(out.map((m) => m.text)).toEqual(["Prefers pnpm over npm"]);
  });
  it("ignores an update whose text normalizes to empty", () => {
    const out = mergeMemories(
      existing,
      { add: [], update: [{ id: "1", text: "  \n " }], archive: [] },
      ctx,
    );
    expect(out.find((m) => m.id === "1")).toEqual(existing[0]);
  });
  it("archives an id that appears in both update and archive", () => {
    const out = mergeMemories(
      existing,
      { add: [], update: [{ id: "3", text: "New job at Acme" }], archive: ["3"] },
      ctx,
    );
    expect(out.find((m) => m.id === "3")).toMatchObject({
      status: "archived",
      text: "Old job at Acme",
    });
  });
});

describe("memoryLines", () => {
  it("renders active memories in creation order and skips archived", () => {
    expect(
      memoryLines([mem("2", "b"), mem("1", "a"), mem("3", "c", { status: "archived" })]),
    ).toEqual(["a", "b"]);
  });
  it("keeps the newest under the token cap, then returns them in creation order", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      mem(String(i + 1), `fact number ${i + 1} ` + "x".repeat(60)),
    );
    const lines = memoryLines(many, MEMORY_CAP_TOKENS);
    expect(lines.length).toBeLessThan(200);
    expect(lines[lines.length - 1]).toContain("fact number 200");
    const ids = lines.map((l) => Number(l.match(/fact number (\d+)/)![1]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe("needsConsolidation", () => {
  it("is true only when active memories exceed the cap", () => {
    expect(needsConsolidation([mem("1", "short")])).toBe(false);
    const many = Array.from({ length: 200 }, (_, i) => mem(String(i + 1), "x".repeat(60)));
    expect(needsConsolidation(many)).toBe(true);
  });
});

describe("parseRememberCommand", () => {
  it("splits an explicit memory from the rest of the message", () => {
    expect(parseRememberCommand("remember: I prefer pnpm")).toEqual({
      memory: "I prefer pnpm",
      rest: "I prefer pnpm",
    });
    expect(parseRememberCommand("Remember:   my team is 4 people\nnow plan the sprint")).toEqual({
      memory: "my team is 4 people",
      rest: "my team is 4 people\nnow plan the sprint",
    });
    expect(parseRememberCommand("do you remember: the plan?")).toBeNull();
    expect(parseRememberCommand("remember:")).toBeNull();
  });
  it("takes the first line after the prefix, even across a newline or CRLF", () => {
    expect(parseRememberCommand("remember:\nI prefer pnpm\nplan sprint")).toEqual({
      memory: "I prefer pnpm",
      rest: "I prefer pnpm\nplan sprint",
    });
    expect(parseRememberCommand("remember: I prefer pnpm\r\nplan sprint")).toEqual({
      memory: "I prefer pnpm",
      rest: "I prefer pnpm\r\nplan sprint",
    });
  });
});

describe("turn counting", () => {
  const msgs = [
    user("1", "a"),
    assistant("2", "b"),
    user("3", "c"),
    assistant("4", "d"),
    user("5", "e"),
  ];
  it("counts user turns after the extracted-through id", () => {
    expect(newUserTurnsSince(msgs)).toBe(3);
    expect(newUserTurnsSince(msgs, "2")).toBe(2);
    expect(newUserTurnsSince(msgs, "5")).toBe(0);
    expect(newUserTurnsSince(msgs, "missing")).toBe(3);
  });
  it("returns the turns after the id as role/text pairs", () => {
    expect(turnsSince(msgs, "2")).toEqual([
      { role: "user", text: "c" },
      { role: "assistant", text: "d" },
      { role: "user", text: "e" },
    ]);
  });
});

describe("extractionSchema", () => {
  it("accepts a well-formed result and rejects bad kinds or long text", () => {
    expect(
      extractionSchema.safeParse({ add: [{ text: "x", kind: "fact" }], update: [], archive: [] })
        .success,
    ).toBe(true);
    expect(
      extractionSchema.safeParse({ add: [{ text: "x", kind: "mood" }], update: [], archive: [] })
        .success,
    ).toBe(false);
    expect(
      extractionSchema.safeParse({
        add: [{ text: "x".repeat(300), kind: "fact" }],
        update: [],
        archive: [],
      }).success,
    ).toBe(false);
  });
});
