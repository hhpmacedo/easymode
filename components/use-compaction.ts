"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  chooseCompactionBoundary,
  compactionSummarySchema,
  lastInputTokens,
  nextContextTokens,
} from "@/lib/compaction";
import { getUserKey } from "@/lib/client-key";
import { getSettings } from "@/lib/settings";
import type { ConversationStore } from "@/lib/storage";
import type { EasyUIMessage } from "@/lib/types";

/** Compaction trigger (spec §6.1). Automatic: when a turn finishes and the
 *  thread's context exceeds the threshold, compact the older turns in the
 *  background — never before a send, so it adds no latency. Manual: the
 *  header's Compact action. A failure is logged and the automatic trigger
 *  backs off for FAILURE_BACKOFF_MS (a manual Compact bypasses it), so a
 *  thread that cannot be compacted does not pay for a Haiku call on every
 *  turn; nothing here blocks chat. */

export type CompactionState = "idle" | "running" | "done" | "failed" | "nothing";

const FAILURE_BACKOFF_MS = 10 * 60_000;
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
  const failedAt = useRef<number | null>(null);
  const [state, setState] = useState<CompactionState>("idle");

  const run = useCallback(async () => {
    if (busy.current) return;
    const prior = store.getMeta(conversationId)?.compaction;
    const choice = chooseCompactionBoundary(messages, prior?.throughMessageId);
    if (!choice) {
      setState("nothing");
      return;
    }
    busy.current = true;
    setState("running");
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
        failedAt.current = Date.now();
        setState("failed");
        return;
      }
      const data: unknown = await r.json();
      const summary = compactionSummarySchema.safeParse(
        (data as { summary?: unknown } | null)?.summary,
      );
      if (!summary.success) {
        failedAt.current = Date.now();
        setState("failed");
        return; // never store what the schema rejects
      }
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
        // Sticky: once the user has edited a summary, every later re-compaction
        // keeps telling the compactor to preserve it (spec §6.2).
        edited: prior?.edited ?? false,
      });
      failedAt.current = null;
      setState("done");
      onChanged();
    } catch (err) {
      console.warn("[easymode] compaction failed:", err);
      failedAt.current = Date.now();
      setState("failed");
    } finally {
      busy.current = false;
    }
  }, [conversationId, messages, store, onChanged]);

  // Automatic trigger: after the assistant turn finishes, if over threshold
  // and not backing off from a recent failure. A stored boundary that no
  // longer exists in the thread (deleted/regenerated turn) is cleared so the
  // user is not left with an invisible compaction.
  useEffect(() => {
    if (status !== "ready" || messages.length === 0) return;
    const prior = store.getMeta(conversationId)?.compaction;
    if (prior && !messages.some((m) => m.id === prior.throughMessageId)) {
      store.setCompaction(conversationId, undefined);
      onChanged();
      return;
    }
    if (failedAt.current && Date.now() - failedAt.current < FAILURE_BACKOFF_MS) return;
    if (lastInputTokens(messages) <= getSettings().compactThreshold) return;
    // Defer a tick: the trigger sets state (running/nothing), which must not
    // happen synchronously inside an effect; the cleanup cancels a schedule
    // that a newer render superseded.
    const t = setTimeout(() => void run(), 0);
    return () => clearTimeout(t);
  }, [status, messages, run, store, conversationId, onChanged]);

  const compaction = store.getMeta(conversationId)?.compaction;
  return {
    compactNow: run,
    contextTokens: nextContextTokens(messages, compaction),
    state,
  };
}
