import {
  BASELINE_MODEL,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  CLASSIFIER_MODEL,
  PRICING,
} from "./pricing";
import type { ModelId, TokenUsage } from "./types";

/** USD for one call. Cached input is a subset of `inputTokens`: reads are
 *  billed at 10% of the input rate (or the model's flat override), writes at
 *  125% (spec §3.1). */
export function costOf(model: ModelId, usage: TokenUsage): number {
  const p = PRICING[model];
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - read - write);
  const readPerMTok = p.cacheReadPerMTok ?? p.inputPerMTok * CACHE_READ_MULTIPLIER;
  const input =
    uncached * p.inputPerMTok +
    read * readPerMTok +
    write * p.inputPerMTok * CACHE_WRITE_MULTIPLIER;
  return (input + usage.outputTokens * p.outputPerMTok) / 1_000_000;
}

/** How a turn's cost compares to the always-baseline counterfactual:
 *  - saved:   a cheaper model did the job → real money saved
 *  - matched: the baseline (top general) model was the right call → no cheaper
 *             option existed; the only delta is the tiny routing fee, so this is
 *             break-even, NOT a loss
 *  - premium: the task needed a model above the ceiling (Fable) → genuinely
 *             paid more than the baseline */
export type SavingsTier = "saved" | "matched" | "premium";

export interface TurnCosts {
  chosenCost: number;
  classifierCost: number;
  totalCost: number;
  baselineCost: number; // counterfactual: same output tokens at baseline prices
  tier: SavingsTier;
  /** saved → $ saved vs baseline; premium → $ paid above baseline;
   *  matched → the routing overhead (the Haiku fee), shown for transparency. */
  amount: number;
  /** amount as a % of the baseline cost; 0 for matched (break-even). */
  pct: number;
}

// Ignore sub-hundredth-of-a-cent noise when classifying a turn.
const EPS = 5e-7;

export function turnCosts(
  model: ModelId,
  answerUsage: TokenUsage,
  classifierUsage: TokenUsage,
): TurnCosts {
  const chosenCost = costOf(model, answerUsage);
  const classifierCost = costOf(CLASSIFIER_MODEL, classifierUsage);
  const baselineCost = costOf(BASELINE_MODEL, answerUsage);
  const totalCost = chosenCost + classifierCost;

  let tier: SavingsTier;
  let amount: number;
  if (chosenCost > baselineCost + EPS) {
    // Chose a model pricier than the ceiling (Fable) — a real premium.
    tier = "premium";
    amount = totalCost - baselineCost;
  } else {
    const net = baselineCost - totalCost; // savings after the routing fee
    if (net > EPS) {
      tier = "saved";
      amount = net;
    } else {
      // The baseline model itself (or a cheaper one whose saving the routing fee
      // erased): no cheaper option really helped. Break-even, not a loss.
      tier = "matched";
      amount = totalCost - baselineCost; // the routing overhead (≥ 0)
    }
  }
  const pct = baselineCost > 0 && tier !== "matched" ? (amount / baselineCost) * 100 : 0;
  return { chosenCost, classifierCost, totalCost, baselineCost, tier, amount, pct };
}

/** Roll per-turn costs into a conversation verdict. Matched turns are
 *  break-even: they add to the baseline denominator but neither save nor cost. */
export interface ConversationSavings {
  tier: SavingsTier;
  amount: number; // net $ saved (tier saved) or net $ premium (tier premium); 0 if matched
  pct: number;
}

export function conversationSavings(turns: TurnCosts[]): ConversationSavings {
  let saved = 0;
  let premium = 0;
  let baseline = 0;
  for (const t of turns) {
    baseline += t.baselineCost;
    if (t.tier === "saved") saved += t.amount;
    else if (t.tier === "premium") premium += t.amount;
  }
  const net = saved - premium;
  const tier: SavingsTier = net > EPS ? "saved" : net < -EPS ? "premium" : "matched";
  const amount = Math.abs(net);
  const pct = baseline > 0 && tier !== "matched" ? (amount / baseline) * 100 : 0;
  return { tier, amount, pct };
}

export function formatUSD(n: number): string {
  const abs = Math.abs(n);
  const digits = abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  return `${n < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}

/** Compact token count for the UI: 842 · 4.3K · 41K · 1.5M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}
