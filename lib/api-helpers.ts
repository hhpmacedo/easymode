/** Shared plumbing for the small background-job endpoints (spec §7.2):
 *  a bounded JSON body, then one structured call on the cheapest model using
 *  the caller's provider (their key or the server's). SERVER ONLY. */
import { generateObject } from "ai";
import type { z } from "zod";
import { CLASSIFIER_MODEL } from "./pricing";
import type { AnthropicProvider } from "./provider";
import type { TokenUsage } from "./types";

export const JOB_TIMEOUT_MS = 30_000;

export async function readJsonBody(
  req: Request,
  maxBytes: number,
): Promise<{ body: unknown; error?: undefined } | { body?: undefined; error: Response }> {
  const raw = await req.text();
  if (raw.length > maxBytes) {
    return { error: Response.json({ error: "Request body too large." }, { status: 413 }) };
  }
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: Response.json({ error: "Malformed JSON body." }, { status: 400 }) };
  }
}

/** One Haiku call that must return `schema`. Throws on timeout/API failure;
 *  callers map that to a terse 502 and let the client retry later. */
export async function runJob<T>(
  provider: AnthropicProvider,
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
): Promise<{ result: T; usage: TokenUsage }> {
  const { object, usage } = await generateObject({
    model: provider(CLASSIFIER_MODEL),
    schema,
    system,
    prompt,
    abortSignal: AbortSignal.timeout(JOB_TIMEOUT_MS),
  });
  return {
    result: object,
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
  };
}

/** Log a failure WITHOUT its payload. AI SDK errors carry the full request
 *  (system prompt, turns, memories — `requestBodyValues`) and any raw model
 *  text on the error object, so a bare console.error(err) would put a user's
 *  transcript in the server logs. Name + message is enough to diagnose. */
export function logJobError(tag: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[easymode] ${tag}: ${name}: ${message.slice(0, 300)}`);
}
