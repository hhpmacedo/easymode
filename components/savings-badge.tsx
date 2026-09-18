"use client";
import { formatUSD } from "@/lib/costs";
import { BASELINE_MODEL, PRICING } from "@/lib/pricing";
import type { SavingsTier } from "@/lib/costs";

const BASE = PRICING[BASELINE_MODEL].label;

export function SavingsBadge({
  tier,
  amount,
  pct,
}: {
  tier: SavingsTier;
  amount: number;
  pct: number;
}) {
  const style =
    tier === "saved"
      ? "border-pine/20 bg-pine-soft text-pine-deep"
      : tier === "premium"
        ? "border-amber/20 bg-amber-soft text-amber"
        : "border-line bg-paper text-muted";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${style}`}
      title={
        tier === "matched"
          ? `${BASE} was the cheapest model that would do the job — no savings possible, and no premium.`
          : `Estimated vs always using ${BASE}, holding output length constant. Includes router cost.`
      }
    >
      {tier === "matched" ? (
        <span className="font-medium">top model — no cheaper option</span>
      ) : (
        <>
          <span className="font-medium">{tier === "saved" ? "saved" : "premium"}</span>
          <span className="tabular">
            {formatUSD(amount)} ({pct.toFixed(0)}%)
          </span>
        </>
      )}
      <span className="text-[10px] uppercase tracking-wider opacity-60">est</span>
    </span>
  );
}
