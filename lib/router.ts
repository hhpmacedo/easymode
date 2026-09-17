import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { CLASSIFIER_MODEL, PRICING } from "./pricing";
import { COMPLEXITIES, MODEL_IDS, messageText } from "./types";
import type { Complexity, EasyUIMessage, ModelId, TokenUsage } from "./types";

const RANK: Record<ModelId, number> = {
  "claude-haiku-4-5": 0,
  "claude-sonnet-5": 1,
  "claude-opus-4-8": 2,
  "claude-fable-5": 3,
};

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasCode(text: string): boolean {
  return /```|\btraceback\b|\bstack trace\b|\berror:\s/i.test(text);
}

/** Deterministic post-LLM guardrail. Pure; unit-tested. Only moves the choice
 *  within the pool — never invents a model. `priorModel` is the tier of the
 *  turn this message continues (follow-up inheritance, acceptance criterion 3). */
export function applyGuardrail(
  chosen: ModelId,
  complexity: Complexity,
  rawText: string,
  priorModel?: ModelId,
): { model: ModelId; applied: boolean } {
  const words = countWords(rawText);
  const code = hasCode(rawText);
  const questions = (rawText.match(/\?/g) ?? []).length;
  let model = chosen;

  // Cap: tiny, code-free, single-question messages never need Opus/Fable —
  // but a follow-up never drops below the tier of the task it continues.
  const cap: ModelId =
    priorModel && RANK[priorModel] > RANK["claude-sonnet-5"] ? priorModel : "claude-sonnet-5";
  if (words < 15 && !code && questions < 2 && RANK[model] > RANK[cap]) {
    model = cap;
  }
  // Floor: code or long messages never go to Haiku.
  if ((code || words > 300) && RANK[model] < RANK["claude-sonnet-5"]) {
    model = "claude-sonnet-5";
  }
  // Fable gate: only exceptional + substantial.
  if (model === "claude-fable-5" && !(complexity === "exceptional" && words > 50)) {
    model = "claude-opus-4-8";
  }
  return { model, applied: model !== chosen };
}

export const classifierSchema = z.object({
  taskType: z.string().describe("2-4 word label, e.g. 'code debugging', 'casual chat'"),
  complexity: z.enum(COMPLEXITIES),
  chosenModel: z.enum(MODEL_IDS),
  reasoning: z.string().describe("One sentence: why this model is the cheapest that will do the job well"),
  optimizedPrompt: z.string().describe("The rewritten, excellent version of the user's message"),
});
export type ClassifierOutput = z.infer<typeof classifierSchema>;

const CLASSIFIER_SYSTEM = `You are the routing brain of EasyMode, a chat app that maximizes quality/price.
For each new user message you do two jobs:

1. REWRITE the message into an excellent prompt (optimizedPrompt): preserve the user's intent and language exactly; add structure, clarify implicit requirements, specify desired format/length when obvious. Never invent requirements the user didn't imply. For trivial messages (greetings, one-liners) minimal or no rewriting is correct.

2. ROUTE to the cheapest Anthropic model that will do the job well (chosenModel):
- trivial → claude-haiku-4-5: greetings, format tweaks, short rewrites, simple facts
- everyday → claude-sonnet-5: general Q&A, summaries, standard code, explanations
- hard → claude-opus-4-8: multi-step reasoning, nuanced analysis, tricky debugging, long/complex code
- exceptional → claude-fable-5: RARE. Only genuinely demanding long-horizon reasoning.

Follow-up rule: a follow-up message ("yes do that", "now make it faster") inherits AT LEAST the tier of the task it continues, unless it is a clear topic switch. Use the conversation context provided.`;

/** Tier of the most recent routed assistant turn — what a follow-up inherits. */
export function priorTier(history: EasyUIMessage[]): ModelId | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "assistant") continue;
    const model = m.metadata?.routing?.finalModel;
    if (model) return model;
  }
  return undefined;
}

/** Build classifier input: last 4 turns (truncated) + the new message. */
export function buildClassifierPrompt(history: EasyUIMessage[], rawText: string): string {
  const recent = history.slice(-4).map((m) => {
    const text = messageText(m);
    const clipped = text.length > 500 ? text.slice(0, 500) + " […]" : text;
    return `${m.role === "user" ? "USER" : "ASSISTANT"}: ${clipped}`;
  });
  const context = recent.length ? `Conversation so far:\n${recent.join("\n")}\n\n` : "";
  return `${context}NEW USER MESSAGE:\n${rawText}`;
}

export interface ClassifyResult {
  decision: ClassifierOutput;
  usage: TokenUsage;
}

/** One Haiku call: classify + rewrite + route. Throws on failure (caller falls back). */
export async function classify(
  history: EasyUIMessage[],
  rawText: string,
): Promise<ClassifyResult> {
  const { object, usage } = await generateObject({
    model: anthropic(CLASSIFIER_MODEL),
    schema: classifierSchema,
    system: CLASSIFIER_SYSTEM,
    prompt: buildClassifierPrompt(history, rawText),
    abortSignal: AbortSignal.timeout(15_000),
  });
  return {
    decision: object,
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
  };
}

export function modelLabel(id: ModelId): string {
  return PRICING[id].label;
}
