"use client";
import { useState } from "react";
import { estimateTokens, renderCompaction } from "@/lib/compaction";
import { formatTokens } from "@/lib/costs";
import type { Compaction, CompactionSummary } from "@/lib/types";

const SECTIONS: { key: keyof Omit<CompactionSummary, "goal">; label: string }[] = [
  { key: "decisions", label: "Decisions" },
  { key: "facts", label: "Facts" },
  { key: "artifacts", label: "Artifacts" },
  { key: "open", label: "Open" },
];

/** The boundary card (spec §6.4): what the model now sees instead of the
 *  greyed turns above it. Collapsed by default; expandable; editable. */
export function CompactionCard({
  compaction,
  onSave,
}: {
  compaction: Compaction;
  onSave: (summary: CompactionSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CompactionSummary>(compaction.summary);
  const after = estimateTokens(renderCompaction(compaction.summary));

  const startEdit = () => {
    setDraft(compaction.summary);
    setEditing(true);
    setOpen(true);
  };
  const save = () => {
    onSave({
      goal: draft.goal.trim(),
      decisions: lines(draft.decisions),
      facts: lines(draft.facts),
      artifacts: lines(draft.artifacts),
      open: lines(draft.open),
    });
    setEditing(false);
  };

  return (
    <div className="rounded-xl border border-dashed border-line bg-surface/60 text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] text-ink-soft hover:bg-paper/60"
      >
        <span className="text-muted">⇣</span>
        <span>
          Earlier conversation compacted — {formatTokens(compaction.tokensBefore)} → ~
          {formatTokens(after)} tokens
          {compaction.edited && <span className="text-muted"> · edited</span>}
        </span>
        <span className="ml-auto text-[11px] uppercase tracking-wider text-muted">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-4 py-3">
          {editing ? (
            <>
              <Field label="Goal">
                <input
                  value={draft.goal}
                  onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
                  className="w-full rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[13px] outline-none focus:border-line-strong"
                />
              </Field>
              {SECTIONS.map((s) => (
                <Field key={s.key} label={`${s.label} (one per line)`}>
                  <textarea
                    value={draft[s.key].join("\n")}
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value.split("\n") })}
                    rows={Math.max(2, Math.min(8, draft[s.key].length + 1))}
                    className="w-full resize-y rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[13px] leading-relaxed outline-none focus:border-line-strong"
                  />
                </Field>
              ))}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setEditing(false)}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-soft hover:bg-paper"
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink-soft"
                >
                  Save
                </button>
              </div>
            </>
          ) : (
            <>
              <Field label="Goal">
                <p className="text-[13px] text-ink">{compaction.summary.goal}</p>
              </Field>
              {SECTIONS.map((s) => (
                <Field key={s.key} label={s.label}>
                  {compaction.summary[s.key].length ? (
                    <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-ink">
                      {compaction.summary[s.key].map((item, i) => (
                        <li key={i} className="whitespace-pre-wrap">
                          {item}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[13px] text-muted">none</p>
                  )}
                </Field>
              ))}
              <div className="flex justify-end">
                <button
                  onClick={startEdit}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-soft hover:bg-paper"
                >
                  Edit
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
        {label}
      </h4>
      {children}
    </div>
  );
}

function lines(items: string[]): string[] {
  return items.map((s) => s.trim()).filter(Boolean);
}
