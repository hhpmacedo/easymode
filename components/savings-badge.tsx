"use client";
import { formatUSD } from "@/lib/costs";

export function SavingsBadge({ savings, pct }: { savings: number; pct: number }) {
  const positive = savings >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
        positive
          ? "border-pine/20 bg-pine-soft text-pine-deep"
          : "border-amber/20 bg-amber-soft text-amber"
      }`}
      title="Estimated vs always using Opus 4.8, holding output length constant. Includes router cost."
    >
      <span className="font-medium">{positive ? "saved" : "premium"}</span>
      <span className="tabular">
        {formatUSD(Math.abs(savings))} ({Math.abs(pct).toFixed(0)}%)
      </span>
      <span className="text-[10px] uppercase tracking-wider opacity-60">est</span>
    </span>
  );
}
