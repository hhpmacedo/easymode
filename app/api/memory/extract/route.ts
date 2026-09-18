import { resolveExtractAuth } from "@/lib/auth";
import { providerFor } from "@/lib/provider";
import { readJsonBody, runJob } from "@/lib/api-helpers";
import { extractionSchema, MEMORY_TEXT_MAX } from "@/lib/memory";
import { EXTRACTION_SYSTEM, buildExtractionPrompt, clipTurns } from "@/lib/prompts/memory";
import type { ExtractionTurn } from "@/lib/prompts/memory";
import { MEMORY_KINDS } from "@/lib/types";
import type { Memory } from "@/lib/types";

export const maxDuration = 60;

// Generous, matching /api/compact: the client resends everything since its
// last successful extraction, so a cap below what a long-idle conversation can
// accumulate (or one pasted log) would 413 forever without ever reaching the
// clipping below. clipTurns and the extract limiter (20 per 15 min) bound what
// reaches Haiku, not this cap.
const MAX_BODY_BYTES = 2_000_000;
const MAX_MEMORIES = 300;

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

  const turns = Array.isArray(body.turns) ? (body.turns as ExtractionTurn[]) : [];
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
  const clipped = clipTurns(turns);

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
