"use client";
import { useEffect, useState } from "react";
import { KeyPanel } from "./key-settings";
import {
  getSettings,
  setInstructions,
  setCompactThreshold,
  setMemoryEnabled,
  INSTRUCTIONS_MAX,
  COMPACT_THRESHOLD_MIN,
  COMPACT_THRESHOLD_MAX,
} from "@/lib/settings";
import { browserMemoryStore, MEMORY_CHANGE_EVENT } from "@/lib/memory-store";
import { formatUSD } from "@/lib/costs";
import type { Memory } from "@/lib/types";

export type SettingsTab = "key" | "instructions" | "memory" | "context";

/** The Settings modal (spec §8): API key · Instructions · Memory · Context.
 *  Opens from the header; `initialTab` lets the "connect a key" flows land on
 *  the key tab. */
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
              ["memory", "Memory"],
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
          ) : tab === "memory" ? (
            <MemoryPanel />
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

/** Memory (spec §8): everything EasyMode has remembered, editable; the
 *  on/off switch; month-to-date extraction cost. Auto-save + undo lives in
 *  the toast; this is the audit and repair surface. */
function MemoryPanel() {
  const [store] = useState(() => browserMemoryStore());
  const [memories, setMemories] = useState<Memory[]>(() => store.active());
  const [archived, setArchived] = useState<Memory[]>(() =>
    store.list().filter((m) => m.status === "archived"),
  );
  const [enabled, setEnabled] = useState(() => getSettings().memoryEnabled);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    const refresh = () => {
      setMemories(store.active());
      setArchived(store.list().filter((m) => m.status === "archived"));
    };
    window.addEventListener(MEMORY_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(MEMORY_CHANGE_EVENT, refresh);
  }, [store]);

  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between text-[13px] text-ink">
        <span>
          Remember durable facts from my conversations
          <span className="block text-[12px] text-muted">
            A small background call after each conversation goes quiet. Stored in this browser only.
          </span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setMemoryEnabled(e.target.checked);
          }}
          aria-label="Memory enabled"
        />
      </label>

      <div className="max-h-72 space-y-1.5 overflow-y-auto">
        {memories.length === 0 && (
          <p className="text-[13px] text-muted">
            Nothing yet. Type <code className="rounded bg-paper px-1">remember: …</code> in a
            message to add one directly.
          </p>
        )}
        {memories.map((m) => (
          <div
            key={m.id}
            className="group flex items-start gap-2 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[13px]"
          >
            <span className="mt-0.5 shrink-0 rounded bg-surface px-1.5 text-[10px] uppercase tracking-wider text-muted">
              {m.kind}
            </span>
            {editing?.id === m.id ? (
              <input
                autoFocus
                value={editing.text}
                onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                onBlur={() => {
                  // An emptied line keeps the old text; use Forget to remove it.
                  const t = editing.text.trim();
                  if (t && t !== m.text) store.update(m.id, t);
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditing(null);
                }}
                className="flex-1 bg-transparent outline-none"
                aria-label="Edit memory"
              />
            ) : (
              <button
                onClick={() => setEditing({ id: m.id, text: m.text })}
                className="flex-1 text-left text-ink"
                title="Edit"
              >
                {m.text}
              </button>
            )}
            <button
              onClick={() => store.archive(m.id)}
              className="text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
              aria-label="Forget"
              title="Forget"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {archived.length > 0 && (
        <details className="text-[12px] text-muted">
          <summary className="cursor-pointer select-none">
            Forgotten ({archived.length}) — including anything an extraction replaced
          </summary>
          <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
            {archived.map((m) => (
              <div key={m.id} className="flex items-start gap-2 rounded-lg px-2.5 py-1">
                <span className="flex-1 text-ink-soft line-through decoration-line-strong">
                  {m.text}
                </span>
                <button
                  onClick={() => store.restore(m.id)}
                  className="rounded-lg border border-line px-2 py-0.5 text-[11px] hover:bg-paper"
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>Extraction this month: {formatUSD(store.monthCost())}</span>
        {memories.length > 0 &&
          (confirmClear ? (
            <span className="flex items-center gap-2">
              <span>Forget everything?</span>
              <button
                onClick={() => {
                  store.clearAll();
                  setConfirmClear(false);
                }}
                className="rounded-lg bg-rust px-2 py-1 text-[12px] font-medium text-paper"
              >
                Yes, clear
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="rounded-lg border border-line px-2 py-1"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="rounded-lg border border-line px-2 py-1 hover:bg-paper"
            >
              Clear all
            </button>
          ))}
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
