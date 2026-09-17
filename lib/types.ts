import type { UIMessage } from "ai";

export const MODEL_IDS = [
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-fable-5",
] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const COMPLEXITIES = ["trivial", "everyday", "hard", "exceptional"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RoutingDecision {
  taskType: string;
  complexity: Complexity;
  chosenModel: ModelId; // classifier's pick
  finalModel: ModelId; // after guardrail
  guardrailApplied: boolean;
  reasoning: string;
  optimizedPrompt: string;
  fallback: boolean; // true when classifier failed and we defaulted
}

/** Metadata attached to each assistant UI message. `routing`+`classifierUsage`
 *  arrive at stream start; `usage` at stream finish. */
export interface EasyMetadata {
  routing?: RoutingDecision;
  classifierUsage?: TokenUsage;
  usage?: TokenUsage;
}

export type EasyUIMessage = UIMessage<EasyMetadata>;

/** Extract the plain text of a UI message's text parts. */
export function messageText(m: EasyUIMessage): string {
  return m.parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}
