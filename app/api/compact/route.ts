import { resolveCompactAuth } from "@/lib/auth";
import { providerFor } from "@/lib/provider";
import { readJsonBody, runJob } from "@/lib/api-helpers";
import { compactionSummarySchema } from "@/lib/compaction";
import { COMPACTION_SYSTEM, buildCompactionPrompt } from "@/lib/prompts/compaction";
import type { EasyUIMessage } from "@/lib/types";

export const maxDuration = 60;

// The client sends only the turns to compact, as full UI messages. At the
// 150K-token threshold ceiling that is ~600K chars of text, but every
// assistant message also carries metadata (routing reasoning plus a second
// copy of the user's prompt) and JSON framing, so a measured 150K-token
// thread serialises to ~900K chars over ~650 messages. Cap at roughly twice
// that so the ceiling is always reachable; the compaction limiter (10 per
// 15 min) and Haiku's 200K window bound spend, not these caps.
const MAX_BODY_BYTES = 2_000_000;
const MAX_MESSAGES = 1_000;

/** Summarize older turns into a CompactionSummary (spec §6.2). One Haiku call
 *  on the caller's key (or the server's, behind the token gate). The client
 *  decides the boundary and stores the result; this endpoint is stateless. */
export async function POST(req: Request) {
  const auth = resolveCompactAuth(req);
  if (auth.denied) return auth.denied;

  const parsed = await readJsonBody(req, MAX_BODY_BYTES);
  if (parsed.error) return parsed.error;
  const body = (parsed.body ?? {}) as {
    messages?: unknown;
    prior?: unknown;
    priorEdited?: unknown;
  };
  const messages = Array.isArray(body.messages) ? (body.messages as EasyUIMessage[]) : [];
  if (messages.length === 0 || messages.length > MAX_MESSAGES) {
    return Response.json(
      { error: `Expected 1–${MAX_MESSAGES} messages to compact.` },
      { status: 400 },
    );
  }
  const prior = compactionSummarySchema.safeParse(body.prior);

  try {
    const { result, usage } = await runJob(
      providerFor(auth.apiKey),
      compactionSummarySchema,
      COMPACTION_SYSTEM,
      buildCompactionPrompt(
        messages,
        prior.success ? prior.data : undefined,
        body.priorEdited === true,
      ),
    );
    return Response.json({ summary: result, usage });
  } catch (err) {
    console.error("[easymode] compaction failed:", err);
    return Response.json(
      { error: "Compaction failed. It will be retried later." },
      { status: 502 },
    );
  }
}
