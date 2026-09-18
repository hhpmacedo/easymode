/** Request assembly for the answer call (spec §3). One pure function owns the
 *  order of everything the model sees, because Anthropic's prompt cache is a
 *  prefix match: stable content first, volatile content last, and exactly two
 *  breakpoints —
 *    A: end of the instruction layer (base / user instructions / memory), so
 *       it is shared across all of a user's threads on the same model;
 *    B: the latest user turn, so the whole thread prefix is reused next turn.
 *  Anthropic checks earlier block boundaries for hits, so a new B each turn
 *  still matches the previous prefix. Everything before B must be
 *  byte-identical between turns — buildModelMessages guarantees that by
 *  reading optimized prompts from stored metadata, never re-deriving them.
 *
 *  The result is spread straight into streamText: the system layer goes in
 *  `instructions` (AI SDK v7 rejects system entries inside `messages`) and
 *  keeps its providerOptions, so breakpoint A reaches the provider. */
import type { ModelMessage, SystemModelMessage } from "ai";
import { buildModelMessages } from "./history";
import type { EasyUIMessage } from "./types";

const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" as const } } };

export interface AssembleInput {
  /** Frozen base prompt (plan 2). Empty/undefined → omitted. */
  base?: string;
  /** The user's own instructions (plan 2). Blank → omitted. */
  instructions?: string;
  /** Active memory lines (plan 4). Empty → omitted. */
  memory?: string[];
  messages: EasyUIMessage[];
  optimizedPrompt: string;
  /** YYYY-MM-DD. The only volatile thing allowed in system, and it goes last. */
  today: string;
}

export interface AssembledRequest {
  /** System layer, in order; breakpoint A on the last stable entry. */
  instructions: SystemModelMessage[];
  /** Conversation turns; breakpoint B on the latest user turn's text part. */
  messages: ModelMessage[];
}

export function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function assembleRequest(input: AssembleInput): AssembledRequest {
  const system: SystemModelMessage[] = [];
  if (input.base) system.push({ role: "system", content: input.base });
  const userInstructions = input.instructions?.trim();
  if (userInstructions) {
    system.push({
      role: "system",
      content: `<user_instructions>\n${userInstructions}\n</user_instructions>`,
    });
  }
  if (input.memory?.length) {
    system.push({
      role: "system",
      content: `<memory>\n${input.memory.map((m) => `- ${m}`).join("\n")}\n</memory>`,
    });
  }
  // Breakpoint A closes the stable layer (when there is one).
  if (system.length) {
    const last = system[system.length - 1];
    system[system.length - 1] = { ...last, providerOptions: CACHE_BREAKPOINT };
  }
  system.push({ role: "system", content: `Today is ${input.today}.` });

  const turns = buildModelMessages(input.messages, input.optimizedPrompt);
  const out: ModelMessage[] = turns.map((t) =>
    t.role === "user"
      ? { role: "user", content: t.content }
      : { role: "assistant", content: t.content },
  );
  // Breakpoint B on the latest user turn.
  const last = out.length - 1;
  if (last >= 0 && out[last].role === "user") {
    out[last] = {
      role: "user",
      content: [{ type: "text", text: turns[last].content, providerOptions: CACHE_BREAKPOINT }],
    };
  }
  return { instructions: system, messages: out };
}
