"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import { SettingsModal, type SettingsTab } from "./settings-modal";
import { useCompaction } from "./use-compaction";
import { turnCosts, conversationSavings, formatUSD, formatTokens } from "@/lib/costs";
import { BASELINE_MODEL, PRICING } from "@/lib/pricing";
import { getUserKey, KEY_CHANGE_EVENT } from "@/lib/client-key";
import { getSettings } from "@/lib/settings";
import { PROMPT_VERSION } from "@/lib/prompts/base";
import type { ConversationStore } from "@/lib/storage";
import type { CompactionSummary, EasyUIMessage } from "@/lib/types";

interface Props {
  conversationId: string;
  initialMessages: EasyUIMessage[];
  store: ConversationStore;
  onMessagesChanged: () => void; // lets the page refresh sidebar titles
}

export function ChatView({ conversationId, initialMessages, store, onMessagesChanged }: Props) {
  // null = closed; otherwise which tab to open on.
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [hasUserKey, setHasUserKey] = useState<boolean>(() => !!getUserKey());
  // A suggestion clicked before a key is connected: send it once they connect.
  const pendingRef = useRef<string | null>(null);

  const { messages, sendMessage, status, error, regenerate } = useChat<EasyUIMessage>({
    id: conversationId,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // Read the key at send time so connecting/disconnecting takes effect
      // immediately. Sent only when present; omitted → server key path.
      headers: (): Record<string, string> => {
        const key = getUserKey();
        return key ? { "x-anthropic-key": key } : {};
      },
      // Context rides with every send (spec §7.1). Read at send time so an
      // edit in Settings applies to the next message with no reload.
      body: () => {
        const c = store.getMeta(conversationId)?.compaction;
        return {
          context: {
            instructions: getSettings().instructions,
            promptVersion: PROMPT_VERSION,
            ...(c
              ? { compaction: { throughMessageId: c.throughMessageId, summary: c.summary } }
              : {}),
          },
        };
      },
      // Send only the turns the server needs (spec §7.1): the stored thread
      // keeps every compacted turn, so posting all of it outgrows the route's
      // body caps after a few cycles. Slice from the boundary message
      // inclusive — assembleRequest ignores a throughMessageId it cannot
      // find and would silently send the full thread — and it keeps the
      // tier ratchet intact, since the boundary assistant carries its
      // routing.finalModel.
      prepareSendMessagesRequest: ({ messages, body }) => {
        const c = store.getMeta(conversationId)?.compaction;
        const idx = c ? messages.findIndex((m) => m.id === c.throughMessageId) : -1;
        return { body: { ...body, messages: idx > 0 ? messages.slice(idx) : messages } };
      },
    }),
  });

  // Compaction lives on the store's meta, not in useChat state; bump a
  // counter when it changes so the card and header re-read it.
  const [metaVersion, setMetaVersion] = useState(0);
  const onMetaChanged = useCallback(() => {
    setMetaVersion((v) => v + 1);
    onMessagesChanged();
  }, [onMessagesChanged]);
  const { compactNow, contextTokens } = useCompaction({
    conversationId,
    messages,
    status,
    store,
    onChanged: onMetaChanged,
  });
  const compaction = useMemo(
    () => store.getMeta(conversationId)?.compaction,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- metaVersion is the invalidation signal
    [store, conversationId, metaVersion],
  );
  const saveCompaction = (summary: CompactionSummary) => {
    if (!compaction) return;
    store.setCompaction(conversationId, { ...compaction, summary, edited: true });
    onMetaChanged();
  };

  // Track key connect/disconnect; flush a pending suggestion once connected.
  // setState/send happen in the event callback, not the effect body.
  useEffect(() => {
    const onChange = () => {
      const has = !!getUserKey();
      setHasUserKey(has);
      if (has && pendingRef.current) {
        const text = pendingRef.current;
        pendingRef.current = null;
        setSettings(null);
        sendMessage({ text });
      }
    };
    window.addEventListener(KEY_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(KEY_CHANGE_EVENT, onChange);
  }, [sendMessage]);

  // A suggestion "just works": send it if a key is connected, otherwise open
  // the key modal and send automatically once they connect.
  const onSuggestion = (text: string) => {
    if (getUserKey()) sendMessage({ text });
    else {
      pendingRef.current = text;
      setSettings("key");
    }
  };

  // Persist on every change (spec §7 storage).
  useEffect(() => {
    if (messages.length) {
      store.saveMessages(conversationId, messages);
      onMessagesChanged();
    }
  }, [messages, conversationId, store, onMessagesChanged]);

  // Conversation-level savings verdict (spec §5).
  const total = useMemo(() => {
    const turns = [];
    for (const m of messages) {
      const meta = m.metadata;
      if (m.role === "assistant" && meta?.routing && meta.usage && meta.classifierUsage) {
        turns.push(turnCosts(meta.routing.finalModel, meta.usage, meta.classifierUsage));
      }
    }
    return { hasTurns: turns.length > 0, ...conversationSavings(turns) };
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 items-center justify-between border-b border-line bg-paper/80 px-6 backdrop-blur">
        <div className="flex items-center gap-3">
          <h1 className="text-[13px] font-medium uppercase tracking-[0.14em] text-muted">
            Conversation
          </h1>
          <button
            onClick={() => setSettings("key")}
            className="rounded-lg border border-line px-2.5 py-1 text-xs text-ink-soft transition-colors hover:bg-surface"
            title="Settings: API key, instructions"
          >
            Settings
          </button>
          {contextTokens > 0 && (
            <button
              onClick={() => void compactNow()}
              className="rounded-lg border border-line px-2.5 py-1 text-xs text-ink-soft transition-colors hover:bg-surface"
              title="Context the model sees on the next message. Click to summarize older turns now."
            >
              Context <span className="tabular">{formatTokens(contextTokens)}</span> · compact
            </button>
          )}
        </div>
        {total.hasTurns && (
          <span className="flex items-center gap-2 text-xs text-muted">
            <strong
              className={`rounded-full border px-2.5 py-1 font-medium ${
                total.tier === "saved"
                  ? "border-pine/20 bg-pine-soft text-pine-deep"
                  : total.tier === "premium"
                    ? "border-amber/20 bg-amber-soft text-amber"
                    : "border-line bg-paper text-muted"
              }`}
            >
              {total.tier === "matched" ? (
                "on the best models"
              ) : (
                <>
                  {total.tier === "saved" ? "saved" : "premium"}{" "}
                  <span className="tabular">
                    {formatUSD(total.amount)} (~{total.pct.toFixed(0)}%)
                  </span>
                </>
              )}
            </strong>{" "}
            vs always-{PRICING[BASELINE_MODEL].label} · est.
          </span>
        )}
      </header>
      <MessageList
        messages={messages}
        status={status}
        error={error}
        onRetry={() => regenerate()}
        needsKey={!hasUserKey}
        onConnectKey={() => setSettings("key")}
        onSuggestion={onSuggestion}
        compaction={compaction}
        onSaveCompaction={saveCompaction}
      />
      <Composer disabled={busy} onSend={(text) => sendMessage({ text })} />
      {settings && <SettingsModal initialTab={settings} onClose={() => setSettings(null)} />}
    </div>
  );
}
