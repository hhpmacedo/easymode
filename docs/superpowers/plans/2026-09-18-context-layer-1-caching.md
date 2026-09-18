# Context Layer, Plan 1 of 4 — Caching Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every answer call prompt-cache-friendly and cost-accounted — cache-aware `TokenUsage`, the tier ratchet, a single request-assembly function with two cache breakpoints, an output cap, and a "from cache" line in the reveal — with a live tripwire proving the cache hits.

**Architecture:** A new pure module `lib/context.ts` owns the shape of the answer request (system entries first, then turns, with Anthropic `cacheControl` breakpoints at the end of the stable system layer and on the latest user turn). `app/api/chat/route.ts` calls it instead of building messages itself. `lib/costs.ts` prices cache reads/writes at their multipliers; the guardrail gains a floor so a thread never drops tiers (the cache is per model). Spec: `docs/superpowers/specs/2026-09-18-context-layer-design.md` §3.

**Tech Stack:** Next.js 16 (App Router), AI SDK v7 (`ai`, `@ai-sdk/anthropic` — `providerOptions.anthropic.cacheControl`, `usage.inputTokenDetails`), TypeScript, vitest, tsx.

**Scope note:** This is rollout step 1 of the spec (§10). Steps 2 (base prompt + user instructions), 3 (compaction) and 4 (memory) are separate plans; each depends on `assembleRequest` from this one.

---

## File map

| File | Responsibility | Change |
|---|---|---|
| `lib/types.ts` | Shared types | `TokenUsage` gains optional `cacheReadTokens`, `cacheWriteTokens` |
| `lib/pricing.ts` | Prices and model constants (single source) | Add cache multipliers and `MAX_OUTPUT_TOKENS` |
| `lib/costs.ts` | Cost math | `costOf` prices cache buckets; add `formatTokens` |
| `lib/router.ts` | Classifier + deterministic guardrail | Ratchet floor in `applyGuardrail` |
| `lib/context.ts` | **New.** Request assembly with cache breakpoints | `assembleRequest`, `todayISO` |
| `lib/history.ts` | Optimized-prompt history (unchanged; `context.ts` wraps it) | none |
| `app/api/chat/route.ts` | Chat endpoint | Use `assembleRequest`, `maxOutputTokens`, cache fields in metadata |
| `components/optimization-reveal.tsx` | Per-turn "how?" panel | "from cache" line |
| `scripts/check-cache.ts` | **New.** Live two-turn cache tripwire | — |
| `package.json`, `.github/workflows/ci.yml`, `README.md` | Scripts, CI, docs | `eval:cache` |
| `lib/__tests__/costs.test.ts`, `router.test.ts`, **new** `context.test.ts` | Unit tests | — |

All commands run from the worktree root (`/home/hugo/dev/easymode/.claude/worktrees/context-layer`). Pre-commit runs eslint + prettier on staged files; if prettier reformats, the commit still goes through with the formatted file.

---

### Task 1: Cache-aware `TokenUsage` and cost math

**Files:**
- Modify: `lib/types.ts:17-20`
- Modify: `lib/pricing.ts`
- Modify: `lib/costs.ts:4-7`
- Test: `lib/__tests__/costs.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/__tests__/costs.test.ts`, inside the existing `describe("costOf", …)` block (after the "opus costs 5x haiku" test):

```ts
  it("prices cache reads at 10% of the input rate", () => {
    // 10,000 total input, of which 9,000 read from cache:
    // 1,000 * 1.0 + 9,000 * 1.0 * 0.1 = 1,900 → 0.0019
    const u = { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 9_000 };
    expect(costOf("claude-haiku-4-5", u)).toBeCloseTo(0.0019, 10);
  });
  it("prices cache writes at 125% of the input rate", () => {
    // 1,000 input, all written to cache: 1,000 * 1.0 * 1.25 = 1,250 → 0.00125
    const u = { inputTokens: 1_000, outputTokens: 0, cacheWriteTokens: 1_000 };
    expect(costOf("claude-haiku-4-5", u)).toBeCloseTo(0.00125, 10);
  });
  it("treats missing cache fields as zero (legacy stored turns)", () => {
    expect(costOf("claude-haiku-4-5", { inputTokens: 1000, outputTokens: 2000 })).toBeCloseTo(
      0.011,
      10,
    );
  });
  it("never prices negative uncached tokens if cache counts exceed the total", () => {
    const u = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 200 };
    expect(costOf("claude-haiku-4-5", u)).toBeCloseTo((200 * 0.1) / 1_000_000, 12);
  });
```

Add a new describe block at the end of the file:

```ts
describe("formatTokens", () => {
  it("shows small counts verbatim", () => {
    expect(formatTokens(842)).toBe("842");
  });
  it("shows thousands with one decimal under 10K", () => {
    expect(formatTokens(4_250)).toBe("4.3K");
  });
  it("shows whole thousands at 10K and above", () => {
    expect(formatTokens(41_300)).toBe("41K");
  });
});
```

Update the import line at the top of the file:

```ts
import { costOf, turnCosts, conversationSavings, formatUSD, formatTokens } from "../costs";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/costs.test.ts`
Expected: FAIL — `formatTokens` is not exported (TypeError / import error), and the two cache-pricing tests fail if the import error is fixed first.

- [ ] **Step 3: Extend `TokenUsage`**

In `lib/types.ts`, replace the `TokenUsage` interface:

```ts
/** Token counts for one model call. `inputTokens` is the TOTAL input (cached
 *  included — AI SDK semantics, and what stored conversations already hold);
 *  the cache fields are subsets of it. Absent on turns stored before caching
 *  existed, which read as zero. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

- [ ] **Step 4: Add the multipliers and output caps to `lib/pricing.ts`**

Append after `DEFAULT_FALLBACK_MODEL`:

```ts
/** Prompt-cache pricing relative to the model's input rate (5-minute TTL). */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Runaway guard on answer length, by tier — generous on purpose. The cost
 *  control is the tier ratchet plus caching, not this cap (spec §3.3). */
export const MAX_OUTPUT_TOKENS: Record<ModelId, number> = {
  "claude-haiku-4-5": 8_000,
  "claude-sonnet-5": 16_000,
  "claude-opus-5": 32_000,
  "claude-fable-5-1": 32_000,
  "claude-opus-4-8": 32_000,
  "claude-fable-5": 32_000,
};
```

- [ ] **Step 5: Price the cache buckets in `lib/costs.ts`**

Replace the import and `costOf`:

```ts
import {
  BASELINE_MODEL,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  CLASSIFIER_MODEL,
  PRICING,
} from "./pricing";
import type { ModelId, TokenUsage } from "./types";

/** USD for one call. Cached input is a subset of `inputTokens`: reads are
 *  billed at 10% of the input rate, writes at 125% (spec §3.1). */
export function costOf(model: ModelId, usage: TokenUsage): number {
  const p = PRICING[model];
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - read - write);
  const input =
    uncached * p.inputPerMTok +
    read * p.inputPerMTok * CACHE_READ_MULTIPLIER +
    write * p.inputPerMTok * CACHE_WRITE_MULTIPLIER;
  return (input + usage.outputTokens * p.outputPerMTok) / 1_000_000;
}
```

Append after `formatUSD`:

```ts
/** Compact token count for the UI: 842 · 4.3K · 41K. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run lib/__tests__/costs.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors (the optional fields don't break existing `{ inputTokens, outputTokens }` literals).

```bash
git add lib/types.ts lib/pricing.ts lib/costs.ts lib/__tests__/costs.test.ts
git commit -m "feat(costs): price prompt-cache reads/writes; add output caps per tier

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Tier ratchet in the guardrail

**Files:**
- Modify: `lib/router.ts:28-55` (`applyGuardrail`)
- Test: `lib/__tests__/router.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe("applyGuardrail", …)` in `lib/__tests__/router.test.ts`, after the "does not drop a short follow-up below the prior tier" test:

```ts
  it("ratchets: never drops below the prior tier, whatever the classifier says (spec §3.2)", () => {
    // Trivial follow-up after an Opus task stays on Opus — the cached thread is per model.
    expect(applyGuardrail("claude-haiku-4-5", "trivial", "ok thanks", "claude-opus-5")).toEqual({
      model: "claude-opus-5",
      applied: true,
    });
    // Everyday follow-up after a Fable task stays on Fable.
    expect(applyGuardrail("claude-sonnet-5", "everyday", MID20, "claude-fable-5-1").model).toBe(
      "claude-fable-5-1",
    );
    // Legacy prior ids rank the same as their successors.
    expect(applyGuardrail("claude-haiku-4-5", "trivial", "ok thanks", "claude-opus-4-8").model).toBe(
      "claude-opus-4-8",
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/__tests__/router.test.ts -t "ratchets"`
Expected: FAIL — first assertion returns `claude-haiku-4-5` (the floor only applies to code/long messages today).

- [ ] **Step 3: Add the ratchet**

In `lib/router.ts`, inside `applyGuardrail`, after the Fable-gate block and before `return`:

```ts
  // Ratchet: within a conversation the tier never goes down (spec §3.2). The
  // prompt cache is per model, so a downgrade would forfeit the cached thread
  // and usually cost more than it saves.
  if (priorModel && RANK[model] < RANK[priorModel]) {
    model = priorModel;
  }
```

Update the doc comment above the function to mention it:

```ts
/** Deterministic post-LLM guardrail. Pure; unit-tested. Only moves the choice
 *  within the pool — never invents a model. `priorModel` is the tier of the
 *  turn this message continues: a follow-up inherits at least that tier
 *  (acceptance criterion 3) and, since caching landed, never drops below it. */
```

- [ ] **Step 4: Run the whole router test file**

Run: `npx vitest run lib/__tests__/router.test.ts`
Expected: PASS. In particular "A prior tier at/below Sonnet does not weaken the cap" still passes (Sonnet ≥ Haiku, so the ratchet is a no-op there).

- [ ] **Step 5: Commit**

```bash
git add lib/router.ts lib/__tests__/router.test.ts
git commit -m "feat(router): ratchet — a thread never drops below its prior tier

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `lib/context.ts` — request assembly with cache breakpoints

**Files:**
- Create: `lib/context.ts`
- Test: `lib/__tests__/context.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/context.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assembleRequest, todayISO } from "../context";
import type { EasyUIMessage } from "../types";

function user(id: string, text: string): EasyUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as EasyUIMessage;
}
function assistant(id: string, text: string, optimizedPrompt?: string): EasyUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: optimizedPrompt ? { routing: { optimizedPrompt } as never } : undefined,
  } as EasyUIMessage;
}

const CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } };
const thread = [user("1", "raw one"), assistant("2", "answer one", "OPT one"), user("3", "raw two")];
const base = { messages: thread, optimizedPrompt: "OPT two", today: "2026-09-18" };

describe("todayISO", () => {
  it("formats a date as YYYY-MM-DD", () => {
    expect(todayISO(new Date("2026-09-18T23:59:00Z"))).toBe("2026-09-18");
  });
});

describe("assembleRequest", () => {
  it("is byte-identical for identical input (cache tripwire)", () => {
    expect(JSON.stringify(assembleRequest(base))).toBe(JSON.stringify(assembleRequest(base)));
  });

  it("with no instruction layer, system is just the date, and it carries no breakpoint", () => {
    const out = assembleRequest(base);
    const system = out.filter((m) => m.role === "system");
    expect(system).toEqual([{ role: "system", content: "Today is 2026-09-18." }]);
  });

  it("orders system entries base → instructions → memory → date", () => {
    const out = assembleRequest({
      ...base,
      base: "BASE",
      instructions: "  be terse  ",
      memory: ["prefers pnpm", "works in TS"],
    });
    const system = out.filter((m) => m.role === "system").map((m) => m.content);
    expect(system).toEqual([
      "BASE",
      "<user_instructions>\nbe terse\n</user_instructions>",
      "<memory>\n- prefers pnpm\n- works in TS\n</memory>",
      "Today is 2026-09-18.",
    ]);
  });

  it("omits empty blocks so the prefix matches the no-instructions case", () => {
    const out = assembleRequest({ ...base, base: "", instructions: "   ", memory: [] });
    expect(out.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("puts breakpoint A on the last stable system entry, never on the date", () => {
    const out = assembleRequest({ ...base, base: "BASE", memory: ["x"] });
    const system = out.filter((m) => m.role === "system");
    expect(system[0].providerOptions).toBeUndefined(); // BASE
    expect(system[1].providerOptions).toEqual(CACHE); // memory (last stable)
    expect(system[2].providerOptions).toBeUndefined(); // date
  });

  it("puts breakpoint B on the latest user turn's text part only", () => {
    const out = assembleRequest(base);
    const turns = out.filter((m) => m.role !== "system");
    expect(turns).toEqual([
      { role: "user", content: "OPT one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: [{ type: "text", text: "OPT two", providerOptions: CACHE }] },
    ]);
  });

  it("substitutes the optimized prompt for the latest user turn", () => {
    const out = assembleRequest({ ...base, optimizedPrompt: "REWRITTEN" });
    const last = out[out.length - 1];
    expect(last).toEqual({
      role: "user",
      content: [{ type: "text", text: "REWRITTEN", providerOptions: CACHE }],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/context.test.ts`
Expected: FAIL — cannot resolve `../context`.

- [ ] **Step 3: Create `lib/context.ts`**

```ts
/** Request assembly for the answer call (spec §3). One pure function owns the
 *  order of everything the model sees, because Anthropic's prompt cache is a
 *  prefix match: stable content first, volatile content last, and exactly two
 *  breakpoints —
 *    A: end of the instruction layer (base / user instructions / memory), so
 *       it is shared across all of a user's threads on the same model;
 *    B: the latest user turn, so the whole thread prefix is reused next turn.
 *  Anthropic checks earlier block boundaries for hits, so a new B each turn
 *  still matches the previous prefix. Everything before B must be
 *  byte-identical between turns — buildModelMessages guarantees that by
 *  reading optimized prompts from stored metadata, never re-deriving them. */
import type { ModelMessage } from "ai";
import { buildModelMessages } from "./history";
import type { EasyUIMessage } from "./types";

const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" as const } } };

export interface AssembleInput {
  /** Frozen base prompt (plan 2). Empty/undefined → omitted. */
  base?: string;
  /** The user's own instructions (plan 2). Blank → omitted. */
  instructions?: string;
  /** Active memory lines (plan 4). Empty → omitted. */
  memory?: string[];
  messages: EasyUIMessage[];
  optimizedPrompt: string;
  /** YYYY-MM-DD. The only volatile thing allowed in system, and it goes last. */
  today: string;
}

export function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function assembleRequest(input: AssembleInput): ModelMessage[] {
  const system: ModelMessage[] = [];
  if (input.base) system.push({ role: "system", content: input.base });
  const instructions = input.instructions?.trim();
  if (instructions) {
    system.push({
      role: "system",
      content: `<user_instructions>\n${instructions}\n</user_instructions>`,
    });
  }
  if (input.memory?.length) {
    system.push({
      role: "system",
      content: `<memory>\n${input.memory.map((m) => `- ${m}`).join("\n")}\n</memory>`,
    });
  }
  // Breakpoint A closes the stable layer (when there is one).
  if (system.length) {
    const last = system[system.length - 1];
    system[system.length - 1] = { ...last, providerOptions: CACHE_BREAKPOINT };
  }
  system.push({ role: "system", content: `Today is ${input.today}.` });

  const turns = buildModelMessages(input.messages, input.optimizedPrompt);
  const out: ModelMessage[] = turns.map((t) =>
    t.role === "user"
      ? { role: "user", content: t.content }
      : { role: "assistant", content: t.content },
  );
  // Breakpoint B on the latest user turn.
  const last = out.length - 1;
  if (last >= 0 && out[last].role === "user") {
    out[last] = {
      role: "user",
      content: [{ type: "text", text: turns[last].content, providerOptions: CACHE_BREAKPOINT }],
    };
  }
  return [...system, ...out];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/__tests__/context.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add lib/context.ts lib/__tests__/context.test.ts
git commit -m "feat(context): assembleRequest — fixed request order with two cache breakpoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Wire the chat route

**Files:**
- Modify: `app/api/chat/route.ts`

There are no unit tests for the route (it is glue over tested modules); verification is typecheck + lint + a manual two-turn check in the dev server, then Task 6's live tripwire.

- [ ] **Step 1: Update imports**

Replace the import block at the top of `app/api/chat/route.ts`:

```ts
import { streamText } from "ai";
import { classify, applyGuardrail, priorTier } from "@/lib/router";
import { latestUserText } from "@/lib/history";
import { assembleRequest, todayISO } from "@/lib/context";
import { DEFAULT_FALLBACK_MODEL, MAX_OUTPUT_TOKENS } from "@/lib/pricing";
import type {
  EasyMetadata,
  EasyUIMessage,
  ModelId,
  RoutingDecision,
  TokenUsage,
} from "@/lib/types";
import { resolveChatAuth } from "@/lib/auth";
import { providerFor } from "@/lib/provider";
```

- [ ] **Step 2: Replace the `run` helper**

Replace:

```ts
  // 2. Stream the answer from the chosen model, with optimized-prompt history.
  const run = (model: string) =>
    streamText({
      model: provider(model),
      messages: buildModelMessages(messages, routing.optimizedPrompt),
    });
```

with:

```ts
  // 2. Stream the answer from the chosen model. assembleRequest owns the
  //    message order and the prompt-cache breakpoints (spec §3); the output
  //    cap is a runaway guard, not the cost control.
  const today = todayISO();
  const run = (model: ModelId) =>
    streamText({
      model: provider(model),
      messages: assembleRequest({ messages, optimizedPrompt: routing.optimizedPrompt, today }),
      maxOutputTokens: MAX_OUTPUT_TOKENS[model],
    });
```

`run(routing.finalModel)` and `run("claude-opus-5")` below already pass `ModelId`-typed values; no change there.

- [ ] **Step 3: Carry cache counts in the finish metadata**

Replace the `finish` branch of `messageMetadata`:

```ts
      if (part.type === "finish") {
        const u = part.totalUsage;
        return {
          usage: {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            cacheReadTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
            cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens ?? 0,
          },
        };
      }
```

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean. If lint flags `u.inputTokenDetails?.` as an unnecessary optional chain, drop the `?` — the field is declared non-optional on `LanguageModelUsage`.

- [ ] **Step 5: Manual two-turn check**

Run: `npm run dev` (needs `ANTHROPIC_API_KEY` in `.env.local`). In the browser, send a first message of ~5,000 words (paste a long article) asking for a one-line summary, then a follow-up "and one more line". Open the second turn's "how?" panel: the cost table must show a non-zero cost, and after Task 5 the "from cache" line must show most of the input cached. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add app/api/chat/route.ts
git commit -m "feat(chat): assemble requests with cache breakpoints; cap output; report cache usage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Show caching in the reveal panel

**Files:**
- Modify: `components/optimization-reveal.tsx`

- [ ] **Step 1: Import `formatTokens`**

Change the costs import:

```ts
import { turnCosts, formatUSD, formatTokens } from "@/lib/costs";
```

- [ ] **Step 2: Add the input/cache line above the cost table**

Inside `{costs && (<section> … )}`, directly after `<Label>Cost — estimated</Label>`, insert:

```tsx
              {usage && (
                <p className="mb-2 text-[13px] text-ink-soft">
                  Input {formatTokens(usage.inputTokens)} tokens
                  {(usage.cacheReadTokens ?? 0) > 0 && (
                    <> · {formatTokens(usage.cacheReadTokens ?? 0)} from cache</>
                  )}
                  {(usage.cacheWriteTokens ?? 0) > 0 && (
                    <> · {formatTokens(usage.cacheWriteTokens ?? 0)} written to cache</>
                  )}
                </p>
              )}
```

- [ ] **Step 3: Typecheck, lint, visual check**

Run: `npm run typecheck && npm run lint`
Expected: clean.

Run: `npm run dev`, repeat the two-turn check from Task 4 step 5. Turn 1 shows "… written to cache"; turn 2 shows "… from cache" with most of the input. Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add components/optimization-reveal.tsx
git commit -m "feat(reveal): show input tokens and how many came from the prompt cache

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Live cache tripwire script, CI step, README

**Files:**
- Create: `scripts/check-cache.ts`
- Modify: `package.json` (scripts)
- Modify: `.github/workflows/ci.yml` (live-checks job)
- Modify: `README.md` (How it works, Scripts)

- [ ] **Step 1: Create `scripts/check-cache.ts`**

```ts
/** Prompt-cache tripwire (spec §9): two turns per tier through the real
 *  assembleRequest; turn two must report cacheReadTokens > 0. If it doesn't,
 *  something volatile crept into the prefix or a breakpoint moved. Costs real
 *  money (~80K input tokens across three tiers) — main pushes / manual only. */
import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { assembleRequest, todayISO } from "../lib/context";
import type { EasyUIMessage, ModelId } from "../lib/types";

const TIERS: ModelId[] = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"];

// ~12K tokens: comfortably above the largest per-model minimum cacheable
// prefix (4,096 tokens), so turn one's breakpoint B actually writes a cache.
const FILLER = Array(1200)
  .fill("The quick brown fox jumps over the lazy dog near the quiet riverbank.")
  .join(" ");

function user(id: string, text: string): EasyUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as EasyUIMessage;
}
function assistant(id: string, text: string, optimizedPrompt: string): EasyUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: { routing: { optimizedPrompt } as never },
  } as EasyUIMessage;
}

async function turn(model: ModelId, messages: EasyUIMessage[], optimizedPrompt: string) {
  const result = streamText({
    model: anthropic(model),
    messages: assembleRequest({ messages, optimizedPrompt, today: todayISO() }),
    maxOutputTokens: 20,
  });
  await result.text;
  return result.totalUsage;
}

async function main() {
  let failed = false;
  for (const model of TIERS) {
    const first = `${FILLER}\n\nReply with the single word OK.`;
    const t1 = [user("1", first)];
    const u1 = await turn(model, t1, first);
    const second = "Reply with the single word OK again.";
    const t2 = [...t1, assistant("2", "OK", first), user("3", second)];
    const u2 = await turn(model, t2, second);
    const written = u1.inputTokenDetails.cacheWriteTokens ?? 0;
    const read = u2.inputTokenDetails.cacheReadTokens ?? 0;
    const ok = read > 0;
    if (!ok) failed = true;
    console.log(
      `${ok ? "✅" : "❌"} ${model}: turn1 wrote ${written}, turn2 read ${read} of ${u2.inputTokens ?? 0} input tokens`,
    );
  }
  if (failed) {
    console.error("\nCache tripwire failed: a silent invalidator is in the prefix.");
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, after `"eval"`:

```json
    "eval:cache": "tsx scripts/check-cache.ts",
```

- [ ] **Step 3: Run it locally once**

Run: `npm run eval:cache` (needs `ANTHROPIC_API_KEY` in the environment; `tsx` does not load `.env.local`, so: `set -a; . ./.env.local; set +a; npm run eval:cache`).
Expected: three ✅ lines with `turn2 read` ≥ ~12,000 for every tier, exit code 0. If a tier reads 0, check that tier's minimum cacheable prefix in the Anthropic prompt-caching docs before touching `assembleRequest`.

- [ ] **Step 4: Add the CI step**

In `.github/workflows/ci.yml`, in the `live-checks` job, insert after the "Routing eval" step and before "E2E smoke":

```yaml
      - name: Prompt-cache tripwire (2 turns per tier)
        run: |
          if [ -z "$ANTHROPIC_API_KEY" ]; then echo "::warning::No ANTHROPIC_API_KEY secret - skipping cache check"; exit 0; fi
          npm run eval:cache
```

- [ ] **Step 5: Update the README**

In `README.md` "How it works", append a paragraph after the existing one:

```markdown
Every answer request is assembled in a fixed, stable-first order with two
Anthropic prompt-cache breakpoints (end of the instruction layer; the latest
user turn), and a thread never drops model tiers mid-conversation — the cache
is per model. Cached input is priced at 10% (reads) / 125% (writes) in the
cost estimate; the "how?" panel shows how much of each turn came from cache.
```

In "Scripts", after the `npm run eval` line:

```
    npm run eval:cache  # prompt-cache tripwire: turn two must read from cache (needs API key)
```

- [ ] **Step 6: Lint, full test run, commit**

Run: `npm run lint && npm test`
Expected: clean; all tests pass (55 pre-existing + those added in Tasks 1–3).

```bash
git add scripts/check-cache.ts package.json .github/workflows/ci.yml README.md
git commit -m "test: live prompt-cache tripwire (eval:cache) + CI step; document caching

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Final verification and PR

- [ ] **Step 1: Full local gate**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all clean.

- [ ] **Step 2: Open the PR**

```bash
git push -u origin worktree-context-layer
gh pr create --title "feat: prompt caching foundation — cache-aware costs, tier ratchet, request assembly" --body "$(cat <<'EOF'
Rollout step 1 of the context layer (spec: docs/superpowers/specs/2026-09-18-context-layer-design.md §3, §10).

- `TokenUsage` carries cache read/write counts; `costOf` prices them at 10% / 125%
- Guardrail ratchet: a thread never drops below its prior tier (cache is per model)
- New `lib/context.ts` `assembleRequest`: fixed stable-first order, breakpoint A (instruction layer) + B (latest user turn)
- `/api/chat` uses it, caps `maxOutputTokens` per tier, reports cache counts in metadata
- Reveal shows "Input 41K tokens · 38K from cache"
- `npm run eval:cache` live tripwire + CI step

Verification: unit tests (costs, router ratchet, context), typecheck/lint/build, `eval:cache` locally (3/3 tiers read from cache on turn two).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review against the spec

- §3 order/breakpoints → Task 3. §3 invalidation table: ratchet → Task 2; date-last → Task 3 test; compaction/instruction edits → later plans.
- §3.1 cache-aware usage and pricing → Task 1; reveal line → Task 5; `inputTokens` as thread size needs no extra field.
- §3.2 ratchet → Task 2. §3.3 output caps → Tasks 1 (constants) and 4 (wired).
- §7.1 route flow → Task 4 (the `context` request field arrives in plan 2 with instructions; nothing to receive yet).
- §9 unit tests: byte-identity, breakpoints, omission, date-last, ratchet, `costOf` multipliers, legacy zero → Tasks 1–3. Live two-turn cache check → Task 6.
- §11 open checks: Sonnet 5 price and per-model minimum prefix are **not** resolved by this plan — verify before merging (Task 6 step 3 will surface a wrong minimum as a ❌ on that tier).
- Not in this plan by design: base prompt, `promptVersion`, `PROMPT_VERSION` (plan 2); `history.ts` folding into `context.ts` (plan 3, when compaction changes `buildModelMessages`).
