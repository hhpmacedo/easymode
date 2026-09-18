import { describe, it, expect } from "vitest";
import { applyGuardrail } from "../router";

const SHORT = "hello there friend"; // 3 words, no code
const LONG = Array(320).fill("word").join(" "); // >300 words
const CODE = "why does this fail?\n```js\nconst x = 1;\n```";
const HARD60 = Array(60).fill("analyze").join(" "); // >50 words
const MID20 = Array(20).fill("ponder").join(" "); // 15–50 words, no code

describe("applyGuardrail", () => {
  it("caps short non-code messages at Sonnet", () => {
    expect(applyGuardrail("claude-opus-5", "everyday", SHORT)).toEqual({
      model: "claude-sonnet-5",
      applied: true,
    });
    expect(applyGuardrail("claude-fable-5-1", "exceptional", SHORT).model).toBe("claude-sonnet-5");
  });
  it("does not cap short messages with multiple questions", () => {
    const multi = "why? how? really?";
    expect(applyGuardrail("claude-opus-5", "hard", multi).model).toBe("claude-opus-5");
  });
  it("floors code-bearing messages at Sonnet", () => {
    expect(applyGuardrail("claude-haiku-4-5", "trivial", CODE)).toEqual({
      model: "claude-sonnet-5",
      applied: true,
    });
  });
  it("floors >300-word messages at Sonnet", () => {
    expect(applyGuardrail("claude-haiku-4-5", "trivial", LONG).model).toBe("claude-sonnet-5");
  });
  it("demotes Fable to Opus unless complexity is exceptional AND >50 words", () => {
    expect(applyGuardrail("claude-fable-5-1", "hard", HARD60).model).toBe("claude-opus-5");
    // 15–50 words: escapes the short-message cap, but still not substantial enough for Fable.
    expect(applyGuardrail("claude-fable-5-1", "exceptional", MID20).model).toBe("claude-opus-5");
    expect(applyGuardrail("claude-fable-5-1", "exceptional", HARD60).model).toBe(
      "claude-fable-5-1",
    );
  });
  it("does not drop a short follow-up below the prior tier (criterion 3)", () => {
    // "now make it faster" after a hard/Opus task: cap must not undercut Opus.
    expect(applyGuardrail("claude-opus-5", "hard", "now make it faster", "claude-opus-5")).toEqual({
      model: "claude-opus-5",
      applied: false,
    });
    // Without a prior tier the cap still applies.
    expect(applyGuardrail("claude-opus-5", "hard", "now make it faster").model).toBe(
      "claude-sonnet-5",
    );
    // A prior tier at/below Sonnet does not weaken the cap.
    expect(applyGuardrail("claude-opus-5", "everyday", SHORT, "claude-haiku-4-5").model).toBe(
      "claude-sonnet-5",
    );
  });
  it("ratchets: never drops below the prior tier, whatever the classifier says (spec §3.2)", () => {
    // Trivial follow-up after an Opus task stays on Opus — the cached thread is per model.
    expect(applyGuardrail("claude-haiku-4-5", "trivial", "ok thanks", "claude-opus-5")).toEqual({
      model: "claude-opus-5",
      applied: true,
    });
    // Everyday follow-up after a Fable task stays on Fable.
    expect(applyGuardrail("claude-sonnet-5", "everyday", MID20, "claude-fable-5-1").model).toBe(
      "claude-fable-5-1",
    );
    // Legacy prior ids rank the same as their successors.
    expect(
      applyGuardrail("claude-haiku-4-5", "trivial", "ok thanks", "claude-opus-4-8").model,
    ).toBe("claude-opus-4-8");
  });
  it("leaves valid choices untouched", () => {
    expect(
      applyGuardrail(
        "claude-sonnet-5",
        "everyday",
        "summarize the article I pasted below please: " + LONG,
      ),
    ).toEqual({
      model: "claude-sonnet-5",
      applied: false,
    });
  });
});
