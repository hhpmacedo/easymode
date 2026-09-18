import { describe, it, expect } from "vitest";
import { assembleRequest, todayISO } from "../context";
import type { EasyUIMessage } from "../types";

function user(id: string, text: string): EasyUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as EasyUIMessage;
}
function assistant(id: string, text: string, optimizedPrompt?: string): EasyUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: optimizedPrompt ? { routing: { optimizedPrompt } as never } : undefined,
  } as EasyUIMessage;
}

const CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } };
const thread = [
  user("1", "raw one"),
  assistant("2", "answer one", "OPT one"),
  user("3", "raw two"),
];
const base = { messages: thread, optimizedPrompt: "OPT two", today: "2026-09-18" };

describe("todayISO", () => {
  it("formats a date as YYYY-MM-DD", () => {
    expect(todayISO(new Date("2026-09-18T23:59:00Z"))).toBe("2026-09-18");
  });
});

describe("assembleRequest", () => {
  it("is byte-identical for identical input (cache tripwire)", () => {
    expect(JSON.stringify(assembleRequest(base))).toBe(JSON.stringify(assembleRequest(base)));
  });

  it("with no instruction layer, system is just the date, and it carries no breakpoint", () => {
    const out = assembleRequest(base);
    const system = out.filter((m) => m.role === "system");
    expect(system).toEqual([{ role: "system", content: "Today is 2026-09-18." }]);
  });

  it("orders system entries base → instructions → memory → date", () => {
    const out = assembleRequest({
      ...base,
      base: "BASE",
      instructions: "  be terse  ",
      memory: ["prefers pnpm", "works in TS"],
    });
    const system = out.filter((m) => m.role === "system").map((m) => m.content);
    expect(system).toEqual([
      "BASE",
      "<user_instructions>\nbe terse\n</user_instructions>",
      "<memory>\n- prefers pnpm\n- works in TS\n</memory>",
      "Today is 2026-09-18.",
    ]);
  });

  it("omits empty blocks so the prefix matches the no-instructions case", () => {
    const out = assembleRequest({ ...base, base: "", instructions: "   ", memory: [] });
    expect(out.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("puts breakpoint A on the last stable system entry, never on the date", () => {
    const out = assembleRequest({ ...base, base: "BASE", memory: ["x"] });
    const system = out.filter((m) => m.role === "system");
    expect(system[0].providerOptions).toBeUndefined(); // BASE
    expect(system[1].providerOptions).toEqual(CACHE); // memory (last stable)
    expect(system[2].providerOptions).toBeUndefined(); // date
  });

  it("puts breakpoint B on the latest user turn's text part only", () => {
    const out = assembleRequest(base);
    const turns = out.filter((m) => m.role !== "system");
    expect(turns).toEqual([
      { role: "user", content: "OPT one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: [{ type: "text", text: "OPT two", providerOptions: CACHE }] },
    ]);
  });

  it("substitutes the optimized prompt for the latest user turn", () => {
    const out = assembleRequest({ ...base, optimizedPrompt: "REWRITTEN" });
    const last = out[out.length - 1];
    expect(last).toEqual({
      role: "user",
      content: [{ type: "text", text: "REWRITTEN", providerOptions: CACHE }],
    });
  });
});
