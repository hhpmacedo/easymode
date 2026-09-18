"use client";
import { useEffect, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import { turnCosts, formatUSD } from "@/lib/costs";
import type { ConversationStore } from "@/lib/storage";
import type { EasyUIMessage } from "@/lib/types";

interface Props {
  conversationId: string;
  initialMessages: EasyUIMessage[];
  store: ConversationStore;
  onMessagesChanged: () => void; // lets the page refresh sidebar titles
}

export function ChatView({ conversationId, initialMessages, store, onMessagesChanged }: Props) {
  const { messages, sendMessage, status, error, regenerate } = useChat<EasyUIMessage>({
    id: conversationId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  // Persist on every change (spec §7 storage).
  useEffect(() => {
    if (messages.length) {
      store.saveMessages(conversationId, messages);
      onMessagesChanged();
    }
  }, [messages, conversationId, store, onMessagesChanged]);

  // Conversation-level savings total (spec §5).
  const total = useMemo(() => {
    let savings = 0;
    let baseline = 0;
    for (const m of messages) {
      const meta = m.metadata;
      if (m.role === "assistant" && meta?.routing && meta.usage && meta.classifierUsage) {
        const t = turnCosts(meta.routing.finalModel, meta.usage, meta.classifierUsage);
        savings += t.savings;
        baseline += t.baselineCost;
      }
    }
    return { savings, baseline, pct: baseline > 0 ? (savings / baseline) * 100 : 0 };
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 items-center justify-between border-b border-line bg-paper/80 px-6 backdrop-blur">
        <h1 className="text-[13px] font-medium uppercase tracking-[0.14em] text-muted">
          Conversation
        </h1>
        {total.baseline > 0 && (
          <span className="flex items-center gap-2 text-xs text-muted">
            <strong
              className={`rounded-full border px-2.5 py-1 font-medium ${
                total.savings >= 0
                  ? "border-pine/20 bg-pine-soft text-pine-deep"
                  : "border-amber/20 bg-amber-soft text-amber"
              }`}
            >
              {total.savings >= 0 ? "saved" : "premium"}{" "}
              <span className="tabular">
                {formatUSD(Math.abs(total.savings))} (~{Math.abs(total.pct).toFixed(0)}%)
              </span>
            </strong>{" "}
            vs always-Opus · est.
          </span>
        )}
      </header>
      <MessageList messages={messages} status={status} error={error} onRetry={() => regenerate()} />
      <Composer disabled={busy} onSend={(text) => sendMessage({ text })} />
    </div>
  );
}
