"use client";
import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { OptimizationReveal } from "./optimization-reveal";
import { messageText } from "@/lib/types";
import type { EasyUIMessage } from "@/lib/types";

interface Props {
  messages: EasyUIMessage[];
  status: "submitted" | "streaming" | "ready" | "error";
  error?: Error;
  onRetry: () => void;
}

export function MessageList({ messages, status, error, onRetry }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  // The raw user text preceding each assistant message (for the reveal diff).
  const rawBefore = (i: number): string => {
    for (let j = i - 1; j >= 0; j--)
      if (messages[j].role === "user") return messageText(messages[j]);
    return "";
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const stage =
    status === "submitted"
      ? "Analyzing & optimizing your prompt…"
      : status === "streaming" && lastAssistant && !messageText(lastAssistant)
        ? `Routing…`
        : null;

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-6">
      {messages.map((m, i) =>
        m.role === "user" ? (
          <div
            key={m.id}
            className="ml-auto max-w-[80%] rounded-2xl bg-blue-600/20 px-4 py-2 whitespace-pre-wrap"
          >
            {messageText(m)}
          </div>
        ) : (
          <div key={m.id} className="max-w-[90%]">
            <div className="prose prose-invert prose-sm max-w-none rounded-2xl bg-zinc-900 px-4 py-3">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {messageText(m)}
              </Markdown>
            </div>
            {m.metadata && <OptimizationReveal meta={m.metadata} rawText={rawBefore(i)} />}
          </div>
        ),
      )}
      {stage && <p className="animate-pulse text-sm text-zinc-500">{stage}</p>}
      {status === "error" && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-300">
          {error?.message || "Something went wrong."}
          <button
            onClick={onRetry}
            className="ml-3 rounded bg-red-900 px-2 py-1 text-xs hover:bg-red-800"
          >
            Retry
          </button>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
