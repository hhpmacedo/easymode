# EasyMode context layer — design

**Date:** 2026-09-18
**Status:** approved in discussion; ready for an implementation plan
**Builds on:** `2026-09-17-easymode-design.md` (router, rewrite, cost accounting)

## 1. Why

EasyMode's target user is a heavy Claude user who understands that models
differ in capability and price, pays their own bill (BYOK), and wants the app
to optimize for them automatically — not to be handed a model picker or asked
to review rewritten prompts. "A dashboard, not a cockpit."

For that user, spend is dominated by **context**, not by per-turn model rate.
A 30-turn thread with ~30K tokens of history costs ~10× more in input than in
output on every turn. The current design re-sends the full history uncached on
every request and has no system prompt, no memory, and no way to keep a long
thread in bounds. This spec adds the missing context layer:

1. a fixed **request-assembly order** with prompt-cache breakpoints;
2. a layered **system prompt** (base, user instructions, memory);
3. **memory** across conversations (explicit + automatically extracted);
4. **compaction** of long threads (visible, editable summary).

Everything is automatic by default, visible after the fact, and correctable
with at most one click. Nothing here asks the user to decide anything per turn.

## 2. Decisions already made (not re-litigated here)

- **Local-first.** Instructions, memory and conversations live in the browser
  and are sent with each request. The server stays stateless. IndexedDB
  migration is a separate spec; this one keeps `ConversationStore` and adds
  keys behind typed accessors so the backend can be swapped.
- **Ratchet.** Within a conversation the model tier never goes down; the
  classifier only ever asks "does this turn need *more*?". This is the
  precondition for caching to pay off (the cache is per model).
- **Rewrite stays, conservative.** The classifier's rewrite is tightened (see
  §4.4) rather than made interactive.
- **Out of scope:** projects, knowledge files, server persistence/accounts,
  retrieval over past chats, the Anthropic `memory` tool, server-side
  compaction beta, 1-hour cache TTL, non-Anthropic models.

## 3. Request assembly and cache layout

One pure function owns the shape of every answer call:

```ts
// lib/context.ts
assembleRequest(input: {
  base: string;                 // BASE_PROMPT
  instructions?: string;        // user instructions, ≤ 2,000 chars
  memory?: string[];            // active memory lines, ≤ ~1,500 tokens total
  compaction?: CompactionSummary;
  messages: EasyUIMessage[];    // full UI history (pre-boundary turns are dropped here)
  optimizedPrompt: string;      // rewrite of the latest user message
  today: string;                // "YYYY-MM-DD"
}): { system: SystemEntry[]; messages: ModelMessage[] }
```

Order is fixed, stable-first, because Anthropic's cache is a prefix match:

| # | Content | Volatility | Breakpoint |
|---|---|---|---|
| system[0] | `BASE_PROMPT` (frozen, `PROMPT_VERSION`) | never | |
| system[1] | `<user_instructions>…</user_instructions>` | rare | |
| system[2] | `<memory>…</memory>` | rare | **A** (on this entry) |
| system[3] | `Today is YYYY-MM-DD.` | daily | none |
| messages[0..1] | compaction pair: summary as `user`, short `assistant` ack | on compaction | |
| messages[…] | verbatim turns (optimized user prompts + assistant text) | append-only | |
| messages[last] | latest user turn = `optimizedPrompt` | every turn | **B** (on the text part) |

Breakpoints are set via `providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }`
on the system entry (A) and on the last user message's text part (B). Empty
instructions/memory omit their block entirely so the prefix is identical to
the no-instructions case.

**Why this works turn to turn:** everything before B is byte-identical between
turns (`buildModelMessages` already stores optimized prompts on metadata rather
than re-deriving them). Anthropic checks earlier block boundaries for hits, so
a new B each turn still reuses the previous prefix.

**What invalidates, and the accepted cost:**

| Event | Effect | Mitigation |
|---|---|---|
| Model tier change | full miss (cache is per model) | ratchet → escalate-only, ≤ a few times per thread |
| Instruction or memory edit | one miss per open thread | none needed; extraction results apply to new turns naturally |
| Date rollover | one miss per thread per day | date is last in `system`, ISO date only |
| Compaction | one miss | by design; net positive from the next turn |

**Minimum cacheable prefix** is model-dependent (4,096 tokens on Haiku 4.5;
assume 4K for all until verified per model). Caching therefore starts paying
once a thread passes a few thousand tokens, not on turn one. The classifier's
~300-token system prompt is below the minimum and is not cached.

**Not done, deliberately:** 1h TTL (2× write cost; active threads stay within
the 5-minute window), mid-conversation `system` messages (unsupported on
Sonnet 5, the workhorse tier).

### 3.1 Cost accounting becomes cache-aware

```ts
// lib/types.ts
interface TokenUsage {
  inputTokens: number; // TOTAL input, cached included (AI SDK semantics;
  //                      matches what stored conversations already hold)
  outputTokens: number;
  cacheReadTokens?: number; // subset of inputTokens; usage.inputTokenDetails.cacheReadTokens
  cacheWriteTokens?: number; // subset of inputTokens; usage.inputTokenDetails.cacheWriteTokens
}
```

`pricing.ts` gains `CACHE_READ_MULTIPLIER = 0.1` and
`CACHE_WRITE_MULTIPLIER = 1.25` (5-minute TTL). `costOf` prices
`inputTokens − read − write` at full rate and the two cache buckets at their
multipliers. `turnCosts` keeps its current shape (`tier/amount/pct`). Stored
conversations without cache fields read as zero → unchanged cost.

The reveal panel shows `input 41K tokens · 38K from cache` per turn. The
thread size the compaction threshold needs (§6.1) is simply
`usage.inputTokens` of the last turn; no separate field. Finish metadata also
carries `promptVersion` from step 2 onward.

### 3.2 Ratchet

In `applyGuardrail`, after the existing rules:
`if (priorModel && RANK[model] < RANK[priorModel]) model = priorModel`.
The existing "cap" rule already respects `priorModel`; this makes the floor
unconditional.

### 3.3 Output cap

`maxOutputTokens` by tier: Haiku 8K, Sonnet 16K, Opus/Fable 32K. This is a
runaway guard, not the cost control; the cost control is ratchet + caching.

## 4. System prompt layers

Rendered by `buildSystemPrompt()` in `lib/context.ts`. Three layers, one owner each.

### 4.1 Base prompt (`lib/prompts/base.ts`, ours)

~400–600 tokens. A single string constant; any edit bumps `PROMPT_VERSION`,
which is logged in each turn's metadata so eval regressions can be tied to a
prompt change. Content:

- Identity: EasyMode assistant; the app routes each message to the right
  Claude model and the user knows this — don't mention routing unless asked.
- Length: match the question. One line for one-line questions. No headers or
  bullet lists unless the content is genuinely structured.
- Mirror the user's language. Code in fenced blocks with a language tag.
- Say "I don't know" over guessing. No flattery, no restating the question.
- `<user_instructions>` are the user's preferences: they override these style
  rules but never honesty.
- `<memory>` is background about the user: use it silently, never announce
  "I remember…", and never let it override what the user says now.
- If a compaction summary is present, treat it as reliable, but prefer the
  verbatim recent turns on any conflict.

### 4.2 User instructions (the user's)

Settings → "How I like answers". Free text, ≤ 2,000 characters, rendered
inside `<user_instructions>`. Empty → block omitted.

### 4.3 Memory (extractor writes, user edits)

Rendered inside `<memory>` as one line per fact
(`- Works in TypeScript/Next.js; prefers pnpm`). Hard cap ~1,500 tokens
(estimate: chars/4). Over the cap the newest facts are rendered and the next
extraction runs in consolidate mode (§5.4).

### 4.4 Date

`Today is YYYY-MM-DD.` — last system entry, no breakpoint. **Nothing else
volatile ever goes into `system`**: no time, timezone, request id, or
conversation id. Enforced by a unit test that renders twice and asserts byte
equality.

### 4.5 Related prompt changes

- **Classifier rewrite instruction** is tightened: preserve the user's wording;
  add only what they clearly implied; if the message is under 15 words or
  conversational, return it unchanged. The guardrail enforces the last clause
  deterministically (`optimizedPrompt = rawText` when `words < 15`).
- **Classifier sees short memory only:** the memory lines are appended to the
  classifier prompt when their total is ≤ 300 tokens; otherwise none. This lets
  "prefers concise answers" influence routing without paying to send all of
  memory to Haiku every turn.

## 5. Memory

### 5.1 Data model (`lib/memory.ts`, key `easymode:memory`)

```ts
interface Memory {
  id: string;
  text: string;                 // one fact, one line, ≤ 200 chars
  kind: "profile" | "preference" | "project" | "fact";
  source: "user" | "extracted";
  conversationId?: string;      // where it was learned
  createdAt: number;
  updatedAt: number;
  status: "active" | "archived";
}
```

### 5.2 Trigger (client, `useMemoryExtraction`)

Runs when a conversation goes quiet — the user switches conversation, or
10 minutes pass after the last assistant turn — **and** it has ≥ 2 new user
turns since `extractedThrough` (a message id on `ConversationMeta`). Never
mid-stream, never blocking a send. One call per quiet event. Off entirely when
`settings.memoryEnabled === false`.

### 5.3 Extractor (`POST /api/memory/extract`)

Same auth (`resolveChatAuth`) and provider (`providerFor`) as chat; own
rate-limit rule (20 / 15 min); 30 s abort. Input: raw text of the new turns
(not the optimized prompts — memory is about the person) plus the current
active memories. One Haiku `generateObject` call:

```ts
{ add: { text: string; kind: Memory["kind"] }[];
  update: { id: string; text: string }[];
  archive: string[] }
```

Prompt is conservative: durable facts about the user, their work and standing
preferences only; nothing about the specific task in progress; nothing
sensitive (health, finances, relationships, credentials) unless the user
explicitly asked to remember it; return empty when unsure. Returns `usage` so
the client can show month-to-date extraction cost in Settings.

### 5.4 Merge (pure, `mergeMemories`)

- `add`: dedup against active memories by normalized token overlap (no
  embeddings); near-duplicates are dropped.
- `update` / `archive`: by id, ignoring unknown ids.
- Cap: if active memory would exceed ~1,500 tokens, the next extraction runs
  in **consolidate** mode — it receives the full set and is asked to return it
  as fewer, denser lines using the same schema.

### 5.5 Explicit memory

A message starting with `remember:` (case-insensitive, regex on the prefix) is
saved client-side as `source: "user"` with no extraction call, then sent
normally with the prefix stripped.

### 5.6 Review UX — auto-save with undo

New memories become active immediately. A toast reads
`Remembered: prefers pnpm · Undo`. Settings → Memory lists all memories with
inline edit, archive, and "clear all". The user is informed, never asked.

### 5.7 Failure

Timeout, bad key, refusal or schema failure → log, drop, retry from the same
`extractedThrough` at the next quiet event. Memory is sent to the server only
inside chat and extract requests, and is included in the conversation export.

## 6. Compaction (chat memory)

### 6.1 Threshold

After each turn, the answer call's `usage.inputTokens` (total input, cached
included) is the exact size of the thread. When it exceeds `settings.compactThreshold`
(default 60K; range 30K–200K) the client schedules a compaction **after** the
assistant turn finishes — never before a send. A manual "Compact now" action
lives in the conversation menu.

### 6.2 What is compacted

All messages except the most recent ~8K tokens of verbatim turns (whole turns
only; client-side token estimates are chars/4 throughout — memory cap, tail,
classifier memory limit). `POST /api/compact` — one Haiku `generateObject` call, 30 s abort, own
rate-limit rule (10 / 15 min):

```ts
interface CompactionSummary {
  goal: string;          // what the conversation is about
  decisions: string[];   // things settled
  facts: string[];       // constraints, data, names, numbers stated
  artifacts: string[];   // code/text the user may refer back to; verbatim if ≤ 40 lines
  open: string[];        // unresolved threads, pending questions
}
```

If a prior compaction exists its summary is part of the input; only the latest
summary is kept (a chain). If the previous summary was human-edited the prompt
says so and requires those edits be preserved.

### 6.3 Storage

On `ConversationMeta`:
`compaction?: { throughMessageId: string; summary: CompactionSummary; tokensBefore: number; createdAt: number; edited: boolean }`.
Pre-boundary messages stay in storage for display; `assembleRequest` drops them
and prepends the compaction pair.

### 6.4 UI

A card at the boundary: `Earlier conversation compacted — 52K → 3K tokens`,
collapsed by default; expandable to the structured summary with Edit (sets
`edited: true`). Older turns above the card remain visible, greyed, to signal
"the model no longer sees this."

### 6.5 Interactions and failure

- Ratchet: unchanged by compaction.
- Cache: one miss; net positive from the following turn.
- Memory extraction reads raw turns with its own `extractedThrough`; unaffected.
- Retry-on-stronger-model regenerates with the same context, summary included.
- Failure/timeout → log, retry after the next turn; thread keeps working
  uncompacted. A summary the schema rejects is never stored.

## 7. API surface and data flow

### 7.1 `POST /api/chat` (contract extended)

```ts
{ messages: EasyUIMessage[];
  context: { instructions?: string;           // ≤ 2,000 chars
             memory?: string[];               // ≤ ~1,500 tokens
             compaction?: CompactionSummary;
             promptVersion?: string } }       // server logs a mismatch
```

Flow: auth → parse + caps (200 KB body cap stays; per-field caps added) →
classify (with short memory, §4.5) → guardrail with ratchet →
`assembleRequest` → `streamText({ system, messages, maxOutputTokens })` →
metadata (`routing`, `classifierUsage` at start; `usage` with cache fields and
`promptVersion` at finish). The route no longer builds messages itself;
`lib/history.ts` folds into `lib/context.ts`.

### 7.2 `POST /api/memory/extract`, `POST /api/compact`

Share `lib/api-helpers.ts`: `resolveChatAuth` → `providerFor` → body caps →
one `generateObject` on `CLASSIFIER_MODEL` with a zod schema → `{ result, usage }`.
Separate `RateLimiter` rules (so a shared-key operator can bound background
jobs independently of chat). Under BYOK all three endpoints bill the user's key.

### 7.3 Client

`useContextBundle(conversationId)` reads settings, memory and the
conversation's compaction and supplies `body` to `DefaultChatTransport` at send
time (like the key header today). After each finish, `usage.inputTokens` feeds
`useCompaction`; the quiet detector feeds `useMemoryExtraction`. Neither hook
touches `useChat` state; they write to the store / conversation meta and the
view re-reads via the existing `onMessagesChanged`.

### 7.4 Trust

Unchanged: the client sends its own context, as it already sends its own
history. Under BYOK that is the user's prerogative; under shared-key it is
bounded by the existing token gate and body caps.

## 8. Storage and settings

- `easymode:settings` → `{ instructions: string; compactThreshold: number; memoryEnabled: boolean }`
- `easymode:memory` → `Memory[]`
- `ConversationMeta` += `compaction?`, `extractedThrough?`
- Typed accessors on `ConversationStore`; export includes memory + settings.

Settings panel (extends `KeySettings` into a tabbed modal): **Instructions**
(textarea + counter), **Memory** (list, edit, archive, clear all, month-to-date
extraction cost), **Context** (threshold slider, memory on/off). No model pickers.

## 9. Testing

Unit (pure functions, vitest):

- `assembleRequest`: byte-identical output for identical input; breakpoint
  positions; block omission when empty; date is last; pre-boundary turns
  dropped and compaction pair prepended.
- `buildSystemPrompt`: render-twice byte equality (no volatile content).
- `applyGuardrail`: never below `priorTier`; `optimizedPrompt` unchanged under 15 words.
- `mergeMemories`: dedup, update/archive by id, unknown ids ignored, cap → consolidate.
- Compaction boundary: whole turns, ~8K tail, chain input includes prior summary.
- `costOf` with cache multipliers; missing fields read as zero.
- Threshold and quiet detector with an injected clock (as `RateLimiter`).

Live, opt-in (extends `scripts/run-eval.ts`, needs a key):

- Two-turn cache check per tier: `cacheReadTokens > 0` on turn two.
- Extraction fixture (10 transcripts → expected facts and expected non-facts,
  including sensitive-topic exclusions).
- Compaction fixture (5 threads → rubric: each listed decision/fact preserved).

## 10. Rollout

Each step ships alone and is useful alone:

1. Cache-aware `TokenUsage`, pricing multipliers, ratchet, breakpoints,
   `maxOutputTokens`, "cached N of M" in the reveal. Pure savings.
2. Base prompt, user instructions, Settings tab, classifier rewrite tightening.
3. Compaction.
4. Memory (extraction, merge, panel, toast, `remember:`).

## 11. Open checks

- **Sonnet 5 price.** `pricing.ts` has $3/$15 (marked verified 2026-09-18);
  the Claude API reference available during this design lists $2/$10. Verify
  against the pricing page before step 1 — it changes every savings number.
- **Per-model minimum cacheable prefix** for Opus 5 / Sonnet 5 / Fable 5:
  confirm from the prompt-caching docs; the design assumes 4K.
- `ai`/`@ai-sdk/anthropic` versions in `package.json` expose
  `usage.inputTokenDetails.cacheReadTokens/cacheWriteTokens` and
  `providerOptions.anthropic.cacheControl` (verified against the installed
  `dist/index.d.ts` and `docs/05-anthropic.mdx` on 2026-09-18).
