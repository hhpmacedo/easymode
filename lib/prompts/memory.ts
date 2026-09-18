/** Prompts for the memory-extraction job (spec §5.3). Server only. */
import type { Memory } from "../types";

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
- One fact per item, one line, under 200 characters, in the third person ("Prefers pnpm"), in the user's language.
- Do not repeat an existing memory. If a new statement refines one, put it in \`update\` with that memory's id. If a statement contradicts one, \`archive\` the old id and \`add\` the new fact.
- When unsure, return nothing. Empty lists are a good answer.`;

export const CONSOLIDATE_NOTE = `The memory list has grown past its size limit. Return, in \`update\`/\`archive\`/\`add\`, a rewrite of the WHOLE set that says the same things in fewer, denser lines: merge overlapping items into one (archive the originals, add the merged line), drop anything stale, keep every fact that still matters.`;

export function buildExtractionPrompt(
  turns: { role: "user" | "assistant"; text: string }[],
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
