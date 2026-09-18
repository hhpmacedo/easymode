"use client";
import { useEffect, useRef } from "react";
import { costOf } from "@/lib/costs";
import { CLASSIFIER_MODEL } from "@/lib/pricing";
import { getUserKey } from "@/lib/client-key";
import { getSettings } from "@/lib/settings";
import {
  EXTRACT_IDLE_MS,
  EXTRACT_MIN_USER_TURNS,
  extractionSchema,
  mergeMemories,
  needsConsolidation,
  newUserTurnsSince,
  turnsSince,
} from "@/lib/memory";
import type { MemoryStore } from "@/lib/memory-store";
import type { ConversationStore } from "@/lib/storage";
import type { EasyUIMessage, Memory, TokenUsage } from "@/lib/types";

export const MEMORY_ADDED_EVENT = "easymode:memory-added";

// Survives remounts (the chat view remounts per conversation), so a switch
// away cannot start a second extraction for the same conversation.
const inFlight = new Set<string>();

/** Quiet-moment memory extraction (spec §5.2): when the user switches away
 *  from a conversation, or it sits idle for 10 minutes after an answer, and
 *  it has ≥ 2 unread user turns, send the new turns (raw text) plus the
 *  current memories to /api/memory/extract, merge, store, record the cost,
 *  and announce what was remembered. Never mid-stream; never blocking chat. */
export function useMemoryExtraction({
  conversationId,
  messages,
  status,
  store,
  memoryStore,
}: {
  conversationId: string;
  messages: EasyUIMessage[];
  status: string;
  store: ConversationStore;
  memoryStore: MemoryStore;
}) {
  // Latest values for the unmount trigger without re-subscribing. Written
  // in an effect (after every render), not during render: react-hooks/refs.
  const latest = useRef({ messages, status });
  useEffect(() => {
    latest.current = { messages, status };
  });

  const extract = async (snapshot: EasyUIMessage[]) => {
    if (!getSettings().memoryEnabled || inFlight.has(conversationId)) return;
    // No meta means the conversation was deleted (not switched away from):
    // never extract from content the user just discarded.
    const meta = store.getMeta(conversationId);
    if (!meta) return;
    const through = meta.extractedThrough;
    if (newUserTurnsSince(snapshot, through) < EXTRACT_MIN_USER_TURNS) return;
    const turns = turnsSince(snapshot, through);
    if (!turns.length) return;
    inFlight.add(conversationId);
    try {
      const before = memoryStore.list();
      const active = before.filter((m) => m.status === "active");
      const key = getUserKey();
      const r = await fetch("/api/memory/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { "x-anthropic-key": key } : {}) },
        body: JSON.stringify({
          turns,
          memories: active.map(({ id, text, kind }) => ({ id, text, kind })),
          consolidate: needsConsolidation(before),
        }),
      });
      if (!r.ok) {
        console.warn("[easymode] memory extraction failed:", r.status);
        return;
      }
      const data = (await r.json()) as { result?: unknown; usage?: TokenUsage };
      const result = extractionSchema.safeParse(data.result);
      if (!result.success) return;
      // Merge against the CURRENT list (the user may have edited meanwhile),
      // and diff against that same list so the toast (and its Undo) only
      // covers what this extraction added — not memories added in flight.
      const current = memoryStore.list();
      const merged = mergeMemories(current, result.data, {
        now: Date.now(),
        conversationId,
        newId: () => crypto.randomUUID(),
      });
      memoryStore.replaceAll(merged);
      if (data.usage) memoryStore.recordCost(costOf(CLASSIFIER_MODEL, data.usage));
      store.setExtractedThrough(conversationId, snapshot[snapshot.length - 1].id);
      const added = merged.filter((m) => !current.some((b) => b.id === m.id));
      if (added.length) {
        window.dispatchEvent(new CustomEvent<Memory[]>(MEMORY_ADDED_EVENT, { detail: added }));
      }
    } catch (err) {
      console.warn("[easymode] memory extraction failed:", err);
    } finally {
      inFlight.delete(conversationId);
    }
  };

  // Idle trigger: 10 minutes after the thread goes ready.
  useEffect(() => {
    if (status !== "ready") return;
    const t = setTimeout(() => void extract(latest.current.messages), EXTRACT_IDLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- extract reads through refs/stores
  }, [status, messages]);

  // Switch-away trigger: the chat view unmounts on conversation change.
  useEffect(() => {
    return () => {
      if (latest.current.status === "ready") void extract(latest.current.messages);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount
  }, [conversationId]);
}
