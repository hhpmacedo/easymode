import { readFileSync } from "fs";
import { classify, applyGuardrail } from "../lib/router";

interface Case { prompt: string; expected: string[]; }

async function main() {
  const cases: Case[] = JSON.parse(readFileSync("fixtures/routing-eval.json", "utf8"));
  let pass = 0;
  for (const c of cases) {
    try {
      const { decision } = await classify([], c.prompt);
      const { model } = applyGuardrail(decision.chosenModel, decision.complexity, c.prompt);
      const ok = c.expected.includes(model);
      if (ok) pass++;
      console.log(`${ok ? "✅" : "❌"} [${model}] (llm: ${decision.chosenModel}, ${decision.complexity}) ${c.prompt.slice(0, 60)}`);
    } catch (e) {
      console.log(`💥 ${c.prompt.slice(0, 60)} — ${(e as Error).message}`);
    }
  }
  console.log(`\n${pass}/${cases.length} within expected range`);
  if (pass / cases.length < 0.8) process.exit(1);
}

main();
