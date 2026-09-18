import { streamText } from "ai";
import { classify, applyGuardrail, atLeastTier, priorTier } from "@/lib/router";
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

export const maxDuration = 120;

// Caps on what one request may push through the paid API (a 200 KB body is
// far past any real conversation this UI produces).
const MAX_BODY_BYTES = 200_000;
const MAX_MESSAGES = 200;

export async function POST(req: Request) {
  // Decide who pays (the caller's key or the server's) and whether they may
  // proceed. A caller with its own key bypasses the shared-key access gate.
  const auth = resolveChatAuth(req);
  if (auth.denied) return auth.denied;
  const provider = providerFor(auth.apiKey);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body too large." }, { status: 413 });
  }
  let messages: EasyUIMessage[];
  try {
    ({ messages } = JSON.parse(raw));
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return Response.json({ error: "Expected 1–200 messages." }, { status: 400 });
  }
  const rawText = latestUserText(messages);
  const history = messages.slice(0, -1); // context for the classifier

  // 1. Classify + rewrite + route (one Haiku call). Fall back on failure (spec §8).
  const prior = priorTier(history);
  let routing: RoutingDecision;
  let classifierUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  try {
    const { decision, usage } = await classify(history, rawText, provider);
    const { model, applied } = applyGuardrail(
      decision.chosenModel,
      decision.complexity,
      rawText,
      prior,
    );
    routing = { ...decision, finalModel: model, guardrailApplied: applied, fallback: false };
    classifierUsage = usage;
  } catch (err) {
    console.error("[easymode] classifier failed:", err);
    // The fallback still honours the ratchet: dropping an Opus thread to Sonnet
    // would forfeit its cache and reset the floor for every later turn.
    const fallbackModel = atLeastTier(DEFAULT_FALLBACK_MODEL, prior);
    routing = {
      taskType: "unknown",
      complexity: "everyday",
      chosenModel: DEFAULT_FALLBACK_MODEL,
      finalModel: fallbackModel,
      guardrailApplied: fallbackModel !== DEFAULT_FALLBACK_MODEL,
      reasoning: "Routing unavailable — used default model without prompt optimization.",
      optimizedPrompt: rawText,
      fallback: true,
    };
  }

  // 2. Stream the answer from the chosen model. assembleRequest owns the
  //    message order and the prompt-cache breakpoints (spec §3); the output
  //    cap is a runaway guard, not the cost control.
  const today = todayISO();
  const run = (model: ModelId) =>
    streamText({
      model: provider(model),
      ...assembleRequest({ messages, optimizedPrompt: routing.optimizedPrompt, today }),
      maxOutputTokens: MAX_OUTPUT_TOKENS[model],
    });

  let result = run(routing.finalModel);

  // Fable refusal/availability: one retry on Opus 5 (spec §3.3 / §8). streamText
  // never throws — a refusal surfaces as finishReason "content-filter" (Anthropic
  // stop_reason "refusal") and API/network failures reject the finishReason promise,
  // so await completion (the result stream is buffered and replayable) and retry.
  if (routing.finalModel.startsWith("claude-fable")) {
    let declined = false;
    try {
      declined = (await result.finishReason) === "content-filter";
    } catch {
      declined = true; // stream error (e.g. overloaded/unavailable)
    }
    if (declined) {
      routing = {
        ...routing,
        finalModel: "claude-opus-5",
        reasoning: routing.reasoning + " (Fable declined — retried on Opus 5.)",
      };
      result = run("claude-opus-5");
    }
  }

  // 3. Metadata rides the UI message stream: routing at start, usage at finish.
  return result.toUIMessageStreamResponse({
    // Default AI SDK behavior masks every stream error as "An error occurred.",
    // which makes failures (bad key, overload, network) undiagnosable from the
    // UI. Log the full error server-side and surface a terse cause client-side.
    onError: (error) => {
      console.error("[easymode] answer stream failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      return `Model call failed: ${message.slice(0, 200)}`;
    },
    messageMetadata: ({ part }): EasyMetadata | undefined => {
      if (part.type === "start") return { routing, classifierUsage };
      if (part.type === "finish") {
        const u = part.totalUsage;
        return {
          usage: {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            cacheReadTokens: u.inputTokenDetails.cacheReadTokens ?? 0,
            cacheWriteTokens: u.inputTokenDetails.cacheWriteTokens ?? 0,
          },
        };
      }
      return undefined;
    },
  });
}
