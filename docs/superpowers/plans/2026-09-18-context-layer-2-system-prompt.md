# Context Layer, Plan 2 of 4 — Base Prompt and User Instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every answer a real system prompt — a frozen, versioned base prompt plus the user's own standing instructions — delivered through the cached prefix built in plan 1, and tighten the classifier's rewrite so short/conversational messages pass through untouched.

**Architecture:** `lib/prompts/base.ts` holds `BASE_PROMPT` and `PROMPT_VERSION`. `lib/settings.ts` stores user instructions in localStorage (same pattern as `lib/client-key.ts`, with an injectable `Storage` so it is unit-testable). The chat transport sends `{ context: { instructions, promptVersion } }` alongside the messages; `/api/chat` validates it and passes `base` + `instructions` into `assembleRequest` (already supported since plan 1). A tabbed Settings modal replaces the key-only modal. The classifier's rewrite instruction is tightened and a deterministic `rewriteGuard` returns the raw text for messages under 15 words. Spec: `docs/superpowers/specs/2026-09-18-context-layer-design.md` §4, §7.1, §8.

**Tech Stack:** Next.js 16 (App Router), AI SDK v7, React 19, Tailwind 4, TypeScript, vitest.

**Depends on:** plan 1 (branch `feat/context-layer-1-caching`, PR #12) — `assembleRequest({ base, instructions, … })` and `EasyMetadata`.

---

## File map

| File | Responsibility | Change |
|---|---|---|
| `lib/prompts/base.ts` | **New.** Frozen base prompt + version | `BASE_PROMPT`, `PROMPT_VERSION` |
| `lib/settings.ts` | **New.** User settings in localStorage (client) | `readSettings`, `writeSettings`, `getSettings`, `setInstructions`, `SETTINGS_CHANGE_EVENT`, `INSTRUCTIONS_MAX` |
| `lib/router.ts` | Classifier + guardrail | Tightened rewrite instruction; `rewriteGuard` |
| `lib/types.ts` | Shared types | `ChatContext`; `EasyMetadata.promptVersion` |
| `app/api/chat/route.ts` | Chat endpoint | Parse/validate `context`; pass `base`/`instructions`; `rewriteGuard`; `promptVersion` in metadata |
| `components/key-settings.tsx` | Key connect/disconnect | Becomes a panel (`KeyPanel`) without modal chrome |
| `components/settings-modal.tsx` | **New.** Tabbed Settings modal (API key · Instructions) | — |
| `components/chat-view.tsx` | Chat screen | Uses `SettingsModal`; sends `context` in the transport body |
| `README.md` | Docs | Instructions paragraph |
| `lib/__tests__/prompts.test.ts`, `settings.test.ts`, `router.test.ts` | Unit tests | — |

Wave structure for parallel execution: **A** = Tasks 1, 2, 3 (disjoint files) · **B** = Tasks 4, 5 (disjoint files; both need A) · **C** = Task 6, then the gate.

All commands run from the worktree root. Pre-commit runs eslint + prettier on staged files.

---

### Task 1: Base prompt and version

**Files:**
- Create: `lib/prompts/base.ts`
- Test: `lib/__tests__/prompts.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BASE_PROMPT, PROMPT_VERSION } from "../prompts/base";

describe("base prompt", () => {
  it("has a date-stamped version so evals can be tied to prompt edits", () => {
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
  it("is short: roughly 300–800 tokens (spec §4.1)", () => {
    expect(BASE_PROMPT.length).toBeGreaterThan(1_200); // ~300 tokens at 4 chars/token
    expect(BASE_PROMPT.length).toBeLessThan(3_200); // ~800 tokens
  });
  it("names the context tags assembleRequest renders, so the two stay in sync", () => {
    expect(BASE_PROMPT).toContain("<user_instructions>");
    expect(BASE_PROMPT).toContain("<memory>");
  });
  it("contains nothing volatile (no dates, times or ids)", () => {
    expect(BASE_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(BASE_PROMPT).not.toMatch(/\b(today|now)\b.*\d/i);
  });
  it("is a single frozen string", () => {
    expect(typeof BASE_PROMPT).toBe("string");
    expect(BASE_PROMPT.trim()).toBe(BASE_PROMPT);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/prompts.test.ts`
Expected: FAIL — cannot resolve `../prompts/base`.

- [ ] **Step 3: Create `lib/prompts/base.ts`**

```ts
/** The frozen base system prompt (spec §4.1). Any edit bumps PROMPT_VERSION,
 *  which rides on each turn's metadata so an eval regression can be tied to a
 *  prompt change. Nothing volatile belongs here — dates go last in the system
 *  layer via assembleRequest, never in this string (the prompt cache is a
 *  prefix match, and this is the first thing in the prefix). */
export const PROMPT_VERSION = "2026-09-18.1";

export const BASE_PROMPT = `You are EasyMode, a chat assistant. EasyMode routes each message to the Claude model that fits it, and the person you are talking to knows that. Don't mention models or routing unless they ask.

How to answer
- Match the length of the question. A one-line question gets a one-line answer. Use headers or bullet lists only when the content is genuinely structured, and never for short answers.
- Reply in the language the person writes in.
- Put code in fenced blocks with a language tag. Prefer complete, runnable snippets over fragments.
- Be direct. No flattery, no restating the question, no "great question", no closing offers of further help.
- If you don't know or can't verify something, say so plainly rather than guessing. Distinguish what you know from what you infer.
- When asked for an opinion or a recommendation, give one, with the main reason.

Context you may be given
- <user_instructions> are this person's standing preferences for how they like answers. Follow them; they override the style rules above but never honesty or safety.
- <memory> is background about this person from earlier conversations. Use it silently to tailor answers. Never announce that you remember something, and never let it override what they say now.
- A compaction summary, if present, describes earlier parts of this conversation. Treat it as reliable, but when it conflicts with the verbatim recent turns, prefer the turns.`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/__tests__/prompts.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/prompts/base.ts lib/__tests__/prompts.test.ts
git commit -m "feat(prompts): frozen, versioned base system prompt

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Settings store (user instructions)

**Files:**
- Create: `lib/settings.ts`
- Test: `lib/__tests__/settings.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/settings.test.ts` (the `fakeStorage` helper mirrors `storage.test.ts`):

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/settings.test.ts`
Expected: FAIL — cannot resolve `../settings`.

- [ ] **Step 3: Create `lib/settings.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/__tests__/settings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck, commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add lib/settings.ts lib/__tests__/settings.test.ts
git commit -m "feat(settings): user instructions store (localStorage, testable)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Tighten the rewrite; deterministic `rewriteGuard`

**Files:**
- Modify: `lib/router.ts` (the `CLASSIFIER_SYSTEM` rewrite paragraph; new export)
- Test: `lib/__tests__/router.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/__tests__/router.test.ts`:

```ts
describe("rewriteGuard", () => {
  it("returns the user's own words for messages under 15 words (spec §4.5)", () => {
    expect(rewriteGuard("thanks, that worked", "Thank you; please confirm the fix worked.")).toBe(
      "thanks, that worked",
    );
  });
  it("keeps the rewrite for substantial messages", () => {
    const long = Array(20).fill("word").join(" ");
    expect(rewriteGuard(long, "REWRITTEN")).toBe("REWRITTEN");
  });
  it("falls back to the raw text when the rewrite is empty", () => {
    const long = Array(20).fill("word").join(" ");
    expect(rewriteGuard(long, "   ")).toBe(long);
  });
});
```

Update the import at the top of the file:

```ts
import { applyGuardrail, atLeastTier, rewriteGuard } from "../router";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/__tests__/router.test.ts -t "rewriteGuard"`
Expected: FAIL — `rewriteGuard` is not exported.

- [ ] **Step 3: Add `rewriteGuard` and tighten the classifier instruction**

In `lib/router.ts`, after `hasCode`:

```ts
/** Spec §4.5: short or conversational messages are sent as the user wrote
 *  them. The classifier is told the same, but this makes it deterministic —
 *  a rewrite of "thanks, that worked" is never an improvement. */
export const REWRITE_MIN_WORDS = 15;

export function rewriteGuard(rawText: string, optimizedPrompt: string): string {
  if (countWords(rawText) < REWRITE_MIN_WORDS) return rawText;
  return optimizedPrompt.trim() ? optimizedPrompt : rawText;
}
```

Replace the `1. REWRITE …` paragraph of `CLASSIFIER_SYSTEM` (currently: "1. REWRITE the message into an excellent prompt (optimizedPrompt): preserve the user's intent and language exactly; add structure, clarify implicit requirements, specify desired format/length when obvious. Never invent requirements the user didn't imply. For trivial messages (greetings, one-liners) minimal or no rewriting is correct.") with:

```
1. REWRITE the message into an excellent prompt (optimizedPrompt): keep the user's wording, intent and language; only add what they clearly implied (for example a format they obviously want). Never invent requirements, never change the ask, never expand a short message. If the message is conversational or under about 15 words, return it unchanged.
```

- [ ] **Step 4: Run the router tests**

Run: `npx vitest run lib/__tests__/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/router.ts lib/__tests__/router.test.ts
git commit -m "feat(router): conservative rewrite — short messages pass through verbatim

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Route accepts `context`; base prompt + instructions reach the model

**Files:**
- Modify: `lib/types.ts`
- Modify: `app/api/chat/route.ts`

No route unit tests exist (glue over tested modules); verification is typecheck + lint, and the Task 6 gate runs the e2e smoke.

- [ ] **Step 1: Types**

In `lib/types.ts`, after `RoutingDecision`, add:

```ts
/** Per-request context the client sends with the messages (spec §7.1).
 *  Local-first: the browser owns instructions; the server only validates. */
export interface ChatContext {
  instructions?: string;
  /** The PROMPT_VERSION the client was built against; the server logs a mismatch. */
  promptVersion?: string;
}
```

In `EasyMetadata`, add a field with a comment:

```ts
  /** Base-prompt version the answer was generated with (arrives at finish). */
  promptVersion?: string;
```

- [ ] **Step 2: Route — imports**

In `app/api/chat/route.ts`, change the router import and add two imports:

```ts
import { classify, applyGuardrail, atLeastTier, priorTier, rewriteGuard } from "@/lib/router";
import { BASE_PROMPT, PROMPT_VERSION } from "@/lib/prompts/base";
import { INSTRUCTIONS_MAX } from "@/lib/settings";
```

and extend the types import to include `ChatContext`:

```ts
import type {
  ChatContext,
  EasyMetadata,
  EasyUIMessage,
  ModelId,
  RoutingDecision,
  TokenUsage,
} from "@/lib/types";
```

- [ ] **Step 3: Route — parse and validate `context`**

Replace the body-parsing block:

```ts
  let messages: EasyUIMessage[];
  try {
    ({ messages } = JSON.parse(raw));
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return Response.json({ error: "Expected 1–200 messages." }, { status: 400 });
  }
```

with:

```ts
  let messages: EasyUIMessage[];
  let context: ChatContext = {};
  try {
    ({ messages, context = {} } = JSON.parse(raw));
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return Response.json({ error: "Expected 1–200 messages." }, { status: 400 });
  }
  // The client owns instructions (spec §7.4); the server only bounds them.
  const instructions = typeof context.instructions === "string" ? context.instructions : "";
  if (instructions.length > INSTRUCTIONS_MAX) {
    return Response.json(
      { error: `Instructions are limited to ${INSTRUCTIONS_MAX} characters.` },
      { status: 400 },
    );
  }
  if (context.promptVersion && context.promptVersion !== PROMPT_VERSION) {
    console.warn(
      `[easymode] client prompt version ${context.promptVersion} ≠ server ${PROMPT_VERSION}`,
    );
  }
```

- [ ] **Step 4: Route — rewrite guard and context into `assembleRequest`**

In the classifier `try` block, change the routing assignment from

```ts
    routing = { ...decision, finalModel: model, guardrailApplied: applied, fallback: false };
```

to

```ts
    routing = {
      ...decision,
      optimizedPrompt: rewriteGuard(rawText, decision.optimizedPrompt),
      finalModel: model,
      guardrailApplied: applied,
      fallback: false,
    };
```

In `run`, pass the system layer:

```ts
  const run = (model: ModelId) =>
    streamText({
      model: provider(model),
      ...assembleRequest({
        base: BASE_PROMPT,
        instructions,
        messages,
        optimizedPrompt: routing.optimizedPrompt,
        today,
      }),
      maxOutputTokens: MAX_OUTPUT_TOKENS[model],
    });
```

In the `finish` metadata branch, add `promptVersion`:

```ts
      if (part.type === "finish") {
        const u = part.totalUsage;
        return {
          promptVersion: PROMPT_VERSION,
          usage: {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            cacheReadTokens: u.inputTokenDetails.cacheReadTokens ?? 0,
            cacheWriteTokens: u.inputTokenDetails.cacheWriteTokens ?? 0,
          },
        };
      }
```

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add lib/types.ts app/api/chat/route.ts
git commit -m "feat(chat): base prompt + user instructions in the cached system layer; rewrite guard; prompt version in metadata

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Settings modal (API key · Instructions) and transport context

**Files:**
- Modify: `components/key-settings.tsx` → export `KeyPanel` (content only)
- Create: `components/settings-modal.tsx`
- Modify: `components/chat-view.tsx`

- [ ] **Step 1: Turn `KeySettings` into a panel**

In `components/key-settings.tsx`: rename the component to `KeyPanel`, drop the `onClose` prop and the modal chrome (the outer fixed overlay `div`, the inner card `div`, and the title row with the ✕ button). The component returns the connected/disconnected content directly. Concretely, the export becomes:

```tsx
/** Connect / disconnect your own Anthropic key (the "API key" tab in Settings).
 *  The key stays in this browser (localStorage); we validate it against
 *  Anthropic before saving, then send it per request so it bills your account. */
export function KeyPanel() {
```

and the JSX returned is:

```tsx
  return saved ? (
    <div className="space-y-4">
      {/* …existing connected block, unchanged… */}
    </div>
  ) : (
    <form onSubmit={connect} className="space-y-3">
      {/* …existing form, unchanged… */}
    </form>
  );
```

(i.e. remove the `mt-4` from both containers; everything inside them stays as it is.)

- [ ] **Step 2: Create `components/settings-modal.tsx`**

```tsx
"use client";
import { useState } from "react";
import { KeyPanel } from "./key-settings";
import { getSettings, setInstructions, INSTRUCTIONS_MAX } from "@/lib/settings";

export type SettingsTab = "key" | "instructions";

/** The Settings modal (spec §8): API key · Instructions. Memory and Context
 *  tabs arrive with plans 3–4. Opens from the header; `initialTab` lets the
 *  "connect a key" flows land on the key tab. */
export function SettingsModal({
  onClose,
  initialTab = "key",
}: {
  onClose: () => void;
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 px-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-[0_8px_40px_rgba(29,26,21,0.18)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Settings"
      >
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif text-xl italic text-ink">Settings</h2>
          <button onClick={onClose} className="text-sm text-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="mt-4 flex gap-1 border-b border-line" role="tablist">
          {(
            [
              ["key", "API key"],
              ["instructions", "Instructions"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
                tab === id
                  ? "border-ink text-ink"
                  : "border-transparent text-muted hover:text-ink-soft"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4">{tab === "key" ? <KeyPanel /> : <InstructionsPanel />}</div>
      </div>
    </div>
  );
}

/** "How I like answers" — standing preferences sent with every message inside
 *  <user_instructions> (spec §4.2). Saved on blur and on Save; stays in this
 *  browser. */
function InstructionsPanel() {
  // Client-only mount (modal opens on click), so reading localStorage here is safe.
  const [draft, setDraft] = useState(() => getSettings().instructions);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const save = () => {
    setInstructions(draft);
    setDraft(getSettings().instructions); // reflect trim/cap
    setSavedAt(Date.now());
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-soft">
        How you like answers. Applies to every conversation, on top of the built-in style. Stored
        in this browser only.
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, INSTRUCTIONS_MAX))}
        onBlur={save}
        rows={7}
        maxLength={INSTRUCTIONS_MAX}
        aria-label="Instructions"
        placeholder={
          "e.g. I'm a TypeScript developer; prefer pnpm and functional style.\nKeep answers short unless I ask for detail. Reply in Portuguese when I write in Portuguese."
        }
        className="w-full resize-y rounded-xl border border-line bg-paper px-3 py-2.5 text-sm leading-relaxed outline-none focus:border-line-strong"
      />
      <div className="flex items-center justify-between text-[12px] text-muted">
        <span className="tabular">
          {draft.length} / {INSTRUCTIONS_MAX}
        </span>
        <span className="flex items-center gap-3">
          {savedAt && <span className="text-pine-deep">Saved</span>}
          <button
            onClick={save}
            className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper transition-colors hover:bg-ink-soft"
          >
            Save
          </button>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire `chat-view.tsx`**

Replace the import of `KeySettings`:

```ts
import { SettingsModal, type SettingsTab } from "./settings-modal";
import { getSettings } from "@/lib/settings";
import { PROMPT_VERSION } from "@/lib/prompts/base";
```

Replace `const [settingsOpen, setSettingsOpen] = useState(false);` with a tab-aware state:

```ts
  // null = closed; otherwise which tab to open on.
  const [settings, setSettings] = useState<SettingsTab | null>(null);
```

and update every use: every `setSettingsOpen(true)` (the header button, `onConnectKey`, and the pending-suggestion flow in `onSuggestion`) → `setSettings("key")`; every `setSettingsOpen(false)` → `setSettings(null)`. Rename the header button's label from `API key` to `Settings` and its `title` to `"Settings: API key, instructions"`. The render line becomes:

```tsx
      {settings && <SettingsModal initialTab={settings} onClose={() => setSettings(null)} />}
```

Add the transport body next to `headers` in `DefaultChatTransport`:

```ts
      // Context rides with every send (spec §7.1). Read at send time so an
      // edit in Settings applies to the next message with no reload.
      body: () => ({
        context: { instructions: getSettings().instructions, promptVersion: PROMPT_VERSION },
      }),
```

- [ ] **Step 4: Typecheck, lint, manual check**

Run: `npm run typecheck && npm run lint`
Expected: clean.

Manual (needs `ANTHROPIC_API_KEY` in `.env.local`): `npm run dev`; open Settings → Instructions, save "Always answer in exactly three words."; send "what is prompt caching?"; the answer is three words. Open the "how?" panel on the answer: cost line present. Stop the dev server. (Skip if no key; the Task 6 gate runs the e2e smoke.)

- [ ] **Step 5: Commit**

```bash
git add components/key-settings.tsx components/settings-modal.tsx components/chat-view.tsx
git commit -m "feat(ui): Settings modal with API key and Instructions tabs; send context with each message

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: README, gate, PR

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

In `README.md` "How it works", after the caching paragraph added in plan 1, add:

```markdown
Every answer carries a short, versioned base system prompt (`lib/prompts/base.ts`)
and, if you set them under **Settings → Instructions**, your own standing
preferences ("how I like answers"). Both sit at the start of the cached prefix, so
they cost almost nothing per turn. Instructions live in your browser only.
```

- [ ] **Step 2: Full gate**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all clean; tests ≥ 91 (79 from plan 1 + 12 added here).

Run the e2e smoke with the project key (Playwright starts the dev server itself):
`set -a; . /home/hugo/dev/easymode/.env.local; set +a; npx playwright test`
Expected: 2 passed. If the key is unavailable, say so.

- [ ] **Step 3: Commit and PR**

```bash
git add README.md
git commit -m "docs: base prompt and user instructions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/context-layer-2-system-prompt
gh pr create --base feat/context-layer-1-caching --title "feat: base system prompt + user instructions (context layer 2/4)" --body "$(cat <<'EOF'
Rollout step 2 of the context layer (spec §4, §7.1, §8). Stacked on #12.

- `lib/prompts/base.ts`: frozen, versioned base prompt (PROMPT_VERSION rides on each turn's metadata)
- Settings → Instructions: "how I like answers", ≤ 2,000 chars, browser-only, sent as `context.instructions` and rendered inside `<user_instructions>` at the start of the cached prefix
- Classifier rewrite tightened; `rewriteGuard` sends messages under 15 words verbatim
- Settings modal now tabbed (API key · Instructions)

Verification: lint/typecheck/test/build; e2e smoke.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review against the spec

- §4.1 base prompt content and `PROMPT_VERSION` → Task 1; logged in metadata → Task 4.
- §4.2 user instructions, ≤ 2,000 chars, `<user_instructions>` block, empty → omitted (assembleRequest already does this) → Tasks 2, 4, 5.
- §4.4 date last, nothing volatile in system → plan 1; Task 1 test asserts the base prompt itself holds nothing volatile.
- §4.5 rewrite tightened + deterministic guard → Task 3; "classifier sees short memory" → plan 4 (no memory yet).
- §7.1 `context` field with caps and prompt-version mismatch log → Task 4. `memory` / `compaction` fields → plans 3–4.
- §7.3 `useContextBundle` → for this plan the bundle is one call (`getSettings()`); the hook arrives in plan 3 when compaction state joins it.
- §8 settings storage key `easymode:settings` with typed accessors → Task 2; tabs Memory/Context → plans 3–4.
- §9 tests: render-twice byte equality (plan 1 test covers assembleRequest; Task 1 covers the constant), settings round-trip/cap, rewrite guard → Tasks 1–3.
- Not in this plan: `buildSystemPrompt()` as a separate function — `assembleRequest` already renders the layers; a second function would duplicate it.
