import type { UIMessage } from "ai";

export const MODEL_IDS = [
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-fable-5-1",
  // legacy — retained so older stored conversations resolve
  "claude-opus-4-8",
  "claude-fable-5",
] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const COMPLEXITIES = ["trivial", "everyday", "hard", "exceptional"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

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

/** Per-request context the client sends with the messages (spec §7.1).
 *  Local-first: the browser owns instructions; the server only validates. */
export interface ChatContext {
  instructions?: string;
  /** The PROMPT_VERSION the client was built against; the server logs a mismatch. */
  promptVersion?: string;
}

/** Metadata attached to each assistant UI message. `routing`+`classifierUsage`
 *  arrive at stream start; `usage` at stream finish. */
export interface EasyMetadata {
  routing?: RoutingDecision;
  classifierUsage?: TokenUsage;
  usage?: TokenUsage;
  /** Base-prompt version the answer was generated with (arrives at finish). */
  promptVersion?: string;
}

export type EasyUIMessage = UIMessage<EasyMetadata>;

/** Extract the plain text of a UI message's text parts. */
export function messageText(m: EasyUIMessage): string {
  return m.parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}
