import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { classify, applyGuardrail } from "@/lib/router";
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
    const { model, applied } = applyGuardrail(decision.chosenModel, decision.complexity, rawText);
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

  let result;
  try {
    result = run(routing.finalModel);
  } catch {
    // Pre-stream failure on Fable (e.g. refusal/availability): one retry on Opus (spec §8).
    if (routing.finalModel === "claude-fable-5") {
      routing = { ...routing, finalModel: "claude-opus-4-8", reasoning: routing.reasoning + " (Fable declined — retried on Opus 4.8.)" };
      result = run("claude-opus-4-8");
    } else {
      throw new Error("Model call failed");
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
