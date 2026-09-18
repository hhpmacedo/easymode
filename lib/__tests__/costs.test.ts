import { describe, it, expect } from "vitest";
import { costOf, turnCosts, conversationSavings, formatUSD, formatTokens } from "../costs";

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
  it("prices cache reads at 10% of the input rate", () => {
    // 10,000 total input, of which 9,000 read from cache:
    // 1,000 * 1.0 + 9,000 * 1.0 * 0.1 = 1,900 → 0.0019
    const u = { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 9_000 };
    expect(costOf("claude-haiku-4-5", u)).toBeCloseTo(0.0019, 10);
  });
  it("prices cache writes at 125% of the input rate", () => {
    // 1,000 input, all written to cache: 1,000 * 1.0 * 1.25 = 1,250 → 0.00125
    const u = { inputTokens: 1_000, outputTokens: 0, cacheWriteTokens: 1_000 };
    expect(costOf("claude-haiku-4-5", u)).toBeCloseTo(0.00125, 10);
  });
  it("treats missing cache fields as zero (legacy stored turns)", () => {
    expect(costOf("claude-haiku-4-5", { inputTokens: 1000, outputTokens: 2000 })).toBeCloseTo(
      0.011,
      10,
    );
  });
  it("splits a real cached turn three ways (read + written + fresh)", () => {
    // 30K total: 26K read + 3K written + 1K fresh, on Haiku ($1/MTok input)
    const u = {
      inputTokens: 30_000,
      outputTokens: 0,
      cacheReadTokens: 26_000,
      cacheWriteTokens: 3_000,
    };
    expect(costOf("claude-haiku-4-5", u)).toBeCloseTo(
      (1_000 + 26_000 * 0.1 + 3_000 * 1.25) / 1e6,
      12,
    );
  });
  it("uses a model's flat cache-read price when it departs from the 10% rule (Fable 5.1)", () => {
    // 10K read on Fable 5.1: $0.25/MTok, not 10% of $10 → 2,500 not 10,000
    const u = { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 10_000 };
    expect(costOf("claude-fable-5-1", u)).toBeCloseTo(2_500 / 1e6, 12);
  });
  it("never prices negative uncached tokens if cache counts exceed the total", () => {
    const u = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 200 };
    expect(costOf("claude-haiku-4-5", u)).toBeCloseTo((200 * 0.1) / 1_000_000, 12);
  });
});

describe("turnCosts", () => {
  it("a cheaper model is 'saved', counting the router fee against it", () => {
    const t = turnCosts("claude-haiku-4-5", usage, clsUsage);
    expect(t.totalCost).toBeCloseTo(t.chosenCost + t.classifierCost, 10);
    expect(t.tier).toBe("saved");
    expect(t.amount).toBeCloseTo(t.baselineCost - t.totalCost, 10);
    expect(t.amount).toBeGreaterThan(0);
  });
  it("baseline holds output constant at baseline (Opus 5) prices", () => {
    const t = turnCosts("claude-sonnet-5", usage, clsUsage);
    expect(t.baselineCost).toBeCloseTo((1000 * 5 + 2000 * 25) / 1_000_000, 10);
  });
  it("the baseline model itself is 'matched', not a premium", () => {
    const t = turnCosts("claude-opus-5", usage, clsUsage);
    expect(t.tier).toBe("matched");
    // amount is just the routing overhead (the Haiku fee), never negative
    expect(t.amount).toBeGreaterThanOrEqual(0);
    expect(t.amount).toBeCloseTo(t.classifierCost, 10);
    expect(t.pct).toBe(0);
  });
  it("a pricier-than-ceiling model (Fable) is a real 'premium'", () => {
    const t = turnCosts("claude-fable-5-1", usage, clsUsage);
    expect(t.tier).toBe("premium");
    expect(t.amount).toBeCloseTo(t.totalCost - t.baselineCost, 10);
    expect(t.amount).toBeGreaterThan(0);
  });
  it("pct is 0 when baseline is 0", () => {
    const t = turnCosts(
      "claude-haiku-4-5",
      { inputTokens: 0, outputTokens: 0 },
      { inputTokens: 0, outputTokens: 0 },
    );
    expect(t.pct).toBe(0);
  });
});

describe("conversationSavings", () => {
  it("nets saved turns against premium turns", () => {
    const saved = turnCosts("claude-haiku-4-5", usage, clsUsage);
    const premium = turnCosts("claude-fable-5-1", usage, clsUsage);
    const c = conversationSavings([saved, premium]);
    expect(c.tier).toBe(saved.amount > premium.amount ? "saved" : "premium");
  });
  it("a conversation entirely on the baseline model is 'matched' (break-even)", () => {
    const t = turnCosts("claude-opus-5", usage, clsUsage);
    const c = conversationSavings([t, t]);
    expect(c.tier).toBe("matched");
    expect(c.amount).toBe(0);
    expect(c.pct).toBe(0);
  });
  it("empty conversation is matched with zero", () => {
    expect(conversationSavings([])).toEqual({ tier: "matched", amount: 0, pct: 0 });
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

describe("formatTokens", () => {
  it("shows small counts verbatim", () => {
    expect(formatTokens(842)).toBe("842");
  });
  it("shows thousands with one decimal under 10K", () => {
    expect(formatTokens(4_250)).toBe("4.3K");
  });
  it("shows whole thousands at 10K and above", () => {
    expect(formatTokens(41_300)).toBe("41K");
  });
  it("shows millions with one decimal", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});
