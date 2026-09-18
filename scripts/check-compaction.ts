/** Live compaction faithfulness check (spec §9): compact each fixture thread
 *  with the real prompt + model and assert every expected fact survives in
 *  the rendered summary. Costs a few cents; main pushes / manual only. */
import { readFileSync } from "fs";
import { anthropic } from "@ai-sdk/anthropic";
import { runJob } from "../lib/api-helpers";
import { compactionSummarySchema, renderCompaction } from "../lib/compaction";
import { COMPACTION_SYSTEM, buildCompactionPrompt } from "../lib/prompts/compaction";
import type { EasyUIMessage } from "../lib/types";

interface Case {
  name: string;
  turns: [role: "user" | "assistant", text: string][];
  expect: string[];
}

async function main() {
  const cases: Case[] = JSON.parse(readFileSync("fixtures/compaction-eval.json", "utf8"));
  let failed = false;
  for (const c of cases) {
    const messages = c.turns.map(
      ([role, text], i) =>
        ({ id: String(i), role, parts: [{ type: "text", text }] }) as EasyUIMessage,
    );
    const { result } = await runJob(
      anthropic,
      compactionSummarySchema,
      COMPACTION_SYSTEM,
      buildCompactionPrompt(messages),
    );
    const rendered = renderCompaction(result).toLowerCase();
    const missing = c.expect.filter((e) => !rendered.includes(e.toLowerCase()));
    const ok = missing.length === 0;
    if (!ok) failed = true;
    console.log(`${ok ? "✅" : "❌"} ${c.name}${ok ? "" : ` — missing: ${missing.join(", ")}`}`);
  }
  if (failed) {
    console.error("\nCompaction dropped facts it must keep.");
    process.exit(1);
  }
}

main();
