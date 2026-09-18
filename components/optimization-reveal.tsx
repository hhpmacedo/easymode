"use client";
import { useState } from "react";
import { turnCosts, formatUSD } from "@/lib/costs";
import { PRICING } from "@/lib/pricing";
import { SavingsBadge } from "./savings-badge";
import type { EasyMetadata } from "@/lib/types";

function Label({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
      {children}
    </h4>
  );
}

export function OptimizationReveal({ meta, rawText }: { meta: EasyMetadata; rawText: string }) {
  const [open, setOpen] = useState(false);
  const { routing, classifierUsage, usage } = meta;
  if (!routing) return null;

  const costs =
    usage && classifierUsage ? turnCosts(routing.finalModel, usage, classifierUsage) : null;
  const label = PRICING[routing.finalModel].label;

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-line bg-surface text-sm shadow-[0_1px_3px_rgba(29,26,21,0.04)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-paper/60"
      >
        <span className="rounded-md border border-line bg-paper px-2 py-0.5 text-xs font-medium text-ink">
          {label}
        </span>
        {routing.fallback && (
          <span className="text-xs text-amber">routing unavailable — used default</span>
        )}
        {costs && <SavingsBadge savings={costs.savings} pct={costs.savingsPct} />}
        <span className="ml-auto text-[11px] uppercase tracking-wider text-muted">
          {open ? "hide" : "how?"}
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-line px-4 py-4">
          <section>
            <Label>Your prompt → optimized</Label>
            <p className="rounded-lg bg-paper px-3 py-2 text-[13px] whitespace-pre-wrap text-muted line-through decoration-line-strong">
              {rawText}
            </p>
            <p className="mt-1.5 rounded-lg border border-pine/15 bg-pine-soft/50 px-3 py-2 text-[13px] whitespace-pre-wrap text-ink">
              {routing.optimizedPrompt}
            </p>
          </section>

          <section>
            <Label>Routing</Label>
            <p className="text-ink">
              {routing.taskType} · {routing.complexity} →{" "}
              <strong className="font-semibold">{label}</strong>
              {routing.guardrailApplied && (
                <span className="text-muted"> (guardrail adjusted)</span>
              )}
            </p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-soft">{routing.reasoning}</p>
          </section>

          {costs && (
            <section>
              <Label>Cost — estimated</Label>
              <table className="w-full text-[13px]">
                <tbody className="[&_td]:py-1">
                  <tr className="text-ink-soft">
                    <td>Answer on {label}</td>
                    <td className="tabular text-right">{formatUSD(costs.chosenCost)}</td>
                  </tr>
                  <tr className="text-ink-soft">
                    <td>Router (Haiku)</td>
                    <td className="tabular text-right">{formatUSD(costs.classifierCost)}</td>
                  </tr>
                  <tr className="border-t border-line text-ink">
                    <td className="font-medium">Total</td>
                    <td className="tabular text-right font-medium">{formatUSD(costs.totalCost)}</td>
                  </tr>
                  <tr className="text-muted">
                    <td>Same answer on Opus 4.8</td>
                    <td className="tabular text-right">{formatUSD(costs.baselineCost)}</td>
                  </tr>
                  <tr
                    className={`border-t border-line ${costs.savings >= 0 ? "text-pine-deep" : "text-amber"}`}
                  >
                    <td className="font-medium">{costs.savings >= 0 ? "Saved" : "Premium paid"}</td>
                    <td className="tabular text-right font-medium">
                      {formatUSD(Math.abs(costs.savings))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
