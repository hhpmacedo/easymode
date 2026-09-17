# EasyMode — Design Spec (v1, thin vertical slice)

**Date:** 2026-09-17 · **Status:** Approved for planning · **Owner:** Hugo

## 1. Product summary

An AI chatbot web app (claude.ai-style) whose differentiator is **maximizing quality/price automatically**. The system assumes the user doesn't know how to prompt:

1. It rewrites each user message into an excellent prompt.
2. It routes the request to the cheapest Anthropic model that will do the job well.
3. It **shows its work**: rewritten prompt, chosen model + reasoning, and estimated savings vs always-using-Opus.

**Purpose:** portfolio/demo. Polished and real-feeling; not hardened for scale, billing, or multi-user production.

**v1 scope:** thin vertical slice — chat UI, prompt optimization, model routing, streaming, local persistence, conversation sidebar. **Out of scope:** auth, server DB, file attachments, user overrides, multi-provider, cost dashboard.

## 2. Stack

- **Next.js (App Router)** on Vercel
- **Vercel AI SDK v6** with the **`@ai-sdk/anthropic` provider** — one stack for everything: `generateObject` (classifier), `streamText` (answers), `useChat` (client). Direct provider (no AI Gateway) — we pick model IDs per call.
- **shadcn/ui + Tailwind** for UI
- **localStorage** for persistence (no DB)
- `ANTHROPIC_API_KEY` server-side only; all model calls go through route handlers.

## 3. Core loop (per user turn)

```
user sends raw message
  → [1 Haiku call] classify + rewrite + route (structured output)
  → reveal panel paints: optimized prompt, chosen model, reasoning, cost badge
  → [chosen model] streams answer using optimized prompt
```

### 3.1 Classifier call (the router brain)

- Model: `claude-haiku-4-5`, via `generateObject` with a strict schema.
- **Input:** last ~4 conversation turns (truncated to a budget) + the new raw message. Never context-blind.
- **Output schema:** `{ taskType, complexity, chosenModel, reasoning, optimizedPrompt }`.
- Rubric (in the classifier system prompt):

| Tier | Signals | Model |
|---|---|---|
| Trivial | greetings, format tweaks, short rewrites, simple facts | `claude-haiku-4-5` |
| Everyday | general Q&A, summaries, standard code, explanations | `claude-sonnet-5` |
| Hard | multi-step reasoning, nuanced analysis, tricky debugging, long/complex code | `claude-opus-4-8` |
| Exceptional | genuinely demanding long-horizon reasoning (rare) | `claude-fable-5` |

- **Follow-up rule:** a follow-up inherits at least the tier of the task it continues, unless it's a clear topic switch.
- **Deterministic guardrail** (pure function, applied *after* the LLM's choice, testable):
  - <15 words, no code, no question mark chain → cap at `claude-sonnet-5`.
  - Contains code block or >300 words → floor at `claude-sonnet-5`.
  - `claude-fable-5` only allowed when complexity = exceptional AND message >50 words.
  - Guardrail can only *move* the choice within the pool; it never invents a model.

### 3.2 History semantics (decided)

- API history sent to models carries the **optimized prompts** as user turns (optimization compounds).
- UI displays the **original** user text in the message bubble.
- Storage keeps **both** (`rawText`, `optimizedText`) per user message.

### 3.3 Answer call

- `streamText` with the chosen model and the optimized-prompt history.
- Fable/Opus 4.8/Sonnet 5 specifics respected: no `temperature`/`top_p`/`top_k`; no `thinking` config on Fable (always on); handle `stop_reason: "refusal"` (surface a friendly notice; on Fable, retry once on `claude-opus-4-8`).

## 4. Model catalog & pricing (single source of truth: `lib/pricing.ts`)

| Model | ID | Input $/1M | Output $/1M | Role |
|---|---|---|---|---|
| Haiku 4.5 | `claude-haiku-4-5` | 1.00 | 5.00 | trivial tier + classifier |
| Sonnet 5 | `claude-sonnet-5` | 3.00 | 15.00 | everyday tier |
| Opus 4.8 | `claude-opus-4-8` | 5.00 | 25.00 | hard tier + savings baseline |
| Fable 5 | `claude-fable-5` | 10.00 | 50.00 | exceptional tier (rare) |

Prices dated 2026-09-17 (Sonnet 5 intro pricing expired 2026-08-31 → sticker rates). All cost math imports from this file only.

## 5. Savings math (honest by construction)

- **Baseline:** always-Opus (`claude-opus-4-8`) counterfactual — Opus is the active ceiling; Fable is rare, so savings can go negative only on genuinely exceptional turns, and that's shown honestly.
- **Counterfactual estimate:** same optimized prompt tokens, same *actual* output token count from the real run, Opus prices. Labelled **"estimated"** in UI.
- **Formula:** `savings = opusCounterfactualCost − (chosenModelCost + classifierCost)`. The classifier's own Haiku cost is always counted against us and shown as its own line ("we spent $0.0004 to save $0.021").
- Routing savings and prompt optimization are **separate stories**: badge = routing savings; the reveal panel shows the prompt before/after without attaching a dollar figure to it.
- Running conversation total: "you've saved ~X% this conversation."
- Token counts come from the API responses' `usage` fields (never estimated client-side).

## 6. UI

- **`ChatView`** — main layout: sidebar + thread + composer.
- **Sidebar** — conversation list (localStorage): new chat, switch, rename, delete.
- **`MessageList`** — markdown rendering + syntax-highlighted code blocks; streaming text.
- **`OptimizationReveal`** — per-assistant-turn expandable panel. Collapsed: model chip + savings badge. Expanded: staged reveal (analyzing → optimized prompt diff → routing reasoning → cost breakdown incl. classifier line).
- **`SavingsBadge`** — per-turn estimated savings + running conversation total in the header.
- Status stages while waiting: `analyzing → optimizing → routing to <model> → streaming`.

## 7. Modules (server/lib)

| Module | Responsibility | Testable how |
|---|---|---|
| `app/api/chat/route.ts` | orchestrates classify → guardrail → stream; returns data stream with routing metadata | integration |
| `lib/router.ts` | classifier prompt, schema, guardrail function | guardrail: table-driven unit tests |
| `lib/pricing.ts` | model catalog + prices | trivially |
| `lib/costs.ts` | cost + counterfactual + savings math (pure functions) | unit tests |
| `lib/storage.ts` | localStorage conversations (both raw + optimized text) | unit tests (jsdom) |

## 8. Error handling

- Classifier failure/timeout → fall back to `claude-sonnet-5`, no rewrite (raw prompt), reveal panel shows "routing unavailable — used default".
- Stream error → inline error with retry button (re-uses same optimized prompt, skips re-classification).
- Fable `refusal` → one retry on Opus 4.8, notice in panel.
- No secrets or model calls client-side.

## 9. Testing

- **Unit:** guardrail table tests; cost math; storage.
- **Eval fixture:** ~20 prompts with expected tier *ranges* (`fixtures/routing-eval.json`), runnable via a script against the live classifier; manual/CI-optional.
- **E2E smoke:** one Playwright flow — send trivial message → Haiku badge; send code question → Sonnet+ badge; reveal panel opens; savings total updates.

## 10. Acceptance criteria

1. Send a message → answer streams; original text shown in bubble; optimized prompt visible in reveal panel.
2. "hi" routes to Haiku; a multi-step debugging request routes to Opus (guardrail-verified tiers).
3. Follow-up "now make it faster" after a hard task does **not** drop below the prior tier.
4. Savings badge shows estimated savings including classifier cost; conversation total accumulates.
5. Conversations persist across reloads; sidebar CRUD works.
6. Classifier outage degrades gracefully to Sonnet default.
