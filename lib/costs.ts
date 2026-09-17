import { BASELINE_MODEL, CLASSIFIER_MODEL, PRICING } from "./pricing";
import type { ModelId, TokenUsage } from "./types";

export function costOf(model: ModelId, usage: TokenUsage): number {
  const p = PRICING[model];
  return (usage.inputTokens * p.inputPerMTok + usage.outputTokens * p.outputPerMTok) / 1_000_000;
}

export interface TurnCosts {
  chosenCost: number;
  classifierCost: number;
  totalCost: number;
  baselineCost: number; // counterfactual: same tokens at always-Opus prices
  savings: number; // baselineCost - totalCost (can be negative for Fable)
  savingsPct: number;
}

export function turnCosts(
  model: ModelId,
  answerUsage: TokenUsage,
  classifierUsage: TokenUsage,
): TurnCosts {
  const chosenCost = costOf(model, answerUsage);
  const classifierCost = costOf(CLASSIFIER_MODEL, classifierUsage);
  const baselineCost = costOf(BASELINE_MODEL, answerUsage);
  const totalCost = chosenCost + classifierCost;
  const savings = baselineCost - totalCost;
  const savingsPct = baselineCost > 0 ? (savings / baselineCost) * 100 : 0;
  return { chosenCost, classifierCost, totalCost, baselineCost, savings, savingsPct };
}

export function formatUSD(n: number): string {
  const abs = Math.abs(n);
  const digits = abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  return `${n < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}
