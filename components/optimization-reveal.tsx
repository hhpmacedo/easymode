"use client";
import { useState } from "react";
import { turnCosts, formatUSD, formatTokens } from "@/lib/costs";
import { BASELINE_MODEL, PRICING } from "@/lib/pricing";
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
        {costs && <SavingsBadge tier={costs.tier} amount={costs.amount} pct={costs.pct} />}
        <span className="ml-auto text-[11px] uppercase tracking-wider text-muted">
          {open ? "hide" : "how?"}
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-line px-4 py-4">
          {routing.optimizedPrompt === rawText ? (
            <section>
              <Label>Your prompt</Label>
              <p className="rounded-lg bg-paper px-3 py-2 text-[13px] whitespace-pre-wrap text-ink">
                {rawText}
              </p>
              <p className="mt-1.5 text-[12px] text-muted">
                Sent as written — short messages are never rewritten.
              </p>
            </section>
          ) : (
            <section>
              <Label>Your prompt → optimized</Label>
              <p className="rounded-lg bg-paper px-3 py-2 text-[13px] whitespace-pre-wrap text-muted line-through decoration-line-strong">
                {rawText}
              </p>
              <p className="mt-1.5 rounded-lg border border-pine/15 bg-pine-soft/50 px-3 py-2 text-[13px] whitespace-pre-wrap text-ink">
                {routing.optimizedPrompt}
              </p>
            </section>
          )}

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
              {usage && (
                <p className="mb-2 text-[13px] text-ink-soft">
                  Input {formatTokens(usage.inputTokens)} tokens
                  {(usage.cacheReadTokens ?? 0) > 0 && (
                    <> · {formatTokens(usage.cacheReadTokens ?? 0)} from cache</>
                  )}
                  {(usage.cacheWriteTokens ?? 0) > 0 && (
                    <> · {formatTokens(usage.cacheWriteTokens ?? 0)} written to cache</>
                  )}
                </p>
              )}
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
                    <td>Same answer on {PRICING[BASELINE_MODEL].label}</td>
                    <td className="tabular text-right">{formatUSD(costs.baselineCost)}</td>
                  </tr>
                  <tr
                    className={`border-t border-line ${
                      costs.tier === "saved"
                        ? "text-pine-deep"
                        : costs.tier === "premium"
                          ? "text-amber"
                          : "text-muted"
                    }`}
                  >
                    <td className="font-medium">
                      {costs.tier === "saved"
                        ? "Saved"
                        : costs.tier === "premium"
                          ? "Premium paid"
                          : "Top model — no cheaper option"}
                    </td>
                    <td className="tabular text-right font-medium">
                      {costs.tier === "matched"
                        ? `+${formatUSD(costs.amount)}`
                        : formatUSD(costs.amount)}
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
