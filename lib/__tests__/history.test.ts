import { describe, it, expect } from "vitest";
import { buildModelMessages, latestUserText } from "../history";
import type { EasyUIMessage } from "../types";

function user(id: string, text: string): EasyUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as EasyUIMessage;
}
function assistant(id: string, text: string, optimizedPrompt?: string): EasyUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: optimizedPrompt
      ? { routing: { optimizedPrompt } as never }
      : undefined,
  } as EasyUIMessage;
}

describe("latestUserText", () => {
  it("returns the text of the last user message", () => {
    expect(latestUserText([user("1", "a"), assistant("2", "b"), user("3", "c")])).toBe("c");
  });
});

describe("buildModelMessages", () => {
  it("substitutes optimized prompts from the FOLLOWING assistant metadata", () => {
    const msgs = [
      user("1", "raw one"),
      assistant("2", "answer one", "OPTIMIZED one"),
      user("3", "raw two"),
    ];
    const out = buildModelMessages(msgs, "OPTIMIZED two");
    expect(out).toEqual([
      { role: "user", content: "OPTIMIZED one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "OPTIMIZED two" },
    ]);
  });
  it("falls back to raw text when no optimized version exists", () => {
    const msgs = [user("1", "raw one"), assistant("2", "answer one"), user("3", "raw two")];
    const out = buildModelMessages(msgs, "OPTIMIZED two");
    expect(out[0]).toEqual({ role: "user", content: "raw one" });
    expect(out[2]).toEqual({ role: "user", content: "OPTIMIZED two" });
  });
});
