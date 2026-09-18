/** Prompts and payload limits for the memory-extraction job (spec §5.3).
 *  Server only. The route clips whatever the client sends to these limits, so
 *  a real conversation is never rejected and Haiku's input stays bounded. */
import type { ExtractionResult } from "../memory";
import type { Memory } from "../types";

export type ExtractionTurn = { role: "user" | "assistant"; text: string };
export type ExtractionMemory = Pick<Memory, "id" | "text" | "kind">;

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

/** Most existing memories one extraction call sees. */
export const MAX_MEMORIES = 300;

/** Clip rather than reject, for the same reason as clipTurns: a 400 here
 *  would stall every later extraction — including consolidation, the only
 *  thing that shrinks the list — until the user pruned by hand. Keep the
 *  FIRST rows: the client sends creation order, so those are the oldest, and
 *  consolidation merges from the front. Trade-off: rows past the cap are
 *  invisible to this call, so they cannot be updated or archived by it, and a
 *  fact restated may come back as an `add`; the client's near-duplicate check
 *  in mergeMemories absorbs most of those. */
export function clipMemories(memories: ExtractionMemory[]): ExtractionMemory[] {
  return memories.slice(0, MAX_MEMORIES);
}

/** Rows are labelled m1..mN in the prompt rather than with the client's ids:
 *  update/archive only work when Haiku echoes an id byte-exact, and a 36-char
 *  UUID copied 50 times per call is a real miss rate (and ~11K chars of
 *  prompt at 300 rows). The route maps aliases back with resolveAliases. */
function aliasFor(index: number): string {
  return `m${index + 1}`;
}

const ALIAS = /^m?(\d+)$/i;

/** Translate the aliases in `update`/`archive` back to the ids of the rows
 *  buildExtractionPrompt was given (same list, same order). An alias that
 *  names no row is dropped, so a mis-copied one never reaches the client as
 *  a junk id. `add` passes through untouched. */
export function resolveAliases(
  result: ExtractionResult,
  memories: ExtractionMemory[],
): ExtractionResult {
  const realId = (alias: string): string | undefined => {
    const m = ALIAS.exec(alias.trim());
    if (!m) return undefined;
    return memories[Number(m[1]) - 1]?.id;
  };
  return {
    add: result.add,
    update: result.update.flatMap((u) => {
      const id = realId(u.id);
      return id ? [{ id, text: u.text }] : [];
    }),
    archive: result.archive.flatMap((a) => {
      const id = realId(a);
      return id ? [id] : [];
    }),
  };
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
- Nothing sensitive unless they explicitly ask to remember it: health, finances, relationships, religion, politics, credentials, addresses. An explicit ask ("remember this", "keep in mind", "note for the future") IS the consent: keep what they asked for, even when it is personal.
- Prefer what the user stated over what the assistant inferred.
- One fact per item, one line, under ${PROMPT_LINE_CHARS} characters, in the third person ("Prefers pnpm"), in the user's language.
- Do not repeat an existing memory. If a new statement refines one, put it in \`update\` with that memory's id. If a statement contradicts one, \`archive\` the old id and \`add\` the new fact.
- When unsure, return nothing. Empty lists are a good answer.`;

export const CONSOLIDATE_NOTE = `The memory list has grown past its size limit. Within the response limits (at most 20 \`add\`, 20 \`update\`, 50 \`archive\`), merge the most overlapping items first (archive the originals, add one merged line), drop anything stale, keep every fact that still matters. Partial progress is fine; you will be called again while the list is over its limit.`;

export function buildExtractionPrompt(
  turns: ExtractionTurn[],
  memories: ExtractionMemory[],
  consolidate = false,
): string {
  const known = memories.length
    ? `EXISTING MEMORIES (id · kind · text):\n${memories.map((m, i) => `${aliasFor(i)} · ${m.kind} · ${m.text}`).join("\n")}`
    : "EXISTING MEMORIES: none";
  const transcript = turns
    .map((t) => `${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.text}`)
    .join("\n\n");
  return `${consolidate ? CONSOLIDATE_NOTE + "\n\n" : ""}${known}\n\nNEW TURNS:\n${transcript}`;
}
