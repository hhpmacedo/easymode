"use client";
import { useCallback, useEffect, useRef } from "react";
import {
  chooseCompactionBoundary,
  compactionSummarySchema,
  lastInputTokens,
} from "@/lib/compaction";
import { getUserKey } from "@/lib/client-key";
import { getSettings } from "@/lib/settings";
import type { ConversationStore } from "@/lib/storage";
import type { EasyUIMessage } from "@/lib/types";

/** Compaction trigger (spec §6.1). Automatic: when a turn finishes and the
 *  thread's context exceeds the threshold, compact the older turns in the
 *  background — never before a send, so it adds no latency. Manual: the
 *  header's Compact action. Failures are logged and retried after the next
 *  turn; nothing here blocks chat. */
export function useCompaction({
  conversationId,
  messages,
  status,
  store,
  onChanged,
}: {
  conversationId: string;
  messages: EasyUIMessage[];
  status: string;
  store: ConversationStore;
  onChanged: () => void;
}) {
  const busy = useRef(false);

  const run = useCallback(async () => {
    if (busy.current) return;
    const prior = store.getMeta(conversationId)?.compaction;
    const choice = chooseCompactionBoundary(messages, prior?.throughMessageId);
    if (!choice) return;
    busy.current = true;
    try {
      const key = getUserKey();
      const r = await fetch("/api/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { "x-anthropic-key": key } : {}) },
        body: JSON.stringify({
          // Only what the compactor reads (role + text): metadata (optimized
          // prompts, reasoning, usage) would bloat the body toward the route's
          // size cap at high thresholds and ship classifier reasoning for nothing.
          messages: choice.toCompact.map(({ id, role, parts }) => ({
            id,
            role,
            parts: parts.filter((p) => p.type === "text"),
          })),
          prior: prior?.summary,
          priorEdited: prior?.edited ?? false,
        }),
      });
      if (!r.ok) {
        console.warn("[easymode] compaction request failed:", r.status);
        return;
      }
      const data: unknown = await r.json();
      const summary = compactionSummarySchema.safeParse(
        (data as { summary?: unknown } | null)?.summary,
      );
      if (!summary.success) return; // never store what the schema rejects
      // The user may have edited (or cleared) the boundary card while the
      // request was in flight; that summary was our `prior`, so storing this
      // result would drop their edit. Bail and let the next turn retry from
      // the edited prior. getMeta re-parses storage, so compare by value.
      const now = store.getMeta(conversationId)?.compaction;
      if (JSON.stringify(now) !== JSON.stringify(prior)) return;
      store.setCompaction(conversationId, {
        throughMessageId: choice.throughMessageId,
        summary: summary.data,
        tokensBefore: lastInputTokens(messages),
        createdAt: Date.now(),
        edited: false,
      });
      onChanged();
    } catch (err) {
      console.warn("[easymode] compaction failed:", err);
    } finally {
      busy.current = false;
    }
  }, [conversationId, messages, store, onChanged]);

  // Automatic trigger: after the assistant turn finishes, if over threshold.
  useEffect(() => {
    if (status !== "ready") return;
    if (lastInputTokens(messages) > getSettings().compactThreshold) void run();
  }, [status, messages, run]);

  return { compactNow: run, contextTokens: lastInputTokens(messages) };
}
