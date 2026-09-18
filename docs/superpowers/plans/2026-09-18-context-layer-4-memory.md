# Context Layer, Plan 4 of 4 — Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memory across conversations — durable facts about the user, extracted automatically at quiet moments (plus an explicit `remember:` command), saved with an undo, rendered into every request's cached system layer, and manageable in Settings.

**Architecture:** Memories live in the browser (`easymode:memory`, a `MemoryStore` with injectable `Storage`). A pure module `lib/memory.ts` owns the extraction schema, near-duplicate detection, merge, the ≤ ~1,500-token render cap, and the `remember:` parser. `/api/memory/extract` is a stateless job endpoint on plan 3's plumbing (`resolveAuth` with its own limiter, `readJsonBody`, `runJob`): it receives the new turns plus the current memories and returns `{ add, update, archive }`; in consolidate mode it rewrites the whole set denser. The client triggers extraction when a conversation goes quiet (switch away, or 10 minutes idle) with ≥ 2 new user turns, merges, records the cost, and shows a "Remembered … · Undo" toast. The transport sends active memory lines as `context.memory`; the chat route renders them inside `<memory>` (already supported by `assembleRequest`) and gives the classifier the lines only when they are short. Spec §5, §4.3, §4.5, §7.1–7.3, §8.

**Tech Stack:** Next.js 16, AI SDK v7 (`generateObject`), zod 4, React 19, vitest.

**Depends on:** plans 1–3 (branch `feat/context-layer-3-compaction`, PR #14): `assembleRequest({ memory })`, `resolveAuth`/`readJsonBody`/`runJob`, `estimateTokens` in `lib/compaction.ts`, the tabbed Settings modal.

**Spec notes:** export of memory + settings (spec §5.7, §8) is not built — there is no export feature in the app yet; it goes with the IndexedDB migration spec.

---

## File map

| File | Responsibility | Change |
|---|---|---|
| `lib/types.ts` | Shared types | `Memory`, `MemoryKind`, `MEMORY_KINDS`; `ChatContext.memory` |
| `lib/memory.ts` | **New.** Pure memory logic: extraction schema, normalize, near-duplicate, merge, render cap, `remember:` parser, turn counting | — |
| `lib/settings.ts` | Settings | `memoryEnabled` (+ setter) |
| `lib/storage.ts` | Conversation store | `ConversationMeta.extractedThrough`; `setExtractedThrough` |
| `lib/memory-store.ts` | **New.** `MemoryStore` (list/add/update/archive/restore/clearAll/replaceAll, monthly cost), browser singleton, change event | — |
| `lib/auth.ts` | Auth + rate limits | `resolveExtractAuth` (own limiter) |
| `lib/prompts/memory.ts` | **New.** Extraction system prompt + prompt builder (normal + consolidate) | — |
| `app/api/memory/extract/route.ts` | **New.** Extraction endpoint | — |
| `lib/router.ts` | Classifier | `buildClassifierPrompt`/`classify` accept short memory lines |
| `app/api/chat/route.ts` | Chat endpoint | Validate `context.memory`; pass to `assembleRequest` and `classify` |
| `components/use-memory-extraction.ts` | **New.** Quiet-moment trigger hook | — |
| `components/memory-toast.tsx` | **New.** "Remembered … · Undo" | — |
| `components/chat-view.tsx` | Chat screen | Hook, toast, `remember:` command, `context.memory` in body |
| `components/settings-modal.tsx` | Settings | "Memory" tab |
| `scripts/check-memory.ts`, `fixtures/memory-eval.json` | **New.** Live extraction check (`eval:memory`) | — |
| `README.md`, `.github/workflows/ci.yml`, `package.json` | Docs, CI, scripts | — |
| tests: `lib/__tests__/memory.test.ts`, `memory-store.test.ts` (new); `settings.test.ts`, `storage.test.ts`, `auth.test.ts`, `router.test.ts` | Unit tests | — |

Waves: **A** = Tasks 1, 2 · **B** = Tasks 3, 4, 5 (need A; disjoint files) · **C** = Tasks 6, 7 (need B; disjoint files) · then the gate.

---

### Task 1: Types and the pure memory module

**Files:**
- Modify: `lib/types.ts`
- Create: `lib/memory.ts`
- Test: `lib/__tests__/memory.test.ts` (new)

- [ ] **Step 1: Types**

In `lib/types.ts`, after the `Compaction` interface, add:

```ts
export const MEMORY_KINDS = ["profile", "preference", "project", "fact"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** One durable fact about the user (spec §5.1). One line, ≤ 200 chars.
 *  Archived memories stay stored (for undo and audit) but are never sent. */
export interface Memory {
  id: string;
  text: string;
  kind: MemoryKind;
  source: "user" | "extracted";
  /** Where it was learned (absent for `remember:` and edits). */
  conversationId?: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "archived";
}
```

In `ChatContext`, add:

```ts
  /** Active memory lines, already capped by the client (spec §4.3). */
  memory?: string[];
```

- [ ] **Step 2: Write the failing tests**

Create `lib/__tests__/memory.test.ts`:

```ts
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
  it("matches the same fact in different words, not different facts", () => {
    expect(isNearDuplicate("Prefers pnpm over npm", "prefers pnpm rather than npm")).toBe(true);
    expect(isNearDuplicate("Works in TypeScript", "Works in TypeScript and Next.js")).toBe(true);
    expect(isNearDuplicate("Prefers pnpm", "Lives in Lisbon")).toBe(false);
  });
});

describe("mergeMemories", () => {
  const existing = [mem("1", "Prefers pnpm"), mem("2", "Lives in Lisbon"), mem("3", "Old job at Acme")];
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
    expect(added).toMatchObject({ kind: "project", source: "extracted", conversationId: "c1", status: "active" });
    expect(out.find((m) => m.id === "3")?.status).toBe("archived");
    expect(out.find((m) => m.id === "2")?.updatedAt).toBe(1000);
  });
  it("ignores unknown ids and does not resurrect archived memories", () => {
    const out = mergeMemories(
      [mem("9", "gone", { status: "archived" })],
      { add: [], update: [{ id: "9", text: "x" }, { id: "nope", text: "y" }], archive: ["nope"] },
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("archived");
    expect(out[0].text).toBe("gone");
  });
});

describe("memoryLines", () => {
  it("renders active memories in creation order and skips archived", () => {
    expect(memoryLines([mem("2", "b"), mem("1", "a"), mem("3", "c", { status: "archived" })])).toEqual(["a", "b"]);
  });
  it("keeps the newest under the token cap, then returns them in creation order", () => {
    const many = Array.from({ length: 200 }, (_, i) => mem(String(i + 1), `fact number ${i + 1} ` + "x".repeat(60)));
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
    expect(parseRememberCommand("remember: I prefer pnpm")).toEqual({ memory: "I prefer pnpm", rest: "I prefer pnpm" });
    expect(parseRememberCommand("Remember:   my team is 4 people\nnow plan the sprint")).toEqual({
      memory: "my team is 4 people",
      rest: "my team is 4 people\nnow plan the sprint",
    });
    expect(parseRememberCommand("do you remember: the plan?")).toBeNull();
    expect(parseRememberCommand("remember:")).toBeNull();
  });
});

describe("turn counting", () => {
  const msgs = [user("1", "a"), assistant("2", "b"), user("3", "c"), assistant("4", "d"), user("5", "e")];
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
    expect(extractionSchema.safeParse({ add: [{ text: "x", kind: "fact" }], update: [], archive: [] }).success).toBe(true);
    expect(extractionSchema.safeParse({ add: [{ text: "x", kind: "mood" }], update: [], archive: [] }).success).toBe(false);
    expect(extractionSchema.safeParse({ add: [{ text: "x".repeat(300), kind: "fact" }], update: [], archive: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/memory.test.ts`
Expected: FAIL — cannot resolve `../memory`.

- [ ] **Step 4: Create `lib/memory.ts`**

```ts
/** Memory across conversations (spec §5): the pure pieces. Extraction and
 *  storage live elsewhere; nothing here touches the network or localStorage. */
import { z } from "zod";
import { estimateTokens } from "./compaction";
import { MEMORY_KINDS, messageText } from "./types";
import type { EasyUIMessage, Memory } from "./types";

/** One fact, one line (spec §5.1). */
export const MEMORY_TEXT_MAX = 200;
/** Rendered memory is capped so it stays a small, stable prefix (spec §4.3). */
export const MEMORY_CAP_TOKENS = 1_500;
/** The classifier only sees memory when it is this short (spec §4.5). */
export const CLASSIFIER_MEMORY_TOKENS = 300;
/** Quiet-moment trigger: this many new user turns since the last extraction (spec §5.2). */
export const EXTRACT_MIN_USER_TURNS = 2;
export const EXTRACT_IDLE_MS = 10 * 60_000;

export const extractionSchema = z.object({
  add: z
    .array(z.object({ text: z.string().min(1).max(MEMORY_TEXT_MAX), kind: z.enum(MEMORY_KINDS) }))
    .max(20)
    .describe("New durable facts about the user; empty when unsure"),
  update: z
    .array(z.object({ id: z.string().min(1), text: z.string().min(1).max(MEMORY_TEXT_MAX) }))
    .max(20)
    .describe("Existing memories (by id) whose text should change"),
  archive: z.array(z.string().min(1)).max(50).describe("Existing memory ids that no longer hold"),
});
export type ExtractionResult = z.infer<typeof extractionSchema>;

export function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MEMORY_TEXT_MAX);
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3),
  );
}

/** Same fact in different words: high word overlap, or one contains the other. */
export function isNearDuplicate(a: string, b: string): boolean {
  const na = normalizeMemoryText(a).toLowerCase();
  const nb = normalizeMemoryText(b).toLowerCase();
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = words(na);
  const wb = words(nb);
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared) >= 0.6;
}

export interface MergeContext {
  now: number;
  conversationId?: string;
  newId: () => string;
}

/** Apply an extraction result (spec §5.4). Archive and update by id (unknown
 *  or archived ids are ignored); add only facts that do not near-duplicate an
 *  active one. Returns a new array; never mutates the input. */
export function mergeMemories(existing: Memory[], result: ExtractionResult, ctx: MergeContext): Memory[] {
  const archive = new Set(result.archive);
  const updates = new Map(result.update.map((u) => [u.id, normalizeMemoryText(u.text)]));
  const out: Memory[] = existing.map((m) => {
    if (m.status !== "active") return m;
    if (archive.has(m.id)) return { ...m, status: "archived", updatedAt: ctx.now };
    const text = updates.get(m.id);
    if (text && text !== m.text) return { ...m, text, updatedAt: ctx.now };
    return m;
  });
  for (const a of result.add) {
    const text = normalizeMemoryText(a.text);
    if (!text) continue;
    if (out.some((m) => m.status === "active" && isNearDuplicate(m.text, text))) continue;
    out.push({
      id: ctx.newId(),
      text,
      kind: a.kind,
      source: "extracted",
      conversationId: ctx.conversationId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      status: "active",
    });
  }
  return out;
}

function activeInOrder(memories: Memory[]): Memory[] {
  return memories.filter((m) => m.status === "active").sort((a, b) => a.createdAt - b.createdAt);
}

/** The lines rendered into <memory>: active, creation order, newest kept
 *  when over the cap (spec §4.3). */
export function memoryLines(memories: Memory[], capTokens: number = MEMORY_CAP_TOKENS): string[] {
  const active = activeInOrder(memories);
  const kept: Memory[] = [];
  let tokens = 0;
  for (let i = active.length - 1; i >= 0; i--) {
    const t = estimateTokens(active[i].text) + 1;
    if (tokens + t > capTokens) break;
    tokens += t;
    kept.push(active[i]);
  }
  return kept.reverse().map((m) => m.text);
}

export function needsConsolidation(memories: Memory[]): boolean {
  const total = activeInOrder(memories).reduce((n, m) => n + estimateTokens(m.text) + 1, 0);
  return total > MEMORY_CAP_TOKENS;
}

/** `remember: …` at the start of a message saves an explicit memory (spec
 *  §5.5). The memory is the first line after the prefix; the message is sent
 *  with the prefix stripped. */
export function parseRememberCommand(text: string): { memory: string; rest: string } | null {
  const m = text.match(/^\s*remember:\s*(.+)$/is);
  if (!m) return null;
  const rest = m[1].trim();
  const memory = normalizeMemoryText(rest.split("\n")[0]);
  if (!memory) return null;
  return { memory, rest };
}

function indexAfter(messages: EasyUIMessage[], throughId?: string): number {
  if (!throughId) return 0;
  const i = messages.findIndex((m) => m.id === throughId);
  return i < 0 ? 0 : i + 1;
}

export function newUserTurnsSince(messages: EasyUIMessage[], throughId?: string): number {
  return messages.slice(indexAfter(messages, throughId)).filter((m) => m.role === "user").length;
}

/** The turns the extractor reads: raw text as typed, not optimized prompts —
 *  memory is about the person (spec §5.3). */
export function turnsSince(
  messages: EasyUIMessage[],
  throughId?: string,
): { role: "user" | "assistant"; text: string }[] {
  return messages
    .slice(indexAfter(messages, throughId))
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", text: messageText(m) }))
    .filter((t) => t.text.length > 0);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/__tests__/memory.test.ts`
Expected: PASS. If `isNearDuplicate("Works in TypeScript", "Works in TypeScript and Next.js")` fails, it is the containment rule that should catch it — check the normalization, do not loosen the Jaccard threshold below 0.6.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
git add lib/types.ts lib/memory.ts lib/__tests__/memory.test.ts
git commit -m "feat(memory): types and pure module — schema, dedup, merge, render cap, remember: parser

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `memoryEnabled` setting; `extractedThrough` on conversations

**Files:**
- Modify: `lib/settings.ts`, `lib/storage.ts`
- Test: `lib/__tests__/settings.test.ts`, `lib/__tests__/storage.test.ts`

- [ ] **Step 1: Write the failing tests**

In `lib/__tests__/settings.test.ts`, every whole-object expectation and every `writeSettings` call gains `memoryEnabled: true` (the default), e.g. `{ instructions: "", compactThreshold: COMPACT_THRESHOLD_DEFAULT, memoryEnabled: true }`. Append inside the describe:

```ts
  it("round-trips memoryEnabled and treats junk as the default (on)", () => {
    const s = fakeStorage();
    writeSettings(s, { instructions: "", compactThreshold: COMPACT_THRESHOLD_DEFAULT, memoryEnabled: false });
    expect(readSettings(s).memoryEnabled).toBe(false);
    s.setItem(SETTINGS_KEY, JSON.stringify({ memoryEnabled: "no" }));
    expect(readSettings(s).memoryEnabled).toBe(true);
  });
```

Append to `lib/__tests__/storage.test.ts`:

```ts
describe("extractedThrough", () => {
  it("records the last message memory extraction has read, without touching updatedAt", () => {
    const store = new ConversationStore(fakeStorage());
    const meta = store.create();
    store.setExtractedThrough(meta.id, "m7");
    expect(store.getMeta(meta.id)?.extractedThrough).toBe("m7");
    expect(store.getMeta(meta.id)?.updatedAt).toBe(meta.updatedAt);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/settings.test.ts lib/__tests__/storage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Settings**

In `lib/settings.ts`: add `memoryEnabled: boolean;` to `Settings`; `DEFAULTS` gains `memoryEnabled: true`; in `normalize` add

```ts
  const memoryEnabled = typeof o.memoryEnabled === "boolean" ? o.memoryEnabled : DEFAULTS.memoryEnabled;
```

and return it. Add after `setCompactThreshold`:

```ts
export function setMemoryEnabled(memoryEnabled: boolean): void {
  try {
    writeSettings(window.localStorage, { ...getSettings(), memoryEnabled });
    window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
  } catch {
    // ignore, as above
  }
}
```

- [ ] **Step 4: Storage**

In `lib/storage.ts`, add to `ConversationMeta`:

```ts
  /** Spec §5.2: the last message id memory extraction has read. */
  extractedThrough?: string;
```

and a method after `setCompaction`:

```ts
  /** Bookkeeping like setCompaction: never bumps updatedAt. */
  setExtractedThrough(id: string, messageId: string): void {
    const index = this.readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return;
    meta.extractedThrough = messageId;
    this.writeIndex(index);
  }
```

- [ ] **Step 5: Tests, typecheck, lint, commit**

Run: `npx vitest run lib/__tests__/settings.test.ts lib/__tests__/storage.test.ts && npm run typecheck && npm run lint`

```bash
git add lib/settings.ts lib/storage.ts lib/__tests__/settings.test.ts lib/__tests__/storage.test.ts
git commit -m "feat(settings,storage): memoryEnabled; extractedThrough bookkeeping per conversation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `MemoryStore`

**Files:**
- Create: `lib/memory-store.ts`
- Test: `lib/__tests__/memory-store.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/memory-store.test.ts` (copy `fakeStorage` from `storage.test.ts`):

```ts
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
    expect(m).toMatchObject({ text: "prefers pnpm", kind: "preference", source: "user", status: "active", createdAt: 1000 });
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/memory-store.test.ts`
Expected: FAIL — cannot resolve `../memory-store`.

- [ ] **Step 3: Create `lib/memory-store.ts`**

```ts
/** Memory persistence (spec §5.1, §8): one localStorage key holding the
 *  memories and a per-month extraction cost ledger. Injectable Storage and
 *  clock so it is unit-testable; the browser singleton fires
 *  MEMORY_CHANGE_EVENT on every write so open views re-read. */
import { normalizeMemoryText } from "./memory";
import type { Memory, MemoryKind } from "./types";

export const MEMORY_KEY = "easymode:memory";
export const MEMORY_CHANGE_EVENT = "easymode:memory-change";

interface Persisted {
  memories: Memory[];
  /** USD spent on extraction, keyed "YYYY-MM". */
  costs: Record<string, number>;
}

function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export class MemoryStore {
  constructor(
    private storage: Storage,
    private now: () => number = Date.now,
    private onChange: () => void = () => {},
  ) {}

  private read(): Persisted {
    try {
      const raw = this.storage.getItem(MEMORY_KEY);
      if (!raw) return { memories: [], costs: {} };
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      return {
        memories: Array.isArray(parsed.memories) ? parsed.memories : [],
        costs: parsed.costs && typeof parsed.costs === "object" ? parsed.costs : {},
      };
    } catch {
      return { memories: [], costs: {} };
    }
  }

  private write(p: Persisted): void {
    this.storage.setItem(MEMORY_KEY, JSON.stringify(p));
    this.onChange();
  }

  list(): Memory[] {
    return this.read().memories;
  }

  active(): Memory[] {
    return this.list().filter((m) => m.status === "active");
  }

  add(text: string, kind: MemoryKind, source: Memory["source"], conversationId?: string): Memory {
    const p = this.read();
    const now = this.now();
    const memory: Memory = {
      id: crypto.randomUUID(),
      text: normalizeMemoryText(text),
      kind,
      source,
      conversationId,
      createdAt: now,
      updatedAt: now,
      status: "active",
    };
    p.memories.push(memory);
    this.write(p);
    return memory;
  }

  update(id: string, text: string): void {
    this.patch(id, { text: normalizeMemoryText(text) });
  }

  archive(id: string): void {
    this.patch(id, { status: "archived" });
  }

  restore(id: string): void {
    this.patch(id, { status: "active" });
  }

  private patch(id: string, changes: Partial<Memory>): void {
    const p = this.read();
    const m = p.memories.find((x) => x.id === id);
    if (!m) return;
    Object.assign(m, changes, { updatedAt: this.now() });
    this.write(p);
  }

  /** Persist a merged set (after extraction). Keeps the cost ledger. */
  replaceAll(memories: Memory[]): void {
    const p = this.read();
    this.write({ ...p, memories });
  }

  clearAll(): void {
    const p = this.read();
    this.write({ ...p, memories: [] });
  }

  recordCost(usd: number): void {
    const p = this.read();
    const k = monthKey(this.now());
    p.costs[k] = (p.costs[k] ?? 0) + usd;
    this.write(p);
  }

  monthCost(month: string = monthKey(this.now())): number {
    return this.read().costs[month] ?? 0;
  }
}

/** Browser singleton (client components only). */
export function browserMemoryStore(): MemoryStore {
  return new MemoryStore(window.localStorage, Date.now, () =>
    window.dispatchEvent(new Event(MEMORY_CHANGE_EVENT)),
  );
}
```

- [ ] **Step 4: Tests, typecheck, lint, commit**

Run: `npx vitest run lib/__tests__/memory-store.test.ts && npm run typecheck && npm run lint`

```bash
git add lib/memory-store.ts lib/__tests__/memory-store.test.ts
git commit -m "feat(memory): MemoryStore — localStorage-backed memories with a monthly cost ledger

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `/api/memory/extract` — limiter, prompt, route

**Files:**
- Modify: `lib/auth.ts`
- Create: `lib/prompts/memory.ts`
- Create: `app/api/memory/extract/route.ts`
- Test: `lib/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/__tests__/auth.test.ts` (mirror the existing `resolveCompactAuth` block; add `resolveExtractAuth` to the import):

```ts
describe("resolveExtractAuth", () => {
  it("rate-limits per client independently (20 per 15 minutes)", () => {
    const key = "sk-ant-" + "c".repeat(30);
    const mk = () =>
      new Request("http://localhost/api/memory/extract", {
        headers: { "x-anthropic-key": key, "x-forwarded-for": "10.0.0.11" },
      });
    let last = resolveExtractAuth(mk());
    for (let i = 0; i < 20; i++) last = resolveExtractAuth(mk());
    expect(last.denied?.status).toBe(429);
    expect(resolveChatAuth(mk()).denied).toBeNull();
    expect(resolveCompactAuth(mk()).denied).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/__tests__/auth.test.ts`
Expected: FAIL — `resolveExtractAuth` is not exported.

- [ ] **Step 3: `lib/auth.ts`**

After `compactLimiter`, add:

```ts
const extractLimiter = new RateLimiter({ limit: 20, windowMs: 15 * 60_000 });
```

and after `resolveCompactAuth`:

```ts
/** Same precedence as chat, on the memory-extraction limiter (spec §5.3). */
export function resolveExtractAuth(req: Request): ChatAuth {
  return resolveAuth(req, extractLimiter);
}
```

Update the comment above `compactLimiter` from "(compaction now, memory extraction next)" to "(compaction, memory extraction)".

- [ ] **Step 4: Create `lib/prompts/memory.ts`**

```ts
/** Prompts for the memory-extraction job (spec §5.3). Server only. */
import type { Memory } from "../types";

export const EXTRACTION_SYSTEM = `You maintain a short list of durable facts about a person, learned from their conversations with an assistant, so future conversations can be tailored to them without asking again.

Extract ONLY facts that will still be true and useful weeks from now:
- profile: who they are — role, work, tools, languages, location, timezone
- preference: how they like things — answer style, formats, conventions, tools they prefer or avoid
- project: ongoing work they refer back to — names, stacks, deadlines, constraints
- fact: other standing facts they state about themselves or their situation

Rules:
- Facts about the person, not about the assistant, and not about the specific task of this conversation (a bug they fixed today is not a memory; that they work in Rust is).
- Nothing sensitive unless they explicitly ask to remember it: health, finances, relationships, religion, politics, credentials, addresses.
- Prefer what the user stated over what the assistant inferred.
- One fact per item, one line, under 200 characters, in the third person ("Prefers pnpm"), in the user's language.
- Do not repeat an existing memory. If a new statement refines one, put it in \`update\` with that memory's id. If a statement contradicts one, \`archive\` the old id and \`add\` the new fact.
- When unsure, return nothing. Empty lists are a good answer.`;

export const CONSOLIDATE_NOTE = `The memory list has grown past its size limit. Return, in \`update\`/\`archive\`/\`add\`, a rewrite of the WHOLE set that says the same things in fewer, denser lines: merge overlapping items into one (archive the originals, add the merged line), drop anything stale, keep every fact that still matters.`;

export function buildExtractionPrompt(
  turns: { role: "user" | "assistant"; text: string }[],
  memories: Pick<Memory, "id" | "text" | "kind">[],
  consolidate = false,
): string {
  const known = memories.length
    ? `EXISTING MEMORIES (id · kind · text):\n${memories.map((m) => `${m.id} · ${m.kind} · ${m.text}`).join("\n")}`
    : "EXISTING MEMORIES: none";
  const transcript = turns.map((t) => `${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.text}`).join("\n\n");
  return `${consolidate ? CONSOLIDATE_NOTE + "\n\n" : ""}${known}\n\nNEW TURNS:\n${transcript}`;
}
```

- [ ] **Step 5: Create `app/api/memory/extract/route.ts`**

```ts
import { resolveExtractAuth } from "@/lib/auth";
import { providerFor } from "@/lib/provider";
import { readJsonBody, runJob } from "@/lib/api-helpers";
import { extractionSchema, MEMORY_TEXT_MAX } from "@/lib/memory";
import { EXTRACTION_SYSTEM, buildExtractionPrompt } from "@/lib/prompts/memory";
import { MEMORY_KINDS } from "@/lib/types";
import type { Memory } from "@/lib/types";

export const maxDuration = 60;

// One quiet-moment's worth of turns plus the memory list.
const MAX_BODY_BYTES = 400_000;
const MAX_TURNS = 80;
const MAX_TURN_CHARS = 4_000;
const MAX_MEMORIES = 300;

type Turn = { role: "user" | "assistant"; text: string };

/** Propose memory changes from new turns (spec §5.3). Stateless: the client
 *  merges, stores, and pays (its key or the server's behind the token gate). */
export async function POST(req: Request) {
  const auth = resolveExtractAuth(req);
  if (auth.denied) return auth.denied;

  const parsed = await readJsonBody(req, MAX_BODY_BYTES);
  if (parsed.error) return parsed.error;
  const body = (parsed.body ?? {}) as { turns?: unknown; memories?: unknown; consolidate?: unknown };

  const turns = Array.isArray(body.turns) ? (body.turns as Turn[]) : [];
  const turnsOk =
    turns.length > 0 &&
    turns.length <= MAX_TURNS &&
    turns.every(
      (t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string",
    );
  if (!turnsOk) {
    return Response.json({ error: `Expected 1–${MAX_TURNS} turns of { role, text }.` }, { status: 400 });
  }
  const clipped = turns.map((t) => ({ role: t.role, text: t.text.slice(0, MAX_TURN_CHARS) }));

  const memories = Array.isArray(body.memories) ? (body.memories as Pick<Memory, "id" | "text" | "kind">[]) : [];
  const memoriesOk =
    memories.length <= MAX_MEMORIES &&
    memories.every(
      (m) =>
        m &&
        typeof m.id === "string" &&
        typeof m.text === "string" &&
        m.text.length <= MEMORY_TEXT_MAX &&
        (MEMORY_KINDS as readonly string[]).includes(m.kind),
    );
  if (!memoriesOk) {
    return Response.json({ error: "Malformed memories." }, { status: 400 });
  }

  try {
    const { result, usage } = await runJob(
      providerFor(auth.apiKey),
      extractionSchema,
      EXTRACTION_SYSTEM,
      buildExtractionPrompt(clipped, memories, body.consolidate === true),
    );
    return Response.json({ result, usage });
  } catch (err) {
    console.error("[easymode] memory extraction failed:", err);
    return Response.json({ error: "Memory extraction failed." }, { status: 502 });
  }
}
```

- [ ] **Step 6: Tests, typecheck, lint, commit**

Run: `npx vitest run lib/__tests__/auth.test.ts && npm run typecheck && npm run lint`

```bash
git add lib/auth.ts lib/prompts/memory.ts app/api/memory/extract/route.ts lib/__tests__/auth.test.ts
git commit -m "feat(api): /api/memory/extract — structured Haiku extraction behind its own rate limiter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Memory reaches the model and (when short) the classifier

**Files:**
- Modify: `lib/router.ts`
- Modify: `app/api/chat/route.ts`
- Test: `lib/__tests__/router.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/__tests__/router.test.ts` (add `buildClassifierPrompt` to the import):

```ts
describe("buildClassifierPrompt with memory", () => {
  it("prefixes short memory lines so routing can use standing preferences", () => {
    const p = buildClassifierPrompt([], "hi", ["Prefers concise answers", "Works in Rust"]);
    expect(p.startsWith("About the user:\n- Prefers concise answers\n- Works in Rust\n\n")).toBe(true);
    expect(p.endsWith("NEW USER MESSAGE:\nhi")).toBe(true);
  });
  it("omits memory entirely when it is long (spec §4.5)", () => {
    const long = Array(40).fill("x".repeat(60));
    expect(buildClassifierPrompt([], "hi", long)).toBe("NEW USER MESSAGE:\nhi");
  });
  it("is unchanged without memory", () => {
    expect(buildClassifierPrompt([], "hi")).toBe("NEW USER MESSAGE:\nhi");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/router.test.ts -t "with memory"`
Expected: FAIL.

- [ ] **Step 3: `lib/router.ts`**

Add the imports `import { estimateTokens } from "./compaction";` and `import { CLASSIFIER_MEMORY_TOKENS } from "./memory";`. Replace `buildClassifierPrompt`:

```ts
/** Build classifier input: (short memory) + last 4 turns (truncated) + the new
 *  message. Memory is included only when it is short (spec §4.5) — "prefers
 *  concise answers" can inform routing without paying to send all of it. */
export function buildClassifierPrompt(
  history: EasyUIMessage[],
  rawText: string,
  memoryLines: string[] = [],
): string {
  const memTokens = memoryLines.reduce((n, l) => n + estimateTokens(l) + 1, 0);
  const memory =
    memoryLines.length && memTokens <= CLASSIFIER_MEMORY_TOKENS
      ? `About the user:\n${memoryLines.map((l) => `- ${l}`).join("\n")}\n\n`
      : "";
  const recent = history.slice(-4).map((m) => {
    const text = messageText(m);
    const clipped = text.length > 500 ? text.slice(0, 500) + " […]" : text;
    return `${m.role === "user" ? "USER" : "ASSISTANT"}: ${clipped}`;
  });
  const context = recent.length ? `Conversation so far:\n${recent.join("\n")}\n\n` : "";
  return `${memory}${context}NEW USER MESSAGE:\n${rawText}`;
}
```

Extend `classify` with a fourth parameter `memoryLines: string[] = []` and pass it: `prompt: buildClassifierPrompt(history, rawText, memoryLines),`.

- [ ] **Step 4: `app/api/chat/route.ts`**

Add the import `import { MEMORY_CAP_TOKENS, MEMORY_TEXT_MAX } from "@/lib/memory";` and, after the compaction line, validate memory:

```ts
  // Memory lines: the client's own context, bounded here (spec §4.3, §7.4).
  // Anything malformed or oversized is dropped, not rejected.
  const memory = Array.isArray(context.memory)
    ? (context.memory as unknown[])
        .filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= MEMORY_TEXT_MAX)
        .slice(0, 200)
    : [];
  const memoryChars = memory.reduce((n, l) => n + l.length, 0);
  const memoryLines = memoryChars / 4 <= MEMORY_CAP_TOKENS * 1.1 ? memory : [];
```

Pass it to the classifier — `classify(history, rawText, provider, memoryLines)` — and to `assembleRequest` as `memory: memoryLines,` (after `instructions,`).

- [ ] **Step 5: Tests, typecheck, lint, commit**

Run: `npx vitest run && npm run typecheck && npm run lint`

```bash
git add lib/router.ts app/api/chat/route.ts lib/__tests__/router.test.ts
git commit -m "feat(chat): memory lines in the cached system layer; short memory informs routing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: UI — extraction hook, toast, `remember:`, Memory settings tab

**Files:**
- Create: `components/use-memory-extraction.ts`
- Create: `components/memory-toast.tsx`
- Modify: `components/chat-view.tsx`
- Modify: `components/settings-modal.tsx`

No React component tests in this repo; verification is typecheck + lint + the gate's e2e.

- [ ] **Step 1: Create `components/use-memory-extraction.ts`**

```ts
"use client";
import { useEffect, useRef } from "react";
import { costOf } from "@/lib/costs";
import { CLASSIFIER_MODEL } from "@/lib/pricing";
import { getUserKey } from "@/lib/client-key";
import { getSettings } from "@/lib/settings";
import {
  EXTRACT_IDLE_MS,
  EXTRACT_MIN_USER_TURNS,
  extractionSchema,
  mergeMemories,
  needsConsolidation,
  newUserTurnsSince,
  turnsSince,
} from "@/lib/memory";
import type { MemoryStore } from "@/lib/memory-store";
import type { ConversationStore } from "@/lib/storage";
import type { EasyUIMessage, Memory, TokenUsage } from "@/lib/types";

export const MEMORY_ADDED_EVENT = "easymode:memory-added";

// Survives remounts (the chat view remounts per conversation), so a switch
// away cannot start a second extraction for the same conversation.
const inFlight = new Set<string>();

/** Quiet-moment memory extraction (spec §5.2): when the user switches away
 *  from a conversation, or it sits idle for 10 minutes after an answer, and
 *  it has ≥ 2 unread user turns, send the new turns (raw text) plus the
 *  current memories to /api/memory/extract, merge, store, record the cost,
 *  and announce what was remembered. Never mid-stream; never blocking chat. */
export function useMemoryExtraction({
  conversationId,
  messages,
  status,
  store,
  memoryStore,
}: {
  conversationId: string;
  messages: EasyUIMessage[];
  status: string;
  store: ConversationStore;
  memoryStore: MemoryStore;
}) {
  // Latest values for the unmount trigger without re-subscribing.
  const latest = useRef({ messages, status });
  latest.current = { messages, status };

  const extract = async (snapshot: EasyUIMessage[]) => {
    if (!getSettings().memoryEnabled || inFlight.has(conversationId)) return;
    const through = store.getMeta(conversationId)?.extractedThrough;
    if (newUserTurnsSince(snapshot, through) < EXTRACT_MIN_USER_TURNS) return;
    const turns = turnsSince(snapshot, through);
    if (!turns.length) return;
    inFlight.add(conversationId);
    try {
      const before = memoryStore.list();
      const active = before.filter((m) => m.status === "active");
      const key = getUserKey();
      const r = await fetch("/api/memory/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { "x-anthropic-key": key } : {}) },
        body: JSON.stringify({
          turns,
          memories: active.map(({ id, text, kind }) => ({ id, text, kind })),
          consolidate: needsConsolidation(before),
        }),
      });
      if (!r.ok) {
        console.warn("[easymode] memory extraction failed:", r.status);
        return;
      }
      const data = (await r.json()) as { result?: unknown; usage?: TokenUsage };
      const result = extractionSchema.safeParse(data.result);
      if (!result.success) return;
      // Merge against the CURRENT list (the user may have edited meanwhile).
      const merged = mergeMemories(memoryStore.list(), result.data, {
        now: Date.now(),
        conversationId,
        newId: () => crypto.randomUUID(),
      });
      memoryStore.replaceAll(merged);
      if (data.usage) memoryStore.recordCost(costOf(CLASSIFIER_MODEL, data.usage));
      store.setExtractedThrough(conversationId, snapshot[snapshot.length - 1].id);
      const added = merged.filter((m) => !before.some((b) => b.id === m.id));
      if (added.length) {
        window.dispatchEvent(new CustomEvent<Memory[]>(MEMORY_ADDED_EVENT, { detail: added }));
      }
    } catch (err) {
      console.warn("[easymode] memory extraction failed:", err);
    } finally {
      inFlight.delete(conversationId);
    }
  };

  // Idle trigger: 10 minutes after the thread goes ready.
  useEffect(() => {
    if (status !== "ready") return;
    const t = setTimeout(() => void extract(latest.current.messages), EXTRACT_IDLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- extract reads through refs/stores
  }, [status, messages]);

  // Switch-away trigger: the chat view unmounts on conversation change.
  useEffect(() => {
    return () => {
      if (latest.current.status === "ready") void extract(latest.current.messages);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount
  }, [conversationId]);
}
```

- [ ] **Step 2: Create `components/memory-toast.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { MEMORY_ADDED_EVENT } from "./use-memory-extraction";
import type { MemoryStore } from "@/lib/memory-store";
import type { Memory } from "@/lib/types";

const TOAST_MS = 8_000;

/** "Remembered: … · Undo" (spec §5.6). Auto-save with undo: the user is
 *  informed, never asked. Undo archives the memory. */
export function MemoryToast({ memoryStore }: { memoryStore: MemoryStore }) {
  const [batch, setBatch] = useState<Memory[] | null>(null);

  useEffect(() => {
    const onAdded = (e: Event) => setBatch((e as CustomEvent<Memory[]>).detail);
    window.addEventListener(MEMORY_ADDED_EVENT, onAdded);
    return () => window.removeEventListener(MEMORY_ADDED_EVENT, onAdded);
  }, []);

  useEffect(() => {
    if (!batch) return;
    const t = setTimeout(() => setBatch(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [batch]);

  if (!batch?.length) return null;
  const first = batch[0];
  const more = batch.length - 1;
  return (
    <div className="pointer-events-none fixed bottom-24 left-1/2 z-40 -translate-x-1/2">
      <div className="animate-rise pointer-events-auto flex max-w-lg items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 text-[13px] text-ink shadow-[0_8px_30px_rgba(29,26,21,0.14)]">
        <span className="text-muted">Remembered:</span>
        <span className="truncate">
          {first.text}
          {more > 0 && <span className="text-muted"> +{more} more</span>}
        </span>
        <button
          onClick={() => {
            for (const m of batch) memoryStore.archive(m.id);
            setBatch(null);
          }}
          className="rounded-lg border border-line px-2 py-1 text-[12px] text-ink-soft hover:bg-paper"
        >
          Undo
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `components/chat-view.tsx`**

Imports to add:

```ts
import { useMemoryExtraction, MEMORY_ADDED_EVENT } from "./use-memory-extraction";
import { MemoryToast } from "./memory-toast";
import { browserMemoryStore } from "@/lib/memory-store";
import { memoryLines, parseRememberCommand } from "@/lib/memory";
import type { Memory } from "@/lib/types";
```

(Extend the existing `@/lib/types` type import rather than adding a second.) Inside the component, before `useChat`:

```ts
  // One store instance per view; it reads localStorage on every call.
  const [memoryStore] = useState(() => browserMemoryStore());
```

In the transport `body`, add memory lines to `context` (only when enabled):

```ts
            ...(getSettings().memoryEnabled ? { memory: memoryLines(memoryStore.active()) } : {}),
```

After the compaction hook, add:

```ts
  useMemoryExtraction({ conversationId, messages, status, store, memoryStore });

  // `remember: …` saves an explicit memory, then sends the rest (spec §5.5).
  const send = (text: string) => {
    const cmd = parseRememberCommand(text);
    if (cmd) {
      const m = memoryStore.add(cmd.memory, "fact", "user");
      window.dispatchEvent(new CustomEvent<Memory[]>(MEMORY_ADDED_EVENT, { detail: [m] }));
      if (!cmd.rest.trim()) return;
      sendMessage({ text: cmd.rest });
      return;
    }
    sendMessage({ text });
  };
```

Change the composer to `<Composer disabled={busy} onSend={send} />` and render the toast before the settings modal: `<MemoryToast memoryStore={memoryStore} />`.

- [ ] **Step 4: `components/settings-modal.tsx` — Memory tab**

Extend the tab type/list with `"memory"` / `["memory", "Memory"]` (after Instructions, before Context), render `<MemoryPanel />` for it, and add the imports:

```ts
import { useEffect } from "react";
import { setMemoryEnabled } from "@/lib/settings";
import { browserMemoryStore, MEMORY_CHANGE_EVENT } from "@/lib/memory-store";
import { formatUSD } from "@/lib/costs";
import type { Memory } from "@/lib/types";
```

(merge into the existing `react` and `@/lib/settings` imports). Add:

```tsx
/** Memory (spec §8): everything EasyMode has remembered, editable; the
 *  on/off switch; month-to-date extraction cost. Auto-save + undo lives in
 *  the toast; this is the audit and repair surface. */
function MemoryPanel() {
  const [store] = useState(() => browserMemoryStore());
  const [memories, setMemories] = useState<Memory[]>(() => store.active());
  const [enabled, setEnabled] = useState(() => getSettings().memoryEnabled);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    const refresh = () => setMemories(store.active());
    window.addEventListener(MEMORY_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(MEMORY_CHANGE_EVENT, refresh);
  }, [store]);

  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between text-[13px] text-ink">
        <span>
          Remember durable facts from my conversations
          <span className="block text-[12px] text-muted">
            A small background call after each conversation goes quiet. Stored in this browser only.
          </span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setMemoryEnabled(e.target.checked);
          }}
          aria-label="Memory enabled"
        />
      </label>

      <div className="max-h-72 space-y-1.5 overflow-y-auto">
        {memories.length === 0 && (
          <p className="text-[13px] text-muted">
            Nothing yet. Type <code className="rounded bg-paper px-1">remember: …</code> in a
            message to add one directly.
          </p>
        )}
        {memories.map((m) => (
          <div key={m.id} className="group flex items-start gap-2 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[13px]">
            <span className="mt-0.5 shrink-0 rounded bg-surface px-1.5 text-[10px] uppercase tracking-wider text-muted">
              {m.kind}
            </span>
            {editing?.id === m.id ? (
              <input
                autoFocus
                value={editing.text}
                onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                onBlur={() => {
                  store.update(m.id, editing.text);
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditing(null);
                }}
                className="flex-1 bg-transparent outline-none"
                aria-label="Edit memory"
              />
            ) : (
              <button
                onClick={() => setEditing({ id: m.id, text: m.text })}
                className="flex-1 text-left text-ink"
                title="Edit"
              >
                {m.text}
              </button>
            )}
            <button
              onClick={() => store.archive(m.id)}
              className="text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
              aria-label="Forget"
              title="Forget"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>Extraction this month: {formatUSD(store.monthCost())}</span>
        {memories.length > 0 &&
          (confirmClear ? (
            <span className="flex items-center gap-2">
              <span>Forget everything?</span>
              <button
                onClick={() => {
                  store.clearAll();
                  setConfirmClear(false);
                }}
                className="rounded-lg bg-rust px-2 py-1 text-[12px] font-medium text-paper"
              >
                Yes, clear
              </button>
              <button onClick={() => setConfirmClear(false)} className="rounded-lg border border-line px-2 py-1">
                Cancel
              </button>
            </span>
          ) : (
            <button onClick={() => setConfirmClear(true)} className="rounded-lg border border-line px-2 py-1 hover:bg-paper">
              Clear all
            </button>
          ))}
      </div>
    </div>
  );
}
```

Update the modal's doc comment to list the four tabs.

- [ ] **Step 5: Typecheck, lint, tests, commit**

Run: `npm run typecheck && npm run lint && npx vitest run`

```bash
git add components/use-memory-extraction.ts components/memory-toast.tsx components/chat-view.tsx components/settings-modal.tsx
git commit -m "feat(ui): memory — quiet-moment extraction, remember: command, undo toast, Memory settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Live extraction check, CI, README

**Files:**
- Create: `fixtures/memory-eval.json`, `scripts/check-memory.ts`
- Modify: `package.json`, `.github/workflows/ci.yml`, `README.md`

- [ ] **Step 1: Fixture** — `fixtures/memory-eval.json`: three short threads; `expect` are substrings that must appear (case-insensitive) in the added memories' text joined together; `forbid` are substrings that must NOT appear (sensitive-topic exclusions, task-specific noise).

```json
[
  {
    "name": "developer profile",
    "turns": [
      ["user", "I'm a backend developer at a fintech in Lisbon, we use Go and Postgres. Can you help me design a retry policy for our payment webhooks?"],
      ["assistant", "Sure. For payment webhooks in Go with Postgres, use exponential backoff with jitter and an idempotency table..."],
      ["user", "Great. One preference: keep answers short, I hate long explanations."],
      ["assistant", "Noted — short answers."]
    ],
    "expect": ["backend", "Lisbon", "Go", "short"],
    "forbid": ["webhook"]
  },
  {
    "name": "sensitive exclusion",
    "turns": [
      ["user", "I was diagnosed with diabetes last year and my mortgage is 300k, so I'm stressed. Anyway, I want to learn Spanish — I'm a native Portuguese speaker. Where do I start?"],
      ["assistant", "Since you're a native Portuguese speaker, Spanish will come quickly. Start with..."],
      ["user", "Thanks. I'd prefer resources that are free."],
      ["assistant", "Free options: ..."]
    ],
    "expect": ["Portuguese", "Spanish"],
    "forbid": ["diabetes", "mortgage", "300k"]
  },
  {
    "name": "explicit remember overrides",
    "turns": [
      ["user", "remember: my daughter Ana is allergic to peanuts, always check recipes for that"],
      ["assistant", "Noted: I'll check recipes for peanuts."],
      ["user", "ok give me a quick dinner idea"],
      ["assistant", "Here's a peanut-free option..."]
    ],
    "expect": ["peanut"],
    "forbid": ["dinner idea"]
  }
]
```

- [ ] **Step 2: Script** — `scripts/check-memory.ts`:

```ts
/** Live memory-extraction check (spec §9): every fixture thread must yield
 *  the expected facts and none of the forbidden ones (sensitive topics, task
 *  noise). Costs a few cents; main pushes / manual only. */
import { readFileSync } from "fs";
import { anthropic } from "@ai-sdk/anthropic";
import { runJob } from "../lib/api-helpers";
import { extractionSchema } from "../lib/memory";
import { EXTRACTION_SYSTEM, buildExtractionPrompt } from "../lib/prompts/memory";

interface Case {
  name: string;
  turns: [role: "user" | "assistant", text: string][];
  expect: string[];
  forbid: string[];
}

async function main() {
  const cases: Case[] = JSON.parse(readFileSync("fixtures/memory-eval.json", "utf8"));
  let failed = false;
  for (const c of cases) {
    const turns = c.turns.map(([role, text]) => ({ role, text }));
    const { result } = await runJob(anthropic, extractionSchema, EXTRACTION_SYSTEM, buildExtractionPrompt(turns, []));
    const text = result.add.map((a) => a.text).join(" | ").toLowerCase();
    const missing = c.expect.filter((e) => !text.includes(e.toLowerCase()));
    const leaked = c.forbid.filter((f) => text.includes(f.toLowerCase()));
    const ok = missing.length === 0 && leaked.length === 0;
    if (!ok) failed = true;
    console.log(
      `${ok ? "✅" : "❌"} ${c.name} → ${result.add.length} memories` +
        (missing.length ? ` — missing: ${missing.join(", ")}` : "") +
        (leaked.length ? ` — leaked: ${leaked.join(", ")}` : ""),
    );
  }
  if (failed) {
    console.error("\nMemory extraction missed a fact or kept something it must not.");
    process.exit(1);
  }
}

main();
```

- [ ] **Step 3: Scripts, CI, README**

`package.json`: `"eval:memory": "tsx scripts/check-memory.ts",` after `eval:compact`.

`.github/workflows/ci.yml` (live-checks, after the compaction step):

```yaml
      - name: Memory extraction (3 fixture threads)
        run: |
          if [ -z "$ANTHROPIC_API_KEY" ]; then echo "::warning::No ANTHROPIC_API_KEY secret - skipping memory check"; exit 0; fi
          npm run eval:memory
```

`README.md` "How it works", after the compaction paragraph:

```markdown
EasyMode remembers durable facts about you — role, tools, preferences, ongoing
projects — extracted by a small background call when a conversation goes quiet,
and saved with an undo ("Remembered: … · Undo"). Type `remember: …` to add one
directly. Everything lives under **Settings → Memory** (edit, forget, clear,
switch off) in your browser only; active memories ride at the start of every
request's cached prefix inside `<memory>`. Sensitive topics are excluded unless
you explicitly ask to remember them.
```

"Scripts": `    npm run eval:memory   # extraction keeps the right facts and drops sensitive ones (needs API key)`.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
git add fixtures/memory-eval.json scripts/check-memory.ts package.json .github/workflows/ci.yml README.md
git commit -m "test: live memory-extraction check (eval:memory) + CI step; document memory

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Gate (controller)

- `npm run lint && npm run typecheck && npm test && npm run build`
- Playwright e2e smoke; `eval:cache`; `eval:memory` (twice — the extractor is a model call).
- Manual (controller, key): `remember: I prefer pnpm` → toast + Settings → Memory shows it; next message's "how?" panel still routes; a two-turn conversation then switching conversations triggers extraction (network tab shows `/api/memory/extract`).
- PR stacked on #14.

## Self-review against the spec

- §5.1 data model → Task 1 (`Memory`), Task 3 (store). §5.2 trigger (switch/idle, ≥ 2 turns, `extractedThrough`, off switch) → Tasks 2, 6. §5.3 extractor (endpoint, own limiter, 30 s, raw text, conservative prompt, usage returned, cost shown) → Tasks 4, 6. §5.4 merge, dedup, cap → consolidate → Tasks 1, 6. §5.5 `remember:` → Tasks 1, 6. §5.6 auto-save + undo toast + panel → Task 6. §5.7 failure → Task 6 (log, retry next quiet moment since `extractedThrough` is unchanged); export → not built (noted).
- §4.3 rendering cap → Task 1 (`memoryLines`), Task 5 (route). §4.5 classifier sees short memory → Task 5.
- §7.1 `context.memory` with caps → Task 5. §7.2 shared helper + limiter → Task 4. §8 Memory tab → Task 6. §9 fixture → Task 7.
