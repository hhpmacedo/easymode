# Context Layer, Plan 3 of 4 — Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep long conversations cheap without losing them — when a thread's context passes a threshold, summarize the older turns into a structured, visible, editable compaction that the model reads instead of those turns, and show the user the context size at all times.

**Architecture:** The client owns compaction state (local-first): a pure `chooseCompactionBoundary` picks the last assistant turn such that ≥ ~8K tokens of whole turns remain verbatim; the client POSTs just those older turns (plus the prior summary, if any) to `/api/compact`, which runs one structured Haiku call behind its own rate limiter and returns a `CompactionSummary`. The result is stored on the conversation's meta; `assembleRequest` drops everything through the boundary and prepends a deterministic "compaction pair" (summary as a user turn, short assistant ack) so the cached prefix stays byte-stable. A card at the boundary shows the summary, expandable and editable; the header shows the context meter and a "Compact" action. Spec §6, §7.2, §7.3, §8.

**Tech Stack:** Next.js 16, AI SDK v7 (`generateObject`), zod 4, React 19, vitest.

**Depends on:** plans 1–2 (branch `feat/context-layer-2-system-prompt`, PR #13): `assembleRequest`, `ChatContext`, `lib/settings.ts`, the tabbed Settings modal.

**Spec deviations, decided here:** (1) threshold range is 30K–150K (spec said 200K) so the compaction input always fits the Haiku 4.5 window; (2) `lib/history.ts` is not folded into `context.ts` — `assembleRequest` slices the thread before calling `buildModelMessages`, which is smaller and keeps history's tests intact; (3) the `/api/chat` and `/api/compact` body caps are 2 MB / 1,000 messages, not the 200 KB / 200 the spec §7.1 keeps — a measured 150K-token thread serialises to ~900K chars over ~650 messages, so the spec cap would 413 before the first compaction at any threshold above ~30K. The caps bound one cycle only; the chat transport must therefore send just the turns from `throughMessageId` onward (Task 5, Step 4), otherwise the ever-growing stored thread outgrows them on the third cycle at the ceiling.

---

## File map

| File | Responsibility | Change |
|---|---|---|
| `lib/types.ts` | Shared types | `CompactionSummary`, `Compaction`, `ChatContext.compaction` |
| `lib/compaction.ts` | **New.** Pure compaction logic: zod schema, token estimate, boundary choice, deterministic rendering, transcript text, context parse | — |
| `lib/settings.ts` | Settings | `compactThreshold` (+ constants, clamp, setter) |
| `lib/storage.ts` | Conversation store | `getMeta`, `setCompaction`; `ConversationMeta.compaction` |
| `lib/context.ts` | Request assembly | Drop turns through the boundary; prepend the compaction pair |
| `lib/auth.ts` | Auth + rate limits | `resolveCompactAuth` (own limiter) via a shared `resolveAuth` |
| `lib/api-helpers.ts` | **New.** Bounded JSON body + one structured Haiku call | `readJsonBody`, `runJob` |
| `lib/prompts/compaction.ts` | **New.** Compaction system prompt + prompt builder | — |
| `app/api/compact/route.ts` | **New.** Compaction endpoint | — |
| `app/api/chat/route.ts` | Chat endpoint | Pass validated `context.compaction` to `assembleRequest` |
| `components/use-compaction.ts` | **New.** Threshold trigger + manual compaction hook | — |
| `components/compaction-card.tsx` | **New.** Boundary card: collapsed line, expanded summary, edit | — |
| `components/message-list.tsx` | Thread | Grey pre-boundary turns; render the card at the boundary |
| `components/chat-view.tsx` | Chat screen | Hook, header meter + Compact, `compaction` in transport body |
| `components/settings-modal.tsx` | Settings | "Context" tab: threshold slider |
| `scripts/check-compaction.ts`, `fixtures/compaction-eval.json` | **New.** Live compaction faithfulness check (`eval:compact`) | — |
| `README.md`, `.github/workflows/ci.yml`, `package.json` | Docs, CI, scripts | — |
| tests: `lib/__tests__/compaction.test.ts` (new), `settings.test.ts`, `storage.test.ts`, `context.test.ts`, `auth.test.ts` | Unit tests | — |

Waves: **A** = Tasks 1, 2 · **B** = Tasks 3, 4, 5 (all need A; disjoint files) · **C** = Tasks 6, 7 (need B; disjoint files) · then the gate.

---

### Task 1: Types and the pure compaction module

**Files:**
- Modify: `lib/types.ts`
- Create: `lib/compaction.ts`
- Test: `lib/__tests__/compaction.test.ts` (new)

- [ ] **Step 1: Types**

In `lib/types.ts`, after `RoutingDecision`, add:

```ts
/** Structured summary of compacted history (spec §6.2). Structured beats
 *  prose: more faithful for the model, scannable for the user. */
export interface CompactionSummary {
  goal: string;
  decisions: string[];
  facts: string[];
  artifacts: string[];
  open: string[];
}

/** A conversation's current compaction (spec §6.3). Turns up to and including
 *  `throughMessageId` stay in storage for display but are no longer sent to
 *  the model; the summary is sent in their place. Only the latest is kept —
 *  a re-compaction folds the previous summary in. */
export interface Compaction {
  throughMessageId: string;
  summary: CompactionSummary;
  /** Context size (usage.inputTokens) of the turn that triggered it. */
  tokensBefore: number;
  createdAt: number;
  /** The user edited the summary; a later compaction must preserve their edits. */
  edited: boolean;
}
```

In `ChatContext`, add:

```ts
  /** The conversation's compaction, if any: what to drop and what to say instead. */
  compaction?: Pick<Compaction, "throughMessageId" | "summary">;
```

- [ ] **Step 2: Write the failing tests**

Create `lib/__tests__/compaction.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  chooseCompactionBoundary,
  compactionSummarySchema,
  COMPACTION_ACK,
  estimateTokens,
  lastInputTokens,
  parseCompactionContext,
  renderCompaction,
  transcriptText,
} from "../compaction";
import type { CompactionSummary, EasyUIMessage } from "../types";

function user(id: string, text: string): EasyUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as EasyUIMessage;
}
function assistant(id: string, text: string, inputTokens?: number): EasyUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: inputTokens ? { usage: { inputTokens, outputTokens: 1 } } : undefined,
  } as EasyUIMessage;
}
/** A turn pair whose assistant text is ~`tokens` tokens (chars/4). */
function turn(n: number, tokens: number): EasyUIMessage[] {
  return [user(`u${n}`, `question ${n}`), assistant(`a${n}`, "x".repeat(tokens * 4))];
}

const summary: CompactionSummary = {
  goal: "Ship the caching layer",
  decisions: ["ratchet tiers", "two breakpoints"],
  facts: ["Sonnet 5 is $2/$10"],
  artifacts: [],
  open: ["memory extraction"],
};

describe("estimateTokens", () => {
  it("is chars/4, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("chooseCompactionBoundary", () => {
  it("returns null when the whole thread fits in the verbatim tail", () => {
    const msgs = [...turn(1, 1000), ...turn(2, 1000)];
    expect(chooseCompactionBoundary(msgs, undefined, 8000)).toBeNull();
  });
  it("picks the latest assistant turn that leaves at least the tail verbatim", () => {
    // tail budget 5K: a4 (3K) + a3 (3K) = 6K ≥ 5K, so the boundary is a2.
    const msgs = [...turn(1, 3000), ...turn(2, 3000), ...turn(3, 3000), ...turn(4, 3000)];
    const c = chooseCompactionBoundary(msgs, undefined, 5000);
    expect(c?.throughMessageId).toBe("a2");
    expect(c?.toCompact.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });
  it("only compacts turns after a previous boundary", () => {
    const msgs = [...turn(1, 3000), ...turn(2, 3000), ...turn(3, 3000), ...turn(4, 3000), ...turn(5, 3000)];
    const c = chooseCompactionBoundary(msgs, "a2", 5000);
    expect(c?.throughMessageId).toBe("a3");
    expect(c?.toCompact.map((m) => m.id)).toEqual(["u3", "a3"]);
  });
  it("returns null when nothing new lies before the tail", () => {
    const msgs = [...turn(1, 3000), ...turn(2, 3000), ...turn(3, 3000)];
    expect(chooseCompactionBoundary(msgs, "a2", 5000)).toBeNull();
  });
  it("never cuts inside a turn: the boundary is always an assistant message", () => {
    const msgs = [...turn(1, 3000), ...turn(2, 3000), user("u3", "x".repeat(20_000))];
    const c = chooseCompactionBoundary(msgs, undefined, 5000);
    expect(c?.throughMessageId).toBe("a2");
  });
});

describe("renderCompaction", () => {
  it("is deterministic and tagged, with one line per item", () => {
    const a = renderCompaction(summary);
    expect(a).toBe(renderCompaction({ ...summary }));
    expect(a.startsWith("<compaction_summary>")).toBe(true);
    expect(a.endsWith("</compaction_summary>")).toBe(true);
    expect(a).toContain("Goal: Ship the caching layer");
    expect(a).toContain("- ratchet tiers\n- two breakpoints");
    expect(a).toContain("Artifacts: none");
  });
  it("has a fixed assistant acknowledgement", () => {
    expect(COMPACTION_ACK.length).toBeGreaterThan(10);
  });
});

describe("transcriptText", () => {
  it("renders raw turns as USER/ASSISTANT lines", () => {
    expect(transcriptText([user("1", "hi"), assistant("2", "hello")])).toBe(
      "USER: hi\n\nASSISTANT: hello",
    );
  });
});

describe("lastInputTokens", () => {
  it("reads the latest assistant turn's context size, else 0", () => {
    expect(lastInputTokens([])).toBe(0);
    expect(lastInputTokens([user("1", "a"), assistant("2", "b", 41_000), user("3", "c")])).toBe(
      41_000,
    );
  });
});

describe("schemas", () => {
  it("accepts a well-formed summary and rejects a malformed one", () => {
    expect(compactionSummarySchema.safeParse(summary).success).toBe(true);
    expect(compactionSummarySchema.safeParse({ goal: 1 }).success).toBe(false);
  });
  it("parses a compaction context or returns undefined", () => {
    expect(parseCompactionContext({ throughMessageId: "a2", summary })).toEqual({
      throughMessageId: "a2",
      summary,
    });
    expect(parseCompactionContext({ throughMessageId: "", summary })).toBeUndefined();
    expect(parseCompactionContext(null)).toBeUndefined();
    expect(parseCompactionContext({ throughMessageId: "a2", summary: { goal: "x" } })).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/compaction.test.ts`
Expected: FAIL — cannot resolve `../compaction`.

- [ ] **Step 4: Create `lib/compaction.ts`**

```ts
/** Compaction of long threads (spec §6): pure pieces shared by the client
 *  (boundary choice, trigger) and the server (schema, transcript). Nothing
 *  here touches the network or storage. */
import { z } from "zod";
import { messageText } from "./types";
import type { CompactionSummary, EasyUIMessage } from "./types";

export const compactionSummarySchema = z.object({
  goal: z
    .string()
    .describe("One or two sentences: what the conversation is about and what the user wants"),
  decisions: z.array(z.string()).describe("Things that were settled, one per item"),
  facts: z
    .array(z.string())
    .describe("Constraints, data, names, numbers the user stated, one per item"),
  artifacts: z
    .array(z.string())
    .describe(
      "Code or text the user may refer back to: verbatim when 40 lines or fewer, else a precise description",
    ),
  open: z.array(z.string()).describe("Unresolved threads and pending questions"),
});

const compactionContextSchema = z.object({
  throughMessageId: z.string().min(1),
  summary: compactionSummarySchema,
});

/** Validate a client-supplied `context.compaction`; anything malformed is
 *  treated as "no compaction" rather than rejected — the user's own context. */
export function parseCompactionContext(
  value: unknown,
): { throughMessageId: string; summary: CompactionSummary } | undefined {
  const r = compactionContextSchema.safeParse(value);
  return r.success ? r.data : undefined;
}

/** Client-side token estimate: chars/4 throughout (spec §6.2). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Verbatim tail kept after the boundary (spec §6.2). */
export const COMPACT_TAIL_TOKENS = 8_000;

/** Pick what to compact: the turns after `since` (the previous boundary, if
 *  any) up to and including the latest ASSISTANT message such that at least
 *  `tailTokens` of whole turns remain verbatim after it. Null when there is
 *  nothing worth compacting. */
export function chooseCompactionBoundary(
  messages: EasyUIMessage[],
  since?: string,
  tailTokens: number = COMPACT_TAIL_TOKENS,
): { throughMessageId: string; toCompact: EasyUIMessage[] } | null {
  const sinceIdx = since ? messages.findIndex((m) => m.id === since) : -1;
  const start = sinceIdx + 1;
  let tail = 0;
  let boundary = -1;
  for (let i = messages.length - 1; i >= start; i--) {
    if (tail >= tailTokens && messages[i].role === "assistant") {
      boundary = i;
      break;
    }
    tail += estimateTokens(messageText(messages[i]));
  }
  if (boundary < start) return null;
  const toCompact = messages.slice(start, boundary + 1);
  if (!toCompact.some((m) => m.role === "user")) return null;
  return { throughMessageId: messages[boundary].id, toCompact };
}

/** The summary as the model sees it. Deterministic: the compaction pair sits
 *  inside the cached prefix, so identical input must render identical bytes. */
export function renderCompaction(s: CompactionSummary): string {
  const list = (title: string, items: string[]) =>
    items.length ? `${title}:\n${items.map((i) => `- ${i}`).join("\n")}` : `${title}: none`;
  return [
    "<compaction_summary>",
    `Goal: ${s.goal}`,
    list("Decisions", s.decisions),
    list("Facts", s.facts),
    list("Artifacts", s.artifacts),
    list("Open", s.open),
    "</compaction_summary>",
  ].join("\n\n");
}

/** The fixed assistant turn that follows the summary in the model messages. */
export const COMPACTION_ACK =
  "Understood — I have the summary of the earlier conversation and will continue from there.";

/** Raw transcript of turns for the compactor (user text as typed, not the
 *  optimized rewrite — the summary is about what the person said). */
export function transcriptText(messages: EasyUIMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${messageText(m)}`)
    .join("\n\n");
}

/** Context size of the latest answered turn (spec §6.1): the answer call's
 *  total input tokens, cached included. 0 before the first answer. */
export function lastInputTokens(messages: EasyUIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.metadata?.usage) return m.metadata.usage.inputTokens;
  }
  return 0;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/__tests__/compaction.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add lib/types.ts lib/compaction.ts lib/__tests__/compaction.test.ts
git commit -m "feat(compaction): types and pure module — schema, boundary choice, deterministic rendering

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Settings threshold and conversation-store compaction

**Files:**
- Modify: `lib/settings.ts`
- Modify: `lib/storage.ts`
- Test: `lib/__tests__/settings.test.ts`, `lib/__tests__/storage.test.ts`

- [ ] **Step 1: Write the failing tests**

In `lib/__tests__/settings.test.ts`, change the import to:

```ts
import {
  readSettings,
  writeSettings,
  INSTRUCTIONS_MAX,
  SETTINGS_KEY,
  COMPACT_THRESHOLD_DEFAULT,
  COMPACT_THRESHOLD_MIN,
  COMPACT_THRESHOLD_MAX,
} from "../settings";
```

Update the existing expectations that assert the whole object — `toEqual({ instructions: "" })` (three places) and `toEqual({ instructions: "be terse" })` — to include the default threshold:

```ts
{ instructions: "", compactThreshold: COMPACT_THRESHOLD_DEFAULT }
{ instructions: "be terse", compactThreshold: COMPACT_THRESHOLD_DEFAULT }
```

and the two `writeSettings(s, { instructions: … })` calls become `writeSettings(s, { instructions: …, compactThreshold: COMPACT_THRESHOLD_DEFAULT })`. Then append inside `describe("settings", …)`:

```ts
  it("round-trips the compaction threshold", () => {
    const s = fakeStorage();
    writeSettings(s, { instructions: "", compactThreshold: 90_000 });
    expect(readSettings(s).compactThreshold).toBe(90_000);
  });
  it("clamps the threshold into its allowed range and ignores junk", () => {
    const s = fakeStorage();
    writeSettings(s, { instructions: "", compactThreshold: 5 });
    expect(readSettings(s).compactThreshold).toBe(COMPACT_THRESHOLD_MIN);
    writeSettings(s, { instructions: "", compactThreshold: 10_000_000 });
    expect(readSettings(s).compactThreshold).toBe(COMPACT_THRESHOLD_MAX);
    s.setItem(SETTINGS_KEY, JSON.stringify({ instructions: "", compactThreshold: "lots" }));
    expect(readSettings(s).compactThreshold).toBe(COMPACT_THRESHOLD_DEFAULT);
  });
```

Append to `lib/__tests__/storage.test.ts` (it already defines `fakeStorage()` and imports `ConversationStore`):

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/settings.test.ts lib/__tests__/storage.test.ts`
Expected: FAIL — missing exports / methods.

- [ ] **Step 3: Extend `lib/settings.ts`**

Replace the `INSTRUCTIONS_MAX` line through `writeSettings` with:

```ts
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
}

const DEFAULTS: Settings = { instructions: "", compactThreshold: COMPACT_THRESHOLD_DEFAULT };

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
  return { instructions, compactThreshold };
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
```

Keep `getSettings` and `setInstructions` as they are, and add after `setInstructions`:

```ts
export function setCompactThreshold(compactThreshold: number): void {
  try {
    writeSettings(window.localStorage, { ...getSettings(), compactThreshold });
    window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
  } catch {
    // ignore, as above
  }
}
```

- [ ] **Step 4: Extend `lib/storage.ts`**

Add the import at the top: `import type { Compaction, EasyUIMessage } from "./types";` (replacing the existing `import type { EasyUIMessage } from "./types";`). Extend the interface:

```ts
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Spec §6.3: the latest compaction; older turns stay stored for display. */
  compaction?: Compaction;
}
```

Add two methods to `ConversationStore` after `rename`:

```ts
  getMeta(id: string): ConversationMeta | undefined {
    return this.readIndex().find((c) => c.id === id);
  }

  /** Set or clear a conversation's compaction. Deliberately does not bump
   *  updatedAt: compaction is bookkeeping, not activity, so the sidebar
   *  order stays put. */
  setCompaction(id: string, compaction: Compaction | undefined): void {
    const index = this.readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return;
    if (compaction) meta.compaction = compaction;
    else delete meta.compaction;
    this.writeIndex(index);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/__tests__/settings.test.ts lib/__tests__/storage.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: clean (plan 2's `settings-modal.tsx` still compiles: `setInstructions` and `getSettings().instructions` are unchanged).

```bash
git add lib/settings.ts lib/storage.ts lib/__tests__/settings.test.ts lib/__tests__/storage.test.ts
git commit -m "feat(settings,storage): compaction threshold setting; per-conversation compaction meta

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `assembleRequest` honours a compaction

**Files:**
- Modify: `lib/context.ts`
- Test: `lib/__tests__/context.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the imports of `lib/__tests__/context.test.ts`:

```ts
import { COMPACTION_ACK, renderCompaction } from "../compaction";
import type { CompactionSummary } from "../types";
```

Append inside `describe("assembleRequest", …)`:

```ts
  describe("with a compaction", () => {
    const summary: CompactionSummary = {
      goal: "g",
      decisions: ["d1"],
      facts: [],
      artifacts: [],
      open: ["o1"],
    };
    const long = [
      user("1", "raw one"),
      assistant("2", "answer one", "OPT one"),
      user("3", "raw two"),
      assistant("4", "answer two", "OPT two"),
      user("5", "raw three"),
    ];
    const input = {
      messages: long,
      optimizedPrompt: "OPT three",
      today: "2026-09-18",
      compaction: { throughMessageId: "2", summary },
    };

    it("drops turns through the boundary and prepends the compaction pair", () => {
      const { messages } = assembleRequest(input);
      expect(messages).toEqual([
        { role: "user", content: renderCompaction(summary) },
        { role: "assistant", content: COMPACTION_ACK },
        { role: "user", content: "OPT two" },
        { role: "assistant", content: "answer two" },
        { role: "user", content: [{ type: "text", text: "OPT three", providerOptions: CACHE }] },
      ]);
    });
    it("puts no breakpoint on the pair and keeps B on the latest user turn", () => {
      const { messages } = assembleRequest(input);
      expect(messages[0].providerOptions).toBeUndefined();
      expect(messages[1].providerOptions).toBeUndefined();
    });
    it("ignores a boundary id that is not in the thread", () => {
      const { messages } = assembleRequest({
        ...input,
        compaction: { throughMessageId: "missing", summary },
      });
      expect(messages).toHaveLength(5);
      expect(messages[0]).toEqual({ role: "user", content: "OPT one" });
    });
    it("is byte-identical for identical input", () => {
      expect(JSON.stringify(assembleRequest(input))).toBe(JSON.stringify(assembleRequest(input)));
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/context.test.ts`
Expected: FAIL — `compaction` is not part of `AssembleInput`; the compaction pair is absent.

- [ ] **Step 3: Implement**

In `lib/context.ts`, add to the imports:

```ts
import { COMPACTION_ACK, renderCompaction } from "./compaction";
import type { CompactionSummary, EasyUIMessage } from "./types";
```

(replacing the existing `EasyUIMessage`-only type import). Add to `AssembleInput`:

```ts
  /** Spec §6.3: drop turns through `throughMessageId`; send the summary instead. */
  compaction?: { throughMessageId: string; summary: CompactionSummary };
```

Replace the two lines

```ts
  const turns = buildModelMessages(input.messages, input.optimizedPrompt);
  const out: ModelMessage[] = turns.map((t) =>
```

with

```ts
  // Compaction: everything through the boundary is replaced by the summary
  // pair. An unknown boundary id means the stored compaction no longer
  // matches this thread — ignore it rather than drop the wrong turns.
  let thread: EasyUIMessage[] = input.messages;
  const pair: ModelMessage[] = [];
  if (input.compaction) {
    const idx = thread.findIndex((m) => m.id === input.compaction?.throughMessageId);
    if (idx >= 0) {
      thread = thread.slice(idx + 1);
      pair.push(
        { role: "user", content: renderCompaction(input.compaction.summary) },
        { role: "assistant", content: COMPACTION_ACK },
      );
    }
  }
  const turns = buildModelMessages(thread, input.optimizedPrompt);
  const out: ModelMessage[] = turns.map((t) =>
```

and change the final `return { instructions: system, messages: out };` to `return { instructions: system, messages: [...pair, ...out] };`. Update the header comment's bullet list to mention the pair: after the "B:" bullet add
`*    (A compaction pair — summary + fixed ack — may precede the turns; it is rendered deterministically so it stays inside the stable prefix.)`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/__tests__/context.test.ts`
Expected: PASS (all, including the pre-existing prefix-stability and MockLanguageModel tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
git add lib/context.ts lib/__tests__/context.test.ts
git commit -m "feat(context): compaction pair replaces turns through the boundary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `/api/compact` — auth limiter, job helper, prompt, route

**Files:**
- Modify: `lib/auth.ts`
- Create: `lib/api-helpers.ts`
- Create: `lib/prompts/compaction.ts`
- Create: `app/api/compact/route.ts`
- Test: `lib/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/__tests__/auth.test.ts` (read the file first to reuse its request-building helpers; if it has none, build requests with `new Request("http://localhost/api/compact", { headers })`):

```ts
describe("resolveCompactAuth", () => {
  it("accepts a caller with their own key and bills it", () => {
    const req = new Request("http://localhost/api/compact", {
      headers: { "x-anthropic-key": "sk-ant-" + "a".repeat(30) },
    });
    const auth = resolveCompactAuth(req);
    expect(auth.denied).toBeNull();
    expect(auth.apiKey).toBe("sk-ant-" + "a".repeat(30));
  });
  it("rate-limits per client independently of chat (10 per 15 minutes)", () => {
    const key = "sk-ant-" + "b".repeat(30);
    const mk = () =>
      new Request("http://localhost/api/compact", {
        headers: { "x-anthropic-key": key, "x-forwarded-for": "10.0.0.9" },
      });
    let last = resolveCompactAuth(mk());
    for (let i = 0; i < 10; i++) last = resolveCompactAuth(mk());
    expect(last.denied?.status).toBe(429);
    // Chat is untouched by the compaction limiter.
    expect(resolveChatAuth(mk()).denied).toBeNull();
  });
});
```

Add `resolveCompactAuth` (and `resolveChatAuth` if absent) to the file's import from `../auth`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/__tests__/auth.test.ts`
Expected: FAIL — `resolveCompactAuth` is not exported.

- [ ] **Step 3: `lib/auth.ts` — a limiter per job, one resolver**

After the three existing limiters add:

```ts
// Background jobs (compaction now, memory extraction next) get their own,
// tighter limiter so a shared-key operator can bound them independently.
const compactLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60_000 });
```

Change `guardChat` to take the limiter: `export function guardChat(req: Request, limiter: RateLimiter = chatLimiter): Response | null {` and use `limiter.check(clientKey(req))` inside. Then replace `resolveChatAuth` with:

```ts
function resolveAuth(req: Request, limiter: RateLimiter): ChatAuth {
  const userKey = extractUserKey(req);
  if (userKey) {
    const verdict = limiter.check(clientKey(req));
    if (!verdict.allowed) {
      return {
        denied: json(
          429,
          { error: "Too many requests. Try again shortly." },
          { "Retry-After": String(verdict.retryAfterSec) },
        ),
      };
    }
    return { denied: null, apiKey: userKey };
  }
  if (hasServerKey()) {
    return { denied: guardChat(req, limiter), apiKey: undefined };
  }
  return { denied: json(400, { error: CONNECT_MESSAGE }) };
}

/** Decide who pays for a chat request and whether it may proceed. (Doc comment
 *  as before: user key → bill them, rate-limited; server key → token gate;
 *  neither → 400.) */
export function resolveChatAuth(req: Request): ChatAuth {
  return resolveAuth(req, chatLimiter);
}

/** Same precedence as chat, on the compaction limiter (spec §7.2). */
export function resolveCompactAuth(req: Request): ChatAuth {
  return resolveAuth(req, compactLimiter);
}
```

(Keep the original three-point doc comment on `resolveChatAuth`.)

- [ ] **Step 4: Create `lib/api-helpers.ts`**

```ts
/** Shared plumbing for the small background-job endpoints (spec §7.2):
 *  a bounded JSON body, then one structured call on the cheapest model using
 *  the caller's provider (their key or the server's). SERVER ONLY. */
import { generateObject } from "ai";
import type { z } from "zod";
import { CLASSIFIER_MODEL } from "./pricing";
import type { AnthropicProvider } from "./provider";
import type { TokenUsage } from "./types";

export const JOB_TIMEOUT_MS = 30_000;

export async function readJsonBody(
  req: Request,
  maxBytes: number,
): Promise<{ body: unknown; error?: undefined } | { body?: undefined; error: Response }> {
  const raw = await req.text();
  if (raw.length > maxBytes) {
    return { error: Response.json({ error: "Request body too large." }, { status: 413 }) };
  }
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: Response.json({ error: "Malformed JSON body." }, { status: 400 }) };
  }
}

/** One Haiku call that must return `schema`. Throws on timeout/API failure;
 *  callers map that to a terse 502 and let the client retry later. */
export async function runJob<T>(
  provider: AnthropicProvider,
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
): Promise<{ result: T; usage: TokenUsage }> {
  const { object, usage } = await generateObject({
    model: provider(CLASSIFIER_MODEL),
    schema,
    system,
    prompt,
    abortSignal: AbortSignal.timeout(JOB_TIMEOUT_MS),
  });
  return {
    result: object,
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
  };
}
```

If `generateObject`'s `schema` parameter rejects `z.ZodType<T>` under the installed `ai` version, follow `lib/router.ts` (which passes a `z.object(...)` directly) and type the parameter as whatever `generateObject` accepts — keep the `{ result: T }` return typed via the schema's inferred output.

- [ ] **Step 5: Create `lib/prompts/compaction.ts`**

```ts
/** Prompts for the compaction job (spec §6.2). Server only. */
import { renderCompaction, transcriptText } from "../compaction";
import type { CompactionSummary, EasyUIMessage } from "../types";

export const COMPACTION_SYSTEM = `You compact the earlier part of a conversation between a user and an assistant into a structured summary that the assistant will read INSTEAD of those turns. The later turns of the conversation remain verbatim, so the summary only needs to cover what you are given.

Be faithful and specific. Keep names, numbers, constraints, file names, decisions, and the user's exact wording for anything they may refer back to. Prefer what the user stated over what the assistant guessed. Never invent, never editorialize, and never mention inside the fields that this is a summary.

artifacts: reproduce code or text verbatim when it is 40 lines or fewer; otherwise describe it precisely enough to be recognized.

If a PRIOR SUMMARY is provided, merge it: everything in it still holds unless the newer transcript changed it.`;

const PRIOR_EDITED_NOTE =
  "The PRIOR SUMMARY was edited by the user. Preserve its content exactly unless the newer transcript explicitly supersedes it.";

export function buildCompactionPrompt(
  messages: EasyUIMessage[],
  prior?: CompactionSummary,
  priorEdited = false,
): string {
  const head = prior
    ? `${priorEdited ? PRIOR_EDITED_NOTE + "\n\n" : ""}PRIOR SUMMARY:\n${renderCompaction(prior)}\n\n`
    : "";
  return `${head}TRANSCRIPT TO COMPACT:\n${transcriptText(messages)}`;
}
```

- [ ] **Step 6: Create `app/api/compact/route.ts`**

```ts
import { resolveCompactAuth } from "@/lib/auth";
import { providerFor } from "@/lib/provider";
import { readJsonBody, runJob } from "@/lib/api-helpers";
import { compactionSummarySchema } from "@/lib/compaction";
import { COMPACTION_SYSTEM, buildCompactionPrompt } from "@/lib/prompts/compaction";
import type { EasyUIMessage } from "@/lib/types";

export const maxDuration = 60;

// The client sends only the turns to compact: at most ~150K tokens of text
// (the threshold ceiling), which at chars/4 is ~600 KB plus JSON overhead.
const MAX_BODY_BYTES = 800_000;
const MAX_MESSAGES = 400;

/** Summarize older turns into a CompactionSummary (spec §6.2). One Haiku call
 *  on the caller's key (or the server's, behind the token gate). The client
 *  decides the boundary and stores the result; this endpoint is stateless. */
export async function POST(req: Request) {
  const auth = resolveCompactAuth(req);
  if (auth.denied) return auth.denied;

  const parsed = await readJsonBody(req, MAX_BODY_BYTES);
  if (parsed.error) return parsed.error;
  const body = (parsed.body ?? {}) as { messages?: unknown; prior?: unknown; priorEdited?: unknown };
  const messages = Array.isArray(body.messages) ? (body.messages as EasyUIMessage[]) : [];
  if (messages.length === 0 || messages.length > MAX_MESSAGES) {
    return Response.json({ error: `Expected 1–${MAX_MESSAGES} messages to compact.` }, { status: 400 });
  }
  const prior = compactionSummarySchema.safeParse(body.prior);

  try {
    const { result, usage } = await runJob(
      providerFor(auth.apiKey),
      compactionSummarySchema,
      COMPACTION_SYSTEM,
      buildCompactionPrompt(messages, prior.success ? prior.data : undefined, body.priorEdited === true),
    );
    return Response.json({ summary: result, usage });
  } catch (err) {
    console.error("[easymode] compaction failed:", err);
    return Response.json({ error: "Compaction failed. It will be retried later." }, { status: 502 });
  }
}
```

- [ ] **Step 7: Tests, typecheck, lint, commit**

Run: `npx vitest run lib/__tests__/auth.test.ts && npm run typecheck && npm run lint`
Expected: PASS / clean.

```bash
git add lib/auth.ts lib/api-helpers.ts lib/prompts/compaction.ts app/api/compact/route.ts lib/__tests__/auth.test.ts
git commit -m "feat(api): /api/compact — structured Haiku compaction behind its own rate limiter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: UI — trigger hook, boundary card, context meter, Context settings tab

**Files:**
- Create: `components/use-compaction.ts`
- Create: `components/compaction-card.tsx`
- Modify: `components/message-list.tsx`
- Modify: `components/chat-view.tsx`
- Modify: `components/settings-modal.tsx`

No unit tests for React components in this repo; verification is typecheck + lint, the existing unit suite, and the e2e smoke in the gate.

- [ ] **Step 1: Create `components/use-compaction.ts`**

```ts
"use client";
import { useCallback, useEffect, useRef } from "react";
import { chooseCompactionBoundary, compactionSummarySchema, lastInputTokens } from "@/lib/compaction";
import { getUserKey } from "@/lib/client-key";
import { getSettings } from "@/lib/settings";
import type { ConversationStore } from "@/lib/storage";
import type { EasyUIMessage } from "@/lib/types";

/** Compaction trigger (spec §6.1). Automatic: when a turn finishes and the
 *  thread's context exceeds the threshold, compact the older turns in the
 *  background — never before a send, so it adds no latency. Manual: the
 *  header's Compact action. Failures are logged and retried after the next
 *  turn; nothing here blocks chat. */
export function useCompaction({
  conversationId,
  messages,
  status,
  store,
  onChanged,
}: {
  conversationId: string;
  messages: EasyUIMessage[];
  status: string;
  store: ConversationStore;
  onChanged: () => void;
}) {
  const busy = useRef(false);

  const run = useCallback(async () => {
    if (busy.current) return;
    const prior = store.getMeta(conversationId)?.compaction;
    const choice = chooseCompactionBoundary(messages, prior?.throughMessageId);
    if (!choice) return;
    busy.current = true;
    try {
      const key = getUserKey();
      const r = await fetch("/api/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { "x-anthropic-key": key } : {}) },
        body: JSON.stringify({
          messages: choice.toCompact,
          prior: prior?.summary,
          priorEdited: prior?.edited ?? false,
        }),
      });
      if (!r.ok) {
        console.warn("[easymode] compaction request failed:", r.status);
        return;
      }
      const data: unknown = await r.json();
      const summary = compactionSummarySchema.safeParse(
        (data as { summary?: unknown } | null)?.summary,
      );
      if (!summary.success) return; // never store what the schema rejects
      store.setCompaction(conversationId, {
        throughMessageId: choice.throughMessageId,
        summary: summary.data,
        tokensBefore: lastInputTokens(messages),
        createdAt: Date.now(),
        edited: false,
      });
      onChanged();
    } catch (err) {
      console.warn("[easymode] compaction failed:", err);
    } finally {
      busy.current = false;
    }
  }, [conversationId, messages, store, onChanged]);

  // Automatic trigger: after the assistant turn finishes, if over threshold.
  useEffect(() => {
    if (status !== "ready") return;
    if (lastInputTokens(messages) > getSettings().compactThreshold) void run();
  }, [status, messages, run]);

  return { compactNow: run, contextTokens: lastInputTokens(messages) };
}
```

- [ ] **Step 2: Create `components/compaction-card.tsx`**

```tsx
"use client";
import { useState } from "react";
import { estimateTokens, renderCompaction } from "@/lib/compaction";
import { formatTokens } from "@/lib/costs";
import type { Compaction, CompactionSummary } from "@/lib/types";

const SECTIONS: { key: keyof Omit<CompactionSummary, "goal">; label: string }[] = [
  { key: "decisions", label: "Decisions" },
  { key: "facts", label: "Facts" },
  { key: "artifacts", label: "Artifacts" },
  { key: "open", label: "Open" },
];

/** The boundary card (spec §6.4): what the model now sees instead of the
 *  greyed turns above it. Collapsed by default; expandable; editable. */
export function CompactionCard({
  compaction,
  onSave,
}: {
  compaction: Compaction;
  onSave: (summary: CompactionSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CompactionSummary>(compaction.summary);
  const after = estimateTokens(renderCompaction(compaction.summary));

  const startEdit = () => {
    setDraft(compaction.summary);
    setEditing(true);
    setOpen(true);
  };
  const save = () => {
    onSave({
      goal: draft.goal.trim(),
      decisions: lines(draft.decisions),
      facts: lines(draft.facts),
      artifacts: lines(draft.artifacts),
      open: lines(draft.open),
    });
    setEditing(false);
  };

  return (
    <div className="rounded-xl border border-dashed border-line bg-surface/60 text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] text-ink-soft hover:bg-paper/60"
      >
        <span className="text-muted">⇣</span>
        <span>
          Earlier conversation compacted — {formatTokens(compaction.tokensBefore)} → ~
          {formatTokens(after)} tokens
          {compaction.edited && <span className="text-muted"> · edited</span>}
        </span>
        <span className="ml-auto text-[11px] uppercase tracking-wider text-muted">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-4 py-3">
          {editing ? (
            <>
              <Field label="Goal">
                <input
                  value={draft.goal}
                  onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
                  className="w-full rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[13px] outline-none focus:border-line-strong"
                />
              </Field>
              {SECTIONS.map((s) => (
                <Field key={s.key} label={`${s.label} (one per line)`}>
                  <textarea
                    value={draft[s.key].join("\n")}
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value.split("\n") })}
                    rows={Math.max(2, Math.min(8, draft[s.key].length + 1))}
                    className="w-full resize-y rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[13px] leading-relaxed outline-none focus:border-line-strong"
                  />
                </Field>
              ))}
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditing(false)} className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-soft hover:bg-paper">
                  Cancel
                </button>
                <button onClick={save} className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink-soft">
                  Save
                </button>
              </div>
            </>
          ) : (
            <>
              <Field label="Goal">
                <p className="text-[13px] text-ink">{compaction.summary.goal}</p>
              </Field>
              {SECTIONS.map((s) => (
                <Field key={s.key} label={s.label}>
                  {compaction.summary[s.key].length ? (
                    <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-ink">
                      {compaction.summary[s.key].map((item, i) => (
                        <li key={i} className="whitespace-pre-wrap">
                          {item}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[13px] text-muted">none</p>
                  )}
                </Field>
              ))}
              <div className="flex justify-end">
                <button onClick={startEdit} className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-soft hover:bg-paper">
                  Edit
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">{label}</h4>
      {children}
    </div>
  );
}

function lines(items: string[]): string[] {
  return items.map((s) => s.trim()).filter(Boolean);
}
```

- [ ] **Step 3: `components/message-list.tsx` — grey the past, render the card**

Add to the imports: `import { CompactionCard } from "./compaction-card";` and extend the type import: `import type { Compaction, CompactionSummary, EasyUIMessage } from "@/lib/types";`. Add two props to `Props` and the destructuring:

```ts
  compaction?: Compaction;
  onSaveCompaction?: (summary: CompactionSummary) => void;
```

Before the `return`, compute the boundary index:

```ts
  // Turns through the compaction boundary are still shown, greyed: the model
  // no longer sees them (spec §6.4). The card sits right after the boundary.
  const boundary = compaction
    ? messages.findIndex((m) => m.id === compaction.throughMessageId)
    : -1;
```

In the `messages.map((m, i) => …)` callback, wrap both branches so each rendered message gets `className={boundary >= 0 && i <= boundary ? "opacity-50" : undefined}` on its outer `div` (append to the existing `className` strings: `animate-rise flex justify-end` / `animate-rise` become template strings adding ` opacity-50` when `i <= boundary`), and render the card after the boundary message: the map callback returns a fragment:

```tsx
        {messages.map((m, i) => (
          <Fragment key={m.id}>
            {m.role === "user" ? (
              …existing user bubble (outer div gets the opacity class)…
            ) : (
              …existing assistant block (outer div gets the opacity class)…
            )}
            {i === boundary && compaction && onSaveCompaction && (
              <CompactionCard compaction={compaction} onSave={onSaveCompaction} />
            )}
          </Fragment>
        ))}
```

(Import `Fragment` from react; move the `key` from the inner divs to the Fragment.)

- [ ] **Step 4: `components/chat-view.tsx` — hook, header meter, transport body, save handler**

Imports to add:

```ts
import { useCompaction } from "./use-compaction";
import { formatTokens } from "@/lib/costs";
import type { CompactionSummary } from "@/lib/types";
```

(`formatUSD`, `turnCosts`, `conversationSavings` are already imported from `@/lib/costs` — extend that import rather than adding a second one.)

Transport body — include the compaction (read at send time from the store):

```ts
      body: () => {
        const c = store.getMeta(conversationId)?.compaction;
        return {
          context: {
            instructions: getSettings().instructions,
            promptVersion: PROMPT_VERSION,
            ...(c ? { compaction: { throughMessageId: c.throughMessageId, summary: c.summary } } : {}),
          },
        };
      },
```

Send only the turns the server needs (spec deviation 3): the stored thread keeps every compacted turn, so posting all of it outgrows the 2 MB / 1,000-message caps after a few cycles. Slice in `prepareSendMessagesRequest` from the boundary message **inclusive** — `assembleRequest` ignores a `throughMessageId` it cannot find, so dropping the boundary message itself would silently send the full thread:

```ts
      prepareSendMessagesRequest: ({ messages, body }) => {
        const c = store.getMeta(conversationId)?.compaction;
        const idx = c ? messages.findIndex((m) => m.id === c.throughMessageId) : -1;
        return { body: { ...body, messages: idx > 0 ? messages.slice(idx) : messages } };
      },
```

(`body` here is the object the `body()` above produced. If the installed `ai` version names this hook differently, read `node_modules/ai/dist/index.d.ts` for `DefaultChatTransport` and use its request-preparing option.)

After the `useChat` call, add a small version counter so a store change re-renders the card, then the hook:

```ts
  // Compaction lives on the store's meta, not in useChat state; bump a
  // counter when it changes so the card and header re-read it.
  const [metaVersion, setMetaVersion] = useState(0);
  const onMetaChanged = useCallback(() => {
    setMetaVersion((v) => v + 1);
    onMessagesChanged();
  }, [onMessagesChanged]);
  const { compactNow, contextTokens } = useCompaction({
    conversationId,
    messages,
    status,
    store,
    onChanged: onMetaChanged,
  });
  const compaction = useMemo(
    () => store.getMeta(conversationId)?.compaction,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- metaVersion is the invalidation signal
    [store, conversationId, metaVersion],
  );
  const saveCompaction = (summary: CompactionSummary) => {
    if (!compaction) return;
    store.setCompaction(conversationId, { ...compaction, summary, edited: true });
    onMetaChanged();
  };
```

(Add `useCallback` to the react import.) In the header, after the Settings button, add the context meter + action:

```tsx
          {contextTokens > 0 && (
            <button
              onClick={() => void compactNow()}
              className="rounded-lg border border-line px-2.5 py-1 text-xs text-ink-soft transition-colors hover:bg-surface"
              title="Context the model sees on the next message. Click to summarize older turns now."
            >
              Context <span className="tabular">{formatTokens(contextTokens)}</span> · compact
            </button>
          )}
```

Pass the new props to `MessageList`: `compaction={compaction}` and `onSaveCompaction={saveCompaction}`.

- [ ] **Step 5: `components/settings-modal.tsx` — Context tab**

Extend the tab type and list:

```ts
export type SettingsTab = "key" | "instructions" | "context";
```

```ts
            [
              ["key", "API key"],
              ["instructions", "Instructions"],
              ["context", "Context"],
            ] as const
```

Render: `{tab === "key" ? <KeyPanel /> : tab === "instructions" ? <InstructionsPanel /> : <ContextPanel />}`. Extend the settings import with `setCompactThreshold, COMPACT_THRESHOLD_MIN, COMPACT_THRESHOLD_MAX` and add:

```tsx
/** Compaction threshold (spec §6.1): when a conversation's context passes it,
 *  older turns are summarized in the background after the next answer. */
function ContextPanel() {
  const [value, setValue] = useState(() => getSettings().compactThreshold);
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Long conversations get expensive because every message re-sends the whole thread. When a
        conversation grows past this size, EasyMode summarizes the older turns into a compact
        note the model reads instead — you can see and edit it in the thread.
      </p>
      <label className="block text-[13px] text-ink">
        Compact when a conversation exceeds{" "}
        <strong className="tabular">{Math.round(value / 1000)}K</strong> tokens
        <input
          type="range"
          min={COMPACT_THRESHOLD_MIN}
          max={COMPACT_THRESHOLD_MAX}
          step={10_000}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            setValue(v);
            setCompactThreshold(v);
          }}
          className="mt-2 w-full"
          aria-label="Compaction threshold"
        />
      </label>
      <p className="text-[12px] text-muted">
        Default 60K. Lower saves more; higher keeps more verbatim detail.
      </p>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck, lint, tests, commit**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: clean / all pass.

```bash
git add components/use-compaction.ts components/compaction-card.tsx components/message-list.tsx components/chat-view.tsx components/settings-modal.tsx
git commit -m "feat(ui): compaction — background trigger, boundary card with edit, context meter, Context settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Chat route honours `context.compaction`; spec notes

**Files:**
- Modify: `app/api/chat/route.ts`
- Modify: `docs/superpowers/specs/2026-09-18-context-layer-design.md`

- [ ] **Step 1: Route**

Add the import `import { parseCompactionContext } from "@/lib/compaction";`. After the instructions validation block, add:

```ts
  // A malformed compaction is ignored, not rejected: the client owns it and
  // the worst case is sending the full thread (spec §6.3, §7.4).
  const compaction = parseCompactionContext(context.compaction);
```

and pass `compaction,` into the `assembleRequest({ … })` call in `run` (after `instructions,`).

- [ ] **Step 2: Spec notes**

In the spec: §6.1 change "range 30K–200K" to "range 30K–150K (so the compaction input fits the Haiku 4.5 window)"; in §7.1 change the note "`lib/history.ts` folds into `lib/context.ts`" to "`lib/history.ts` stays; `assembleRequest` slices the thread at the boundary before calling it", and change "200 KB body cap stays" to "body cap is 2 MB / 1,000 messages so one compaction cycle's worth of thread fits; the client sends only the turns from the boundary onward" (plan deviation 3).

- [ ] **Step 3: Typecheck, lint, commit**

```bash
git add app/api/chat/route.ts docs/superpowers/specs/2026-09-18-context-layer-design.md
git commit -m "feat(chat): send the compaction pair instead of compacted turns

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Live compaction check, CI, README

**Files:**
- Create: `fixtures/compaction-eval.json`
- Create: `scripts/check-compaction.ts`
- Modify: `package.json`, `.github/workflows/ci.yml`, `README.md`

- [ ] **Step 1: Fixture**

Create `fixtures/compaction-eval.json` — two short threads with facts a faithful summary must keep (case-insensitive substring match anywhere in the rendered summary):

```json
[
  {
    "name": "api migration",
    "turns": [
      ["user", "We're migrating our billing service from Stripe's v2 API to v3 by October 15. The service is in services/billing/, TypeScript, and we must keep the webhook signature check exactly as is."],
      ["assistant", "Understood. Key constraints: deadline October 15, code in services/billing/, TypeScript, webhook signature verification unchanged. Do you want a phased cutover or a big-bang switch?"],
      ["user", "Phased. Start with the customer endpoints, then invoices. Also: our idempotency keys are 'bill-' followed by the order id, don't change that format."],
      ["assistant", "Phased it is: customers first, then invoices. Idempotency keys stay 'bill-<orderId>'. First step: add a v3 client under services/billing/v3/ behind a feature flag."]
    ],
    "expect": ["October 15", "services/billing", "webhook signature", "customer", "invoice", "bill-"]
  },
  {
    "name": "trip planning",
    "turns": [
      ["user", "Planning 5 days in Lisbon in March with my mother, who uses a cane, so no long uphill walks. Budget is about 1500 euros total excluding flights."],
      ["assistant", "Got it: 5 days, Lisbon, March, travelling with your mother who uses a cane — flat routes and taxis/trams over hills — and a 1,500 EUR budget excluding flights. Shall I plan day by day?"],
      ["user", "Yes. We definitely want one day in Sintra, and she wants to see the Jerónimos monastery. Skip nightlife entirely."],
      ["assistant", "Plan outline: Day 1 Belém incl. Jerónimos (flat), Day 2 Baixa/Alfama by tram 28 and taxi, Day 3 Sintra by train with a tuk-tuk between sights, Day 4 Parque das Nações (flat), Day 5 Cascais. No nightlife."]
    ],
    "expect": ["5 days", "Lisbon", "cane", "1500", "Sintra", "Jerónimos", "nightlife"]
  }
]
```

- [ ] **Step 2: Script**

Create `scripts/check-compaction.ts`:

```ts
/** Live compaction faithfulness check (spec §9): compact each fixture thread
 *  with the real prompt + model and assert every expected fact survives in
 *  the rendered summary. Costs a few cents; main pushes / manual only. */
import { readFileSync } from "fs";
import { anthropic } from "@ai-sdk/anthropic";
import { runJob } from "../lib/api-helpers";
import { compactionSummarySchema, renderCompaction } from "../lib/compaction";
import { COMPACTION_SYSTEM, buildCompactionPrompt } from "../lib/prompts/compaction";
import type { EasyUIMessage } from "../lib/types";

interface Case {
  name: string;
  turns: [role: "user" | "assistant", text: string][];
  expect: string[];
}

async function main() {
  const cases: Case[] = JSON.parse(readFileSync("fixtures/compaction-eval.json", "utf8"));
  let failed = false;
  for (const c of cases) {
    const messages = c.turns.map(
      ([role, text], i) =>
        ({ id: String(i), role, parts: [{ type: "text", text }] }) as EasyUIMessage,
    );
    const { result } = await runJob(
      anthropic,
      compactionSummarySchema,
      COMPACTION_SYSTEM,
      buildCompactionPrompt(messages),
    );
    const rendered = renderCompaction(result).toLowerCase();
    const missing = c.expect.filter((e) => !rendered.includes(e.toLowerCase()));
    const ok = missing.length === 0;
    if (!ok) failed = true;
    console.log(`${ok ? "✅" : "❌"} ${c.name}${ok ? "" : ` — missing: ${missing.join(", ")}`}`);
  }
  if (failed) {
    console.error("\nCompaction dropped facts it must keep.");
    process.exit(1);
  }
}

main();
```

- [ ] **Step 3: Scripts, CI, README**

`package.json` scripts, after `"eval:cache"`: `"eval:compact": "tsx scripts/check-compaction.ts",`

`.github/workflows/ci.yml`, in `live-checks` after the prompt-cache step:

```yaml
      - name: Compaction faithfulness (2 fixture threads)
        run: |
          if [ -z "$ANTHROPIC_API_KEY" ]; then echo "::warning::No ANTHROPIC_API_KEY secret - skipping compaction check"; exit 0; fi
          npm run eval:compact
```

`README.md` "How it works", after the base-prompt paragraph:

```markdown
Long conversations are compacted: when the context passes the threshold in
**Settings → Context** (default 60K tokens), the older turns are summarized in
the background into a structured note — goal, decisions, facts, artifacts, open
threads — that the model reads instead of those turns. The note appears in the
thread where the cut was made; open it to read or edit it. The header shows the
context size the next message will carry.
```

"Scripts": add `    npm run eval:compact  # compaction keeps the facts it must (needs API key)`.

- [ ] **Step 4: Typecheck (scripts/ is included), lint, commit**

```bash
git add fixtures/compaction-eval.json scripts/check-compaction.ts package.json .github/workflows/ci.yml README.md
git commit -m "test: live compaction faithfulness check (eval:compact) + CI step; document compaction

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Gate (controller)

- `npm run lint && npm run typecheck && npm test && npm run build`
- Playwright e2e smoke (project key).
- `npm run eval:cache` (prefix stability with the compaction pair absent — unchanged) and `npm run eval:compact`.
- Manual (controller, needs key): a conversation pushed past a temporarily low threshold (set 30K, paste a long article twice) compacts after the answer; the card appears, expands, edits; the next "how?" panel shows a much smaller input; the header meter drops.
- PR stacked on #13.

## Self-review against the spec

- §6.1 threshold from `usage.inputTokens`, default 60K, user-adjustable, after the turn, manual action → Tasks 2, 5. Range ceiling deviates (150K), stated.
- §6.2 tail ~8K whole turns, `/api/compact`, structured schema, chain via prior summary, edited preserved → Tasks 1, 4, 5.
- §6.3 storage on meta; assembleRequest drops + prepends → Tasks 2, 3, 6.
- §6.4 card, collapsed, expandable, editable, greyed past → Task 5.
- §6.5 failure: logged, retried next turn, schema-rejected never stored → Tasks 4, 5.
- §7.2 shared helper + own limiter → Task 4. §7.3 hooks → Task 5 (`useCompaction`; the context bundle stays inline in the transport body). §8 Context tab → Task 5.
- §9 live compaction fixture → Task 7; unit tests → Tasks 1–4.
- Not done: memory extraction (plan 4) reuses `resolveAuth`, `readJsonBody`, `runJob`.
