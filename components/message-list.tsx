"use client";
import { Fragment, useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { OptimizationReveal } from "./optimization-reveal";
import { CompactionCard } from "./compaction-card";
import { messageText } from "@/lib/types";
import type { Compaction, CompactionSummary, EasyUIMessage } from "@/lib/types";

// Deliberately lazy, casual prompts that span the routing tiers, so a new user
// sees the rewrite AND different models: haiku → Haiku, email → Sonnet,
// debugging → Opus.
const SUGGESTIONS = [
  "write a haiku about mondays",
  "draft a polite email to reschedule a meeting",
  "explain how HTTPS works to a 10-year-old",
  "walk me through fixing a deadlock in multithreaded code",
];

interface Props {
  messages: EasyUIMessage[];
  status: "submitted" | "streaming" | "ready" | "error";
  error?: Error;
  onRetry: () => void;
  needsKey?: boolean;
  onConnectKey?: () => void;
  onSuggestion?: (text: string) => void;
  compaction?: Compaction;
  onSaveCompaction?: (summary: CompactionSummary) => void;
}

export function MessageList({
  messages,
  status,
  error,
  onRetry,
  needsKey,
  onConnectKey,
  onSuggestion,
  compaction,
  onSaveCompaction,
}: Props) {
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
        ? "Routing…"
        : null;

  // Turns through the compaction boundary are still shown, greyed: the model
  // no longer sees them (spec §6.4). The card sits right after the boundary.
  const boundary = compaction
    ? messages.findIndex((m) => m.id === compaction.throughMessageId)
    : -1;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        {messages.length === 0 && status === "ready" && (
          <div className="pt-24 text-center">
            <p className="font-serif text-3xl italic tracking-tight text-ink">
              Ask casually. We&rsquo;ll prompt precisely.
            </p>
            <p className="mt-2 text-sm text-muted">
              Every message is routed to the cheapest capable Claude model; longer ones are tuned
              into a precise prompt first.
            </p>
            {needsKey && (
              <button
                onClick={onConnectKey}
                className="mt-6 rounded-xl bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-colors hover:bg-ink-soft"
              >
                Connect your Anthropic key to start
              </button>
            )}
            <div className="mt-10">
              <p className="mb-3 text-[11px] uppercase tracking-[0.14em] text-muted">
                Try one to see it in action
              </p>
              <div className="mx-auto flex max-w-xl flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => onSuggestion?.(s)}
                    className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <Fragment key={m.id}>
            {m.role === "user" ? (
              <div
                className={`animate-rise flex justify-end${boundary >= 0 && i <= boundary ? " opacity-50" : ""}`}
              >
                <div
                  data-testid="user-bubble"
                  className="max-w-[80%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[15px] whitespace-pre-wrap text-paper shadow-[0_2px_8px_rgba(29,26,21,0.15)]"
                >
                  {messageText(m)}
                </div>
              </div>
            ) : (
              <div className={`animate-rise${boundary >= 0 && i <= boundary ? " opacity-50" : ""}`}>
                <div className="answer-prose text-[15px] leading-relaxed">
                  <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {messageText(m)}
                  </Markdown>
                </div>
                {m.metadata && <OptimizationReveal meta={m.metadata} rawText={rawBefore(i)} />}
              </div>
            )}
            {i === boundary && compaction && onSaveCompaction && (
              <CompactionCard compaction={compaction} onSave={onSaveCompaction} />
            )}
          </Fragment>
        ))}
        {stage && <p className="shimmer-text text-sm">{stage}</p>}
        {status === "error" && (
          <div className="animate-rise flex items-center gap-3 rounded-xl border border-rust/25 bg-rust-soft px-4 py-3 text-sm text-rust">
            <span className="flex-1">{error?.message || "Something went wrong."}</span>
            <button
              onClick={onRetry}
              className="rounded-lg bg-rust px-3 py-1.5 text-xs font-medium text-paper transition-opacity hover:opacity-90"
            >
              Retry
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
