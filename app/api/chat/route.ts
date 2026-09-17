import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { classify, applyGuardrail, priorTier } from "@/lib/router";
import { buildModelMessages, latestUserText } from "@/lib/history";
import { DEFAULT_FALLBACK_MODEL } from "@/lib/pricing";
import type { EasyMetadata, EasyUIMessage, RoutingDecision, TokenUsage } from "@/lib/types";

export const maxDuration = 120;

export async function POST(req: Request) {
  const { messages }: { messages: EasyUIMessage[] } = await req.json();
  const rawText = latestUserText(messages);
  const history = messages.slice(0, -1); // context for the classifier

  // 1. Classify + rewrite + route (one Haiku call). Fall back on failure (spec §8).
  let routing: RoutingDecision;
  let classifierUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  try {
    const { decision, usage } = await classify(history, rawText);
    const { model, applied } = applyGuardrail(
      decision.chosenModel,
      decision.complexity,
      rawText,
      priorTier(history),
    );
    routing = { ...decision, finalModel: model, guardrailApplied: applied, fallback: false };
    classifierUsage = usage;
  } catch {
    routing = {
      taskType: "unknown",
      complexity: "everyday",
      chosenModel: DEFAULT_FALLBACK_MODEL,
      finalModel: DEFAULT_FALLBACK_MODEL,
      guardrailApplied: false,
      reasoning: "Routing unavailable — used default model without prompt optimization.",
      optimizedPrompt: rawText,
      fallback: true,
    };
  }

  // 2. Stream the answer from the chosen model, with optimized-prompt history.
  const run = (model: string) =>
    streamText({
      model: anthropic(model),
      messages: buildModelMessages(messages, routing.optimizedPrompt),
    });

  let result = run(routing.finalModel);

  // Fable refusal/availability: one retry on Opus 4.8 (spec §3.3 / §8). streamText
  // never throws — a refusal surfaces as finishReason "content-filter" (Anthropic
  // stop_reason "refusal") and API/network failures reject the finishReason promise,
  // so await completion (the result stream is buffered and replayable) and retry.
  if (routing.finalModel === "claude-fable-5") {
    let declined = false;
    try {
      declined = (await result.finishReason) === "content-filter";
    } catch {
      declined = true; // stream error (e.g. overloaded/unavailable)
    }
    if (declined) {
      routing = {
        ...routing,
        finalModel: "claude-opus-4-8",
        reasoning: routing.reasoning + " (Fable declined — retried on Opus 4.8.)",
      };
      result = run("claude-opus-4-8");
    }
  }

  // 3. Metadata rides the UI message stream: routing at start, usage at finish.
  return result.toUIMessageStreamResponse({
    messageMetadata: ({ part }): EasyMetadata | undefined => {
      if (part.type === "start") return { routing, classifierUsage };
      if (part.type === "finish") {
        return {
          usage: {
            inputTokens: part.totalUsage.inputTokens ?? 0,
            outputTokens: part.totalUsage.outputTokens ?? 0,
          },
        };
      }
      return undefined;
    },
  });
}
