import { describe, it, expect } from "vitest";
import { costOf, turnCosts, formatUSD } from "../costs";

const usage = { inputTokens: 1000, outputTokens: 2000 };
const clsUsage = { inputTokens: 500, outputTokens: 100 };

describe("costOf", () => {
  it("computes haiku cost from per-MTok prices", () => {
    // 1000*1 + 2000*5 = 11000 / 1e6 = 0.011
    expect(costOf("claude-haiku-4-5", usage)).toBeCloseTo(0.011, 10);
  });
  it("opus costs 5x haiku input, 5x output", () => {
    expect(costOf("claude-opus-4-8", usage)).toBeCloseTo(costOf("claude-haiku-4-5", usage) * 5, 10);
  });
});

describe("turnCosts", () => {
  it("counts classifier cost against savings", () => {
    const t = turnCosts("claude-haiku-4-5", usage, clsUsage);
    expect(t.totalCost).toBeCloseTo(t.chosenCost + t.classifierCost, 10);
    expect(t.savings).toBeCloseTo(t.baselineCost - t.totalCost, 10);
    expect(t.savings).toBeGreaterThan(0);
  });
  it("baseline holds output constant at Opus prices", () => {
    const t = turnCosts("claude-sonnet-5", usage, clsUsage);
    expect(t.baselineCost).toBeCloseTo((1000 * 5 + 2000 * 25) / 1_000_000, 10);
  });
  it("savings go negative when Fable is chosen", () => {
    const t = turnCosts("claude-fable-5", usage, clsUsage);
    expect(t.savings).toBeLessThan(0);
  });
  it("savingsPct is 0 when baseline is 0", () => {
    const t = turnCosts("claude-haiku-4-5", { inputTokens: 0, outputTokens: 0 }, { inputTokens: 0, outputTokens: 0 });
    expect(t.savingsPct).toBe(0);
  });
});

describe("formatUSD", () => {
  it("shows sub-cent amounts with 4 decimals", () => {
    expect(formatUSD(0.000421)).toBe("$0.0004");
  });
  it("shows cent-scale amounts with 3 decimals", () => {
    expect(formatUSD(0.0214)).toBe("$0.021");
  });
  it("shows dollar-scale with 2 decimals", () => {
    expect(formatUSD(1.5)).toBe("$1.50");
  });
});
