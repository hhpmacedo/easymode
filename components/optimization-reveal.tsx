"use client";
import { useState } from "react";
import { turnCosts, formatUSD } from "@/lib/costs";
import { PRICING } from "@/lib/pricing";
import { SavingsBadge } from "./savings-badge";
import type { EasyMetadata } from "@/lib/types";

export function OptimizationReveal({ meta, rawText }: { meta: EasyMetadata; rawText: string }) {
  const [open, setOpen] = useState(false);
  const { routing, classifierUsage, usage } = meta;
  if (!routing) return null;

  const costs =
    usage && classifierUsage ? turnCosts(routing.finalModel, usage, classifierUsage) : null;
  const label = PRICING[routing.finalModel].label;

  return (
    <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/60 text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-zinc-400 hover:text-zinc-200"
      >
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-semibold text-zinc-200">
          {label}
        </span>
        {routing.fallback && (
          <span className="text-xs text-amber-400">routing unavailable — used default</span>
        )}
        {costs && <SavingsBadge savings={costs.savings} pct={costs.savingsPct} />}
        <span className="ml-auto text-xs">{open ? "hide" : "how?"}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-zinc-800 px-3 py-3">
          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase text-zinc-500">
              Your prompt → optimized
            </h4>
            <p className="whitespace-pre-wrap rounded bg-zinc-950 p-2 text-zinc-500 line-through decoration-zinc-700">
              {rawText}
            </p>
            <p className="mt-1 whitespace-pre-wrap rounded bg-zinc-950 p-2 text-zinc-200">
              {routing.optimizedPrompt}
            </p>
          </section>
          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase text-zinc-500">Routing</h4>
            <p className="text-zinc-300">
              {routing.taskType} · {routing.complexity} → <strong>{label}</strong>
              {routing.guardrailApplied && " (guardrail adjusted)"}
            </p>
            <p className="text-zinc-400">{routing.reasoning}</p>
          </section>
          {costs && (
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase text-zinc-500">
                Cost (estimated)
              </h4>
              <table className="w-full text-xs text-zinc-400">
                <tbody>
                  <tr>
                    <td>Answer on {label}</td>
                    <td className="text-right">{formatUSD(costs.chosenCost)}</td>
                  </tr>
                  <tr>
                    <td>Router (Haiku)</td>
                    <td className="text-right">{formatUSD(costs.classifierCost)}</td>
                  </tr>
                  <tr className="text-zinc-300">
                    <td>Total</td>
                    <td className="text-right">{formatUSD(costs.totalCost)}</td>
                  </tr>
                  <tr>
                    <td>Same answer on Opus 4.8</td>
                    <td className="text-right">{formatUSD(costs.baselineCost)}</td>
                  </tr>
                  <tr className={costs.savings >= 0 ? "text-emerald-400" : "text-amber-400"}>
                    <td>{costs.savings >= 0 ? "Saved" : "Premium paid"}</td>
                    <td className="text-right">{formatUSD(Math.abs(costs.savings))}</td>
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
