/** Prompt-cache tripwire (spec §9): two turns per tier through the real
 *  assembleRequest; turn two must report cacheReadTokens > 0. If it doesn't,
 *  something volatile crept into the prefix or a breakpoint moved. Costs real
 *  money (~80K input tokens across three tiers) — main pushes / manual only. */
import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { assembleRequest, todayISO } from "../lib/context";
import type { EasyUIMessage, ModelId } from "../lib/types";

const TIERS: ModelId[] = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"];

// ~12K tokens: comfortably above the largest per-model minimum cacheable
// prefix (4,096 tokens), so turn one's breakpoint B actually writes a cache.
const FILLER = Array(1200)
  .fill("The quick brown fox jumps over the lazy dog near the quiet riverbank.")
  .join(" ");

function user(id: string, text: string): EasyUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as EasyUIMessage;
}
function assistant(id: string, text: string, optimizedPrompt: string): EasyUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: { routing: { optimizedPrompt } as never },
  } as EasyUIMessage;
}

async function turn(model: ModelId, messages: EasyUIMessage[], optimizedPrompt: string) {
  const result = streamText({
    model: anthropic(model),
    messages: assembleRequest({ messages, optimizedPrompt, today: todayISO() }),
    maxOutputTokens: 20,
  });
  await result.text;
  return result.totalUsage;
}

async function main() {
  let failed = false;
  for (const model of TIERS) {
    const first = `${FILLER}\n\nReply with the single word OK.`;
    const t1 = [user("1", first)];
    const u1 = await turn(model, t1, first);
    const second = "Reply with the single word OK again.";
    const t2 = [...t1, assistant("2", "OK", first), user("3", second)];
    const u2 = await turn(model, t2, second);
    const written = u1.inputTokenDetails.cacheWriteTokens ?? 0;
    const read = u2.inputTokenDetails.cacheReadTokens ?? 0;
    const ok = read > 0;
    if (!ok) failed = true;
    console.log(
      `${ok ? "✅" : "❌"} ${model}: turn1 wrote ${written}, turn2 read ${read} of ${u2.inputTokens ?? 0} input tokens`,
    );
  }
  if (failed) {
    console.error("\nCache tripwire failed: a silent invalidator is in the prefix.");
    process.exit(1);
  }
}

main();
