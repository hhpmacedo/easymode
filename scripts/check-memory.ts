/** Live memory-extraction check (spec §9): every fixture thread must yield
 *  the expected facts and none of the forbidden ones (sensitive topics, task
 *  noise). Costs a few cents; main pushes / manual only. */
import { readFileSync } from "fs";
import { anthropic } from "@ai-sdk/anthropic";
import { runJob } from "../lib/api-helpers";
import { extractionSchema } from "../lib/memory";
import { EXTRACTION_SYSTEM, buildExtractionPrompt } from "../lib/prompts/memory";

interface Case {
  name: string;
  turns: [role: "user" | "assistant", text: string][];
  expect: string[];
  forbid: string[];
}

async function main() {
  const cases: Case[] = JSON.parse(readFileSync("fixtures/memory-eval.json", "utf8"));
  let failed = false;
  for (const c of cases) {
    const turns = c.turns.map(([role, text]) => ({ role, text }));
    const { result } = await runJob(
      anthropic,
      extractionSchema,
      EXTRACTION_SYSTEM,
      buildExtractionPrompt(turns, []),
    );
    const text = result.add
      .map((a) => a.text)
      .join(" | ")
      .toLowerCase();
    const missing = c.expect.filter((e) => !text.includes(e.toLowerCase()));
    const leaked = c.forbid.filter((f) => text.includes(f.toLowerCase()));
    const ok = missing.length === 0 && leaked.length === 0;
    if (!ok) failed = true;
    console.log(
      `${ok ? "✅" : "❌"} ${c.name} → ${result.add.length} memories` +
        (missing.length ? ` — missing: ${missing.join(", ")}` : "") +
        (leaked.length ? ` — leaked: ${leaked.join(", ")}` : ""),
    );
  }
  if (failed) {
    console.error("\nMemory extraction missed a fact or kept something it must not.");
    process.exit(1);
  }
}

main();
