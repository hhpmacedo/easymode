"use client";
import { useEffect, useState } from "react";
import { MEMORY_ADDED_EVENT } from "./use-memory-extraction";
import type { MemoryStore } from "@/lib/memory-store";
import type { Memory } from "@/lib/types";

const TOAST_MS = 8_000;

/** "Remembered: … · Undo" (spec §5.6). Auto-save with undo: the user is
 *  informed, never asked. Undo archives the memory. */
export function MemoryToast({ memoryStore }: { memoryStore: MemoryStore }) {
  const [batch, setBatch] = useState<Memory[] | null>(null);

  useEffect(() => {
    const onAdded = (e: Event) => setBatch((e as CustomEvent<Memory[]>).detail);
    window.addEventListener(MEMORY_ADDED_EVENT, onAdded);
    return () => window.removeEventListener(MEMORY_ADDED_EVENT, onAdded);
  }, []);

  useEffect(() => {
    if (!batch) return;
    const t = setTimeout(() => setBatch(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [batch]);

  if (!batch?.length) return null;
  const first = batch[0];
  const more = batch.length - 1;
  return (
    <div className="pointer-events-none fixed bottom-24 left-1/2 z-40 -translate-x-1/2">
      <div className="animate-rise pointer-events-auto flex max-w-lg items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 text-[13px] text-ink shadow-[0_8px_30px_rgba(29,26,21,0.14)]">
        <span className="text-muted">Remembered:</span>
        <span className="truncate">
          {first.text}
          {more > 0 && <span className="text-muted"> +{more} more</span>}
        </span>
        <button
          onClick={() => {
            for (const m of batch) memoryStore.archive(m.id);
            setBatch(null);
          }}
          className="rounded-lg border border-line px-2 py-1 text-[12px] text-ink-soft hover:bg-paper"
        >
          Undo
        </button>
      </div>
    </div>
  );
}
