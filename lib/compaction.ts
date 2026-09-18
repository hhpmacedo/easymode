/** Compaction of long threads (spec §6): pure pieces shared by the client
 *  (boundary choice, trigger) and the server (schema, transcript). Nothing
 *  here touches the network or storage. */
import { z } from "zod";
import { messageText } from "./types";
import type { CompactionSummary, EasyUIMessage } from "./types";

export const compactionSummarySchema = z.object({
  goal: z
    .string()
    .describe("One or two sentences: what the conversation is about and what the user wants"),
  decisions: z.array(z.string()).describe("Things that were settled, one per item"),
  facts: z
    .array(z.string())
    .describe("Constraints, data, names, numbers the user stated, one per item"),
  artifacts: z
    .array(z.string())
    .describe(
      "Code or text the user may refer back to: verbatim when 40 lines or fewer, else a precise description",
    ),
  open: z.array(z.string()).describe("Unresolved threads and pending questions"),
});

const compactionContextSchema = z.object({
  throughMessageId: z.string().min(1),
  summary: compactionSummarySchema,
});

/** Validate a client-supplied `context.compaction`; anything malformed is
 *  treated as "no compaction" rather than rejected — the user's own context. */
export function parseCompactionContext(
  value: unknown,
): { throughMessageId: string; summary: CompactionSummary } | undefined {
  const r = compactionContextSchema.safeParse(value);
  return r.success ? r.data : undefined;
}

/** Client-side token estimate: chars/4 throughout (spec §6.2). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Verbatim tail kept after the boundary (spec §6.2). */
export const COMPACT_TAIL_TOKENS = 8_000;

/** Pick what to compact: the turns after `since` (the previous boundary, if
 *  any) up to and including the latest ASSISTANT message such that at least
 *  `tailTokens` of whole turns remain verbatim after it. Null when there is
 *  nothing worth compacting. */
export function chooseCompactionBoundary(
  messages: EasyUIMessage[],
  since?: string,
  tailTokens: number = COMPACT_TAIL_TOKENS,
): { throughMessageId: string; toCompact: EasyUIMessage[] } | null {
  const sinceIdx = since ? messages.findIndex((m) => m.id === since) : -1;
  const start = sinceIdx + 1;
  let tail = 0;
  let boundary = -1;
  for (let i = messages.length - 1; i >= start; i--) {
    if (tail >= tailTokens && messages[i].role === "assistant") {
      boundary = i;
      break;
    }
    tail += estimateTokens(messageText(messages[i]));
  }
  if (boundary < start) return null;
  const toCompact = messages.slice(start, boundary + 1);
  if (!toCompact.some((m) => m.role === "user")) return null;
  return { throughMessageId: messages[boundary].id, toCompact };
}

/** The summary as the model sees it. Deterministic: the compaction pair sits
 *  inside the cached prefix, so identical input must render identical bytes. */
export function renderCompaction(s: CompactionSummary): string {
  const list = (title: string, items: string[]) =>
    items.length ? `${title}:\n${items.map((i) => `- ${i}`).join("\n")}` : `${title}: none`;
  return [
    "<compaction_summary>",
    `Goal: ${s.goal}`,
    list("Decisions", s.decisions),
    list("Facts", s.facts),
    list("Artifacts", s.artifacts),
    list("Open", s.open),
    "</compaction_summary>",
  ].join("\n\n");
}

/** The fixed assistant turn that follows the summary in the model messages. */
export const COMPACTION_ACK =
  "Understood — I have the summary of the earlier conversation and will continue from there.";

/** Raw transcript of turns for the compactor (user text as typed, not the
 *  optimized rewrite — the summary is about what the person said). */
export function transcriptText(messages: EasyUIMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${messageText(m)}`)
    .join("\n\n");
}

/** Context size of the latest answered turn (spec §6.1): the answer call's
 *  total input tokens, cached included. 0 before the first answer. */
export function lastInputTokens(messages: EasyUIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.metadata?.usage) return m.metadata.usage.inputTokens;
  }
  return 0;
}
