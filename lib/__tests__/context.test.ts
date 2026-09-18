import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { assembleRequest, todayISO } from "../context";
import { COMPACTION_ACK, renderCompaction } from "../compaction";
import type { CompactionSummary, EasyUIMessage } from "../types";

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

  it("with no instruction layer, instructions is just the date, and it carries no breakpoint", () => {
    const { instructions } = assembleRequest(base);
    expect(instructions).toEqual([{ role: "system", content: "Today is 2026-09-18." }]);
  });

  it("orders instructions base → user instructions → memory → date", () => {
    const { instructions } = assembleRequest({
      ...base,
      base: "BASE",
      instructions: "  be terse  ",
      memory: ["prefers pnpm", "works in TS"],
    });
    expect(instructions.map((m) => m.content)).toEqual([
      "BASE",
      "<user_instructions>\nbe terse\n</user_instructions>",
      "<memory>\n- prefers pnpm\n- works in TS\n</memory>",
      "Today is 2026-09-18.",
    ]);
  });

  it("omits empty blocks so the prefix matches the no-instructions case", () => {
    const { instructions } = assembleRequest({
      ...base,
      base: "",
      instructions: "   ",
      memory: [],
    });
    expect(instructions).toHaveLength(1);
  });

  it("puts breakpoint A on the last stable instruction entry, never on the date", () => {
    const { instructions } = assembleRequest({ ...base, base: "BASE", memory: ["x"] });
    expect(instructions[0].providerOptions).toBeUndefined(); // BASE
    expect(instructions[1].providerOptions).toEqual(CACHE); // memory (last stable)
    expect(instructions[2].providerOptions).toBeUndefined(); // date
  });

  it("keeps system entries out of messages (the AI SDK rejects them there)", () => {
    const { messages } = assembleRequest({ ...base, base: "BASE", memory: ["x"] });
    expect(messages.some((m) => m.role === "system")).toBe(false);
  });

  it("puts breakpoint B on the latest user turn's text part only", () => {
    const { messages } = assembleRequest(base);
    expect(messages).toEqual([
      { role: "user", content: "OPT one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: [{ type: "text", text: "OPT two", providerOptions: CACHE }] },
    ]);
  });

  it("keeps turn N's request as a byte-identical prefix of turn N+1 (minus the moved B)", () => {
    const prev = assembleRequest(base);
    const next = assembleRequest({
      ...base,
      messages: [...thread, assistant("4", "answer two", "OPT two"), user("5", "raw three")],
      optimizedPrompt: "OPT three",
    });
    expect(next.instructions).toEqual(prev.instructions);
    // The previous B collapses back to plain text; everything before it is unchanged.
    const prevPlain = [...prev.messages.slice(0, -1), { role: "user", content: "OPT two" }];
    expect(next.messages.slice(0, prevPlain.length)).toEqual(prevPlain);
  });

  it("sets no breakpoint B when the latest turn is not a user message", () => {
    const { messages } = assembleRequest({
      ...base,
      messages: [user("1", "raw one"), assistant("2", "answer one", "OPT one")],
    });
    expect(messages.every((m) => typeof m.content === "string")).toBe(true);
  });

  it("substitutes the optimized prompt for the latest user turn", () => {
    const { messages } = assembleRequest({ ...base, optimizedPrompt: "REWRITTEN" });
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "REWRITTEN", providerOptions: CACHE }],
    });
  });

  // The key-free half of the cache tripwire: the AI SDK must accept the shape
  // (v7 rejects system entries inside `messages`) and both breakpoints must
  // still be on the prompt the provider receives.
  it("is accepted by the AI SDK and both breakpoints reach the model prompt", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "OK" }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const request = assembleRequest({ ...base, base: "BASE", memory: ["x"] });

    await expect(generateText({ model, ...request })).resolves.toBeDefined();

    const prompt = model.doGenerateCalls[0].prompt;
    const system = prompt.filter((m) => m.role === "system");
    expect(system.map((m) => m.content)).toEqual([
      "BASE",
      "<memory>\n- x\n</memory>",
      "Today is 2026-09-18.",
    ]);
    expect(system[0].providerOptions).toBeUndefined();
    expect(system[1].providerOptions).toEqual(CACHE); // breakpoint A survived
    expect(system[2].providerOptions).toBeUndefined();
    expect(prompt[prompt.length - 1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "OPT two", providerOptions: CACHE }], // breakpoint B
    });
  });

  describe("with a compaction", () => {
    const summary: CompactionSummary = {
      goal: "g",
      decisions: ["d1"],
      facts: [],
      artifacts: [],
      open: ["o1"],
    };
    const long = [
      user("1", "raw one"),
      assistant("2", "answer one", "OPT one"),
      user("3", "raw two"),
      assistant("4", "answer two", "OPT two"),
      user("5", "raw three"),
    ];
    const input = {
      messages: long,
      optimizedPrompt: "OPT three",
      today: "2026-09-18",
      compaction: { throughMessageId: "2", summary },
    };

    it("drops turns through the boundary and prepends the compaction pair", () => {
      const { messages } = assembleRequest(input);
      expect(messages).toEqual([
        { role: "user", content: renderCompaction(summary) },
        { role: "assistant", content: COMPACTION_ACK },
        { role: "user", content: "OPT two" },
        { role: "assistant", content: "answer two" },
        { role: "user", content: [{ type: "text", text: "OPT three", providerOptions: CACHE }] },
      ]);
    });
    it("puts no breakpoint on the pair and keeps B on the latest user turn", () => {
      const { messages } = assembleRequest(input);
      expect(messages[0].providerOptions).toBeUndefined();
      expect(messages[1].providerOptions).toBeUndefined();
    });
    it("ignores a boundary id that is not in the thread", () => {
      const { messages } = assembleRequest({
        ...input,
        compaction: { throughMessageId: "missing", summary },
      });
      expect(messages).toHaveLength(5);
      expect(messages[0]).toEqual({ role: "user", content: "OPT one" });
    });
    it("is byte-identical for identical input", () => {
      expect(JSON.stringify(assembleRequest(input))).toBe(JSON.stringify(assembleRequest(input)));
    });
  });
});
