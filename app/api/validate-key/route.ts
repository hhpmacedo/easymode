import { generateText } from "ai";
import { guardValidate } from "@/lib/auth";
import { isAnthropicKeyFormat, providerFor } from "@/lib/provider";
import { CLASSIFIER_MODEL } from "@/lib/pricing";

/** Confirm a user-supplied Anthropic key works, before the UI relies on it.
 *  Spends a token or two of the caller's OWN credit on the cheapest model.
 *  204 valid · 400 malformed · 401 rejected by Anthropic · 429 rate-limited.
 *  The key is used transiently to build the provider and never stored or logged. */
export async function POST(req: Request) {
  const denied = guardValidate(req);
  if (denied) return denied;

  let key: unknown;
  try {
    ({ key } = await req.json());
  } catch {
    return Response.json({ error: "Expected JSON body { key }." }, { status: 400 });
  }
  if (!isAnthropicKeyFormat(key)) {
    return Response.json(
      { error: "That does not look like an Anthropic API key." },
      { status: 400 },
    );
  }

  try {
    await generateText({
      model: providerFor(key.trim())(CLASSIFIER_MODEL),
      prompt: "ping",
      maxOutputTokens: 1,
      abortSignal: AbortSignal.timeout(15_000),
    });
    return new Response(null, { status: 204 });
  } catch (err) {
    // Don't leak internals; the common case is an invalid/again-revoked key.
    const message = err instanceof Error ? err.message : String(err);
    const status = /401|invalid|authentication|api key/i.test(message) ? 401 : 502;
    return Response.json(
      { error: status === 401 ? "Anthropic rejected this key." : "Could not reach Anthropic." },
      { status },
    );
  }
}
