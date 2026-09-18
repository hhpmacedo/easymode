"use client";
import { useState } from "react";
import { KeyPanel } from "./key-settings";
import {
  getSettings,
  setInstructions,
  setCompactThreshold,
  INSTRUCTIONS_MAX,
  COMPACT_THRESHOLD_MIN,
  COMPACT_THRESHOLD_MAX,
} from "@/lib/settings";

export type SettingsTab = "key" | "instructions" | "context";

/** The Settings modal (spec §8): API key · Instructions. Memory and Context
 *  tabs arrive with plans 3–4. Opens from the header; `initialTab` lets the
 *  "connect a key" flows land on the key tab. */
export function SettingsModal({
  onClose,
  initialTab = "key",
}: {
  onClose: () => void;
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 px-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-[0_8px_40px_rgba(29,26,21,0.18)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Settings"
      >
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif text-xl italic text-ink">Settings</h2>
          <button
            onClick={onClose}
            className="text-sm text-muted hover:text-ink"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 flex gap-1 border-b border-line" role="tablist">
          {(
            [
              ["key", "API key"],
              ["instructions", "Instructions"],
              ["context", "Context"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
                tab === id
                  ? "border-ink text-ink"
                  : "border-transparent text-muted hover:text-ink-soft"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {tab === "key" ? (
            <KeyPanel />
          ) : tab === "instructions" ? (
            <InstructionsPanel />
          ) : (
            <ContextPanel />
          )}
        </div>
      </div>
    </div>
  );
}

/** "How I like answers" — standing preferences sent with every message inside
 *  <user_instructions> (spec §4.2). Saved on blur and on Save; stays in this
 *  browser. */
function InstructionsPanel() {
  // Client-only mount (modal opens on click), so reading localStorage here is safe.
  const [draft, setDraft] = useState(() => getSettings().instructions);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const save = () => {
    setInstructions(draft);
    setDraft(getSettings().instructions); // reflect trim/cap
    setSavedAt(Date.now());
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-soft">
        How you like answers. Applies to every conversation, on top of the built-in style. Stored in
        this browser only.
      </p>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value.slice(0, INSTRUCTIONS_MAX));
          setSavedAt(null);
        }}
        onBlur={save}
        rows={7}
        maxLength={INSTRUCTIONS_MAX}
        aria-label="Instructions"
        placeholder={
          "e.g. I'm a TypeScript developer; prefer pnpm and functional style.\nKeep answers short unless I ask for detail. Reply in Portuguese when I write in Portuguese."
        }
        className="w-full resize-y rounded-xl border border-line bg-paper px-3 py-2.5 text-sm leading-relaxed outline-none focus:border-line-strong"
      />
      <div className="flex items-center justify-between text-[12px] text-muted">
        <span className="tabular">
          {draft.length} / {INSTRUCTIONS_MAX}
        </span>
        <span className="flex items-center gap-3">
          {savedAt && <span className="text-pine-deep">Saved</span>}
          <button
            onClick={save}
            className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper transition-colors hover:bg-ink-soft"
          >
            Save
          </button>
        </span>
      </div>
    </div>
  );
}

/** Compaction threshold (spec §6.1): when a conversation's context passes it,
 *  older turns are summarized in the background after the next answer. */
function ContextPanel() {
  const [value, setValue] = useState(() => getSettings().compactThreshold);
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Long conversations get expensive because every message re-sends the whole thread. When a
        conversation grows past this size, EasyMode summarizes the older turns into a compact note
        the model reads instead — you can see and edit it in the thread.
      </p>
      <label className="block text-[13px] text-ink">
        Compact when a conversation exceeds{" "}
        <strong className="tabular">{Math.round(value / 1000)}K</strong> tokens
        <input
          type="range"
          min={COMPACT_THRESHOLD_MIN}
          max={COMPACT_THRESHOLD_MAX}
          step={10_000}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            setValue(v);
            setCompactThreshold(v);
          }}
          className="mt-2 w-full"
          aria-label="Compaction threshold"
        />
      </label>
      <p className="text-[12px] text-muted">
        Default 60K. Lower saves more; higher keeps more verbatim detail.
      </p>
    </div>
  );
}
