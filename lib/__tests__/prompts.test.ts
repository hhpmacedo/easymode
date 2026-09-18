import { describe, it, expect } from "vitest";
import { BASE_PROMPT, PROMPT_VERSION } from "../prompts/base";
import {
  CONSOLIDATE_NOTE,
  EXTRACTION_SYSTEM,
  MAX_TURNS,
  MAX_TURN_CHARS,
  PROMPT_LINE_CHARS,
  buildExtractionPrompt,
  clipTurns,
} from "../prompts/memory";
import { MEMORY_TEXT_MAX } from "../memory";

describe("base prompt", () => {
  it("has a date-stamped version so evals can be tied to prompt edits", () => {
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
  it("is short: roughly 300–800 tokens (spec §4.1)", () => {
    expect(BASE_PROMPT.length).toBeGreaterThan(1_200); // ~300 tokens at 4 chars/token
    expect(BASE_PROMPT.length).toBeLessThan(3_200); // ~800 tokens
  });
  it("names the context tags assembleRequest renders, so the two stay in sync", () => {
    expect(BASE_PROMPT).toContain("<user_instructions>");
    expect(BASE_PROMPT).toContain("<memory>");
  });
  it("contains nothing volatile (no dates, times or ids)", () => {
    expect(BASE_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(BASE_PROMPT).not.toMatch(/\b(today|now)\b.*\d/i);
  });
  it("is a single frozen string", () => {
    expect(typeof BASE_PROMPT).toBe("string");
    expect(BASE_PROMPT.trim()).toBe(BASE_PROMPT);
  });
});

describe("extraction prompt", () => {
  it("asks for lines with headroom under the schema's hard cap", () => {
    expect(PROMPT_LINE_CHARS).toBeLessThan(MEMORY_TEXT_MAX);
    expect(EXTRACTION_SYSTEM).toContain(`under ${PROMPT_LINE_CHARS} characters`);
  });
});

describe("clipTurns", () => {
  it("keeps the newest MAX_TURNS turns", () => {
    const turns = Array.from({ length: MAX_TURNS + 5 }, (_, i) => ({
      role: "user" as const,
      text: `t${i}`,
    }));
    const out = clipTurns(turns);
    expect(out).toHaveLength(MAX_TURNS);
    expect(out[0].text).toBe("t5");
    expect(out[out.length - 1].text).toBe(`t${MAX_TURNS + 4}`);
  });
  it("clips each turn to MAX_TURN_CHARS and leaves short turns alone", () => {
    const out = clipTurns([
      { role: "user", text: "x".repeat(MAX_TURN_CHARS + 100) },
      { role: "assistant", text: "short" },
    ]);
    expect(out[0].text).toHaveLength(MAX_TURN_CHARS);
    expect(out[1]).toEqual({ role: "assistant", text: "short" });
  });
});

describe("buildExtractionPrompt", () => {
  const turns = [
    { role: "user" as const, text: "I use pnpm" },
    { role: "assistant" as const, text: "Noted." },
  ];
  it("labels turns USER/ASSISTANT and says when there are no memories", () => {
    const p = buildExtractionPrompt(turns, []);
    expect(p).toContain("EXISTING MEMORIES: none");
    expect(p).toContain("NEW TURNS:\nUSER: I use pnpm\n\nASSISTANT: Noted.");
    expect(p.startsWith(CONSOLIDATE_NOTE)).toBe(false);
  });
  it("lists memories as id · kind · text rows, so update/archive ids resolve", () => {
    const p = buildExtractionPrompt(turns, [
      { id: "m1", kind: "preference", text: "Prefers pnpm" },
      { id: "m2", kind: "profile", text: "Works in Rust" },
    ]);
    expect(p).toContain(
      "EXISTING MEMORIES (id · kind · text):\nm1 · preference · Prefers pnpm\nm2 · profile · Works in Rust",
    );
    expect(p).not.toContain("EXISTING MEMORIES: none");
  });
  it("prefixes the consolidation note only when asked", () => {
    expect(buildExtractionPrompt(turns, [], true).startsWith(CONSOLIDATE_NOTE + "\n\n")).toBe(true);
  });
});
