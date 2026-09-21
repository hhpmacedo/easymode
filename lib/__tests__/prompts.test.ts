import { describe, it, expect } from "vitest";
import { BASE_PROMPT, PROMPT_VERSION } from "../prompts/base";

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
