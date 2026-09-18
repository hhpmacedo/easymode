/** Memory across conversations (spec §5): the pure pieces. Extraction and
 *  storage live elsewhere; nothing here touches the network or localStorage. */
import { z } from "zod";
import { estimateTokens } from "./compaction";
import { MEMORY_KINDS, messageText } from "./types";
import type { EasyUIMessage, Memory } from "./types";

/** One fact, one line (spec §5.1). */
export const MEMORY_TEXT_MAX = 200;
/** Rendered memory is capped so it stays a small, stable prefix (spec §4.3). */
export const MEMORY_CAP_TOKENS = 1_500;
/** The classifier only sees memory when it is this short (spec §4.5). */
export const CLASSIFIER_MEMORY_TOKENS = 300;
/** Quiet-moment trigger: this many new user turns since the last extraction (spec §5.2). */
export const EXTRACT_MIN_USER_TURNS = 2;
export const EXTRACT_IDLE_MS = 10 * 60_000;

export const extractionSchema = z.object({
  add: z
    .array(z.object({ text: z.string().min(1).max(MEMORY_TEXT_MAX), kind: z.enum(MEMORY_KINDS) }))
    .max(20)
    .describe("New durable facts about the user; empty when unsure"),
  update: z
    .array(z.object({ id: z.string().min(1), text: z.string().min(1).max(MEMORY_TEXT_MAX) }))
    .max(20)
    .describe("Existing memories (by id) whose text should change"),
  archive: z.array(z.string().min(1)).max(50).describe("Existing memory ids that no longer hold"),
});
export type ExtractionResult = z.infer<typeof extractionSchema>;

export function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MEMORY_TEXT_MAX);
}

/** Function words that carry no fact; ignored when comparing memories so the
 *  same fact phrased differently ("over" vs "rather than") still overlaps.
 *  Negation is content, not filler, so `not` and friends are never here. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "but",
  "the",
  "for",
  "with",
  "from",
  "into",
  "over",
  "than",
  "rather",
  "that",
  "this",
  "are",
  "was",
  "has",
  "have",
  "does",
  "also",
  "about",
  "at",
  "in",
  "of",
  "on",
  "to",
  "as",
  "is",
]);

/** Content words in the order written. Every token counts, however short:
 *  "R", "Go", "C" and version numbers are the whole difference between
 *  distinct facts. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

/** Whether `inner` appears in `outer` in the same order (gaps allowed). */
function isSubsequence(inner: string[], outer: string[]): boolean {
  let i = 0;
  for (const w of outer) if (i < inner.length && w === inner[i]) i++;
  return i === inner.length;
}

const NEGATION = /\b(?:not|no|never)\b|n't\b/;

/** Two facts count as the same when their content words overlap at least
 *  this much (Jaccard). High on purpose: a shared sentence template with one
 *  fact word swapped ("Lives in beautiful Lisbon" / "… London") must stay
 *  distinct, and the containment rule already catches rephrasings. */
const NEAR_DUPLICATE_OVERLAP = 0.8;

const HAS_DIGIT = /\p{N}/u;

/** Same fact in different words: one's words contain the other's in order
 *  (same fact, more detail), or the word sets overlap heavily and the words
 *  that differ are not numbers — a version or a count that differs is a
 *  different fact. Order is content: "Prefers tabs over spaces" and "Prefers
 *  spaces over tabs" share every word and are opposite facts, so a pair whose
 *  word sets nest but whose order differs is never a match. Whole words, not
 *  substrings, so "Uses R" is not inside "Uses React". A negated and a
 *  non-negated sentence are never the same fact. */
export function isNearDuplicate(a: string, b: string): boolean {
  const na = normalizeMemoryText(a).toLowerCase();
  const nb = normalizeMemoryText(b).toLowerCase();
  if (!na || !nb) return false;
  if (NEGATION.test(na) !== NEGATION.test(nb)) return false;
  const ta = words(na);
  const tb = words(nb);
  if (!ta.length || !tb.length) return false;
  const wa = new Set(ta);
  const wb = new Set(tb);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  if (shared === wa.size || shared === wb.size) {
    return isSubsequence(ta, tb) || isSubsequence(tb, ta);
  }
  if (shared / (wa.size + wb.size - shared) < NEAR_DUPLICATE_OVERLAP) return false;
  for (const w of wa) if (!wb.has(w) && HAS_DIGIT.test(w)) return false;
  for (const w of wb) if (!wa.has(w) && HAS_DIGIT.test(w)) return false;
  return true;
}

export interface MergeContext {
  now: number;
  conversationId?: string;
  newId: () => string;
}

/** Apply an extraction result (spec §5.4). Archive and update by id (unknown
 *  or archived ids are ignored); add only facts that do not near-duplicate an
 *  active one. Returns a new array; never mutates the input. */
export function mergeMemories(
  existing: Memory[],
  result: ExtractionResult,
  ctx: MergeContext,
): Memory[] {
  const archive = new Set(result.archive);
  const updates = new Map(result.update.map((u) => [u.id, normalizeMemoryText(u.text)]));
  const out: Memory[] = existing.map((m) => {
    if (m.status !== "active") return m;
    if (archive.has(m.id)) return { ...m, status: "archived", updatedAt: ctx.now };
    const text = updates.get(m.id);
    if (text && text !== m.text) return { ...m, text, updatedAt: ctx.now };
    return m;
  });
  for (const a of result.add) {
    const text = normalizeMemoryText(a.text);
    if (!text) continue;
    if (out.some((m) => m.status === "active" && isNearDuplicate(m.text, text))) continue;
    out.push({
      id: ctx.newId(),
      text,
      kind: a.kind,
      source: "extracted",
      conversationId: ctx.conversationId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      status: "active",
    });
  }
  return out;
}

function activeInOrder(memories: Memory[]): Memory[] {
  return memories.filter((m) => m.status === "active").sort((a, b) => a.createdAt - b.createdAt);
}

/** The lines rendered into <memory>: active, creation order, newest kept
 *  when over the cap (spec §4.3). */
export function memoryLines(memories: Memory[], capTokens: number = MEMORY_CAP_TOKENS): string[] {
  const active = activeInOrder(memories);
  const kept: Memory[] = [];
  let tokens = 0;
  for (let i = active.length - 1; i >= 0; i--) {
    const t = estimateTokens(active[i].text) + 1;
    if (tokens + t > capTokens) break;
    tokens += t;
    kept.push(active[i]);
  }
  return kept.reverse().map((m) => m.text);
}

export function needsConsolidation(memories: Memory[]): boolean {
  const total = activeInOrder(memories).reduce((n, m) => n + estimateTokens(m.text) + 1, 0);
  return total > MEMORY_CAP_TOKENS;
}

/** `remember: …` at the start of a message saves an explicit memory (spec
 *  §5.5). The memory is the first line after the prefix; the message is sent
 *  with the prefix stripped. */
export function parseRememberCommand(text: string): { memory: string; rest: string } | null {
  const m = text.match(/^\s*remember:\s*(.+)$/is);
  if (!m) return null;
  const rest = m[1].trim();
  const memory = normalizeMemoryText(rest.split("\n")[0]);
  if (!memory) return null;
  return { memory, rest };
}

function indexAfter(messages: EasyUIMessage[], throughId?: string): number {
  if (!throughId) return 0;
  const i = messages.findIndex((m) => m.id === throughId);
  return i < 0 ? 0 : i + 1;
}

export function newUserTurnsSince(messages: EasyUIMessage[], throughId?: string): number {
  return messages.slice(indexAfter(messages, throughId)).filter((m) => m.role === "user").length;
}

/** The turns the extractor reads: raw text as typed, not optimized prompts —
 *  memory is about the person (spec §5.3). */
export function turnsSince(
  messages: EasyUIMessage[],
  throughId?: string,
): { role: "user" | "assistant"; text: string }[] {
  return messages
    .slice(indexAfter(messages, throughId))
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", text: messageText(m) }))
    .filter((t) => t.text.length > 0);
}
