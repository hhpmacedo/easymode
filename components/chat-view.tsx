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
    return { savings, pct: baseline > 0 ? (savings / baseline) * 100 : 0 };
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-zinc-300">EasyMode</h1>
        {messages.some((m) => m.role === "assistant") && (
          <span className="text-xs text-zinc-400">
            This conversation:{" "}
            <strong className={total.savings >= 0 ? "text-emerald-400" : "text-amber-400"}>
              {total.savings >= 0 ? "saved" : "premium"} {formatUSD(Math.abs(total.savings))} (~
              {Math.abs(total.pct).toFixed(0)}%)
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
