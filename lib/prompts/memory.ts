/** Prompts and payload limits for the memory-extraction job (spec §5.3).
 *  Server only. The route clips whatever the client sends to these limits, so
 *  a real conversation is never rejected and Haiku's input stays bounded. */
import type { Memory } from "../types";

export type ExtractionTurn = { role: "user" | "assistant"; text: string };

/** Most turns one extraction call reads; clipTurns keeps the newest. */
export const MAX_TURNS = 80;
/** Characters kept per turn. */
export const MAX_TURN_CHARS = 4_000;

/** Clip rather than reject: the client resends everything since its last
 *  successful extraction, so a hard cap would leave a long-idle conversation
 *  failing forever. Keep the newest turns; the oldest have had the most chances. */
export function clipTurns(turns: ExtractionTurn[]): ExtractionTurn[] {
  return turns
    .slice(-MAX_TURNS)
    .map((t) => ({ role: t.role, text: t.text.slice(0, MAX_TURN_CHARS) }));
}

/** What the prompt asks per line: ~25% under extractionSchema's hard
 *  `.max(MEMORY_TEXT_MAX)` (200). generateObject validates with zod, so one
 *  over-long line would fail the whole call, and Haiku cannot count characters
 *  reliably; the headroom matters most in consolidation mode, which pushes
 *  toward denser lines. */
export const PROMPT_LINE_CHARS = 150;

export const EXTRACTION_SYSTEM = `You maintain a short list of durable facts about a person, learned from their conversations with an assistant, so future conversations can be tailored to them without asking again.

Extract ONLY facts that will still be true and useful weeks from now:
- profile: who they are — role, work, tools, languages, location, timezone
- preference: how they like things — answer style, formats, conventions, tools they prefer or avoid
- project: ongoing work they refer back to — names, stacks, deadlines, constraints
- fact: other standing facts they state about themselves or their situation

Rules:
- Facts about the person, not about the assistant, and not about the specific task of this conversation (a bug they fixed today is not a memory; that they work in Rust is).
- Nothing sensitive unless they explicitly ask to remember it: health, finances, relationships, religion, politics, credentials, addresses.
- Prefer what the user stated over what the assistant inferred.
- One fact per item, one line, under ${PROMPT_LINE_CHARS} characters, in the third person ("Prefers pnpm"), in the user's language.
- Do not repeat an existing memory. If a new statement refines one, put it in \`update\` with that memory's id. If a statement contradicts one, \`archive\` the old id and \`add\` the new fact.
- When unsure, return nothing. Empty lists are a good answer.`;

export const CONSOLIDATE_NOTE = `The memory list has grown past its size limit. Within the response limits (at most 20 \`add\`, 20 \`update\`, 50 \`archive\`), merge the most overlapping items first (archive the originals, add one merged line), drop anything stale, keep every fact that still matters. Partial progress is fine; you will be called again while the list is over its limit.`;

export function buildExtractionPrompt(
  turns: ExtractionTurn[],
  memories: Pick<Memory, "id" | "text" | "kind">[],
  consolidate = false,
): string {
  const known = memories.length
    ? `EXISTING MEMORIES (id · kind · text):\n${memories.map((m) => `${m.id} · ${m.kind} · ${m.text}`).join("\n")}`
    : "EXISTING MEMORIES: none";
  const transcript = turns
    .map((t) => `${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.text}`)
    .join("\n\n");
  return `${consolidate ? CONSOLIDATE_NOTE + "\n\n" : ""}${known}\n\nNEW TURNS:\n${transcript}`;
}
