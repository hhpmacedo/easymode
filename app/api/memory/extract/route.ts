import { resolveExtractAuth } from "@/lib/auth";
import { providerFor } from "@/lib/provider";
import { readJsonBody, runJob } from "@/lib/api-helpers";
import { extractionSchema, MEMORY_TEXT_MAX } from "@/lib/memory";
import {
  EXTRACTION_SYSTEM,
  MAX_TURNS,
  MAX_TURN_CHARS,
  buildExtractionPrompt,
} from "@/lib/prompts/memory";
import { MEMORY_KINDS } from "@/lib/types";
import type { Memory } from "@/lib/types";

export const maxDuration = 60;

// One quiet-moment's worth of turns plus the memory list.
const MAX_BODY_BYTES = 400_000;
const MAX_MEMORIES = 300;

type Turn = { role: "user" | "assistant"; text: string };

/** Propose memory changes from new turns (spec §5.3). Stateless: the client
 *  merges, stores, and pays (its key or the server's behind the token gate). */
export async function POST(req: Request) {
  const auth = resolveExtractAuth(req);
  if (auth.denied) return auth.denied;

  const parsed = await readJsonBody(req, MAX_BODY_BYTES);
  if (parsed.error) return parsed.error;
  const body = (parsed.body ?? {}) as {
    turns?: unknown;
    memories?: unknown;
    consolidate?: unknown;
  };

  const turns = Array.isArray(body.turns) ? (body.turns as Turn[]) : [];
  const turnsOk =
    turns.length > 0 &&
    turns.every(
      (t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string",
    );
  if (!turnsOk) {
    return Response.json(
      { error: "Expected a non-empty list of { role, text } turns." },
      { status: 400 },
    );
  }
  // Clip rather than reject: the client resends everything since its last
  // successful extraction, so a hard cap would leave a long-idle conversation
  // failing forever. Keep the newest turns; the oldest have had the most chances.
  const clipped = turns
    .slice(-MAX_TURNS)
    .map((t) => ({ role: t.role, text: t.text.slice(0, MAX_TURN_CHARS) }));

  const memories = Array.isArray(body.memories)
    ? (body.memories as Pick<Memory, "id" | "text" | "kind">[])
    : [];
  const memoriesOk =
    memories.length <= MAX_MEMORIES &&
    memories.every(
      (m) =>
        m &&
        typeof m.id === "string" &&
        typeof m.text === "string" &&
        m.text.length <= MEMORY_TEXT_MAX &&
        (MEMORY_KINDS as readonly string[]).includes(m.kind),
    );
  if (!memoriesOk) {
    return Response.json({ error: "Malformed memories." }, { status: 400 });
  }

  try {
    const { result, usage } = await runJob(
      providerFor(auth.apiKey),
      extractionSchema,
      EXTRACTION_SYSTEM,
      buildExtractionPrompt(clipped, memories, body.consolidate === true),
    );
    return Response.json({ result, usage });
  } catch (err) {
    console.error("[easymode] memory extraction failed:", err);
    return Response.json({ error: "Memory extraction failed." }, { status: 502 });
  }
}
