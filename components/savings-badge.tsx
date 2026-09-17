"use client";
import { formatUSD } from "@/lib/costs";

export function SavingsBadge({ savings, pct }: { savings: number; pct: number }) {
  const positive = savings >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        positive ? "bg-emerald-950 text-emerald-300" : "bg-amber-950 text-amber-300"
      }`}
      title="Estimated vs always using Opus 4.8, holding output length constant. Includes router cost."
    >
      {positive ? "saved" : "premium"} {formatUSD(Math.abs(savings))} ({Math.abs(pct).toFixed(0)}%) · est.
    </span>
  );
}
