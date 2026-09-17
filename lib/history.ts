import { messageText } from "./types";
import type { EasyUIMessage } from "./types";

export interface SimpleModelMessage {
  role: "user" | "assistant";
  content: string;
}

export function latestUserText(messages: EasyUIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messageText(messages[i]);
  }
  return "";
}

/**
 * Model history carries OPTIMIZED user prompts (spec §3.2).
 * A user message's optimized text lives on the metadata of the assistant
 * message that follows it. The latest user turn uses `latestOptimized`
 * (from the classifier call just made).
 */
export function buildModelMessages(
  messages: EasyUIMessage[],
  latestOptimized: string,
): SimpleModelMessage[] {
  const out: SimpleModelMessage[] = [];
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");

  messages.forEach((m, i) => {
    if (m.role === "user") {
      if (i === lastUserIdx) {
        out.push({ role: "user", content: latestOptimized });
        return;
      }
      const next = messages[i + 1];
      const optimized =
        next?.role === "assistant" ? next.metadata?.routing?.optimizedPrompt : undefined;
      out.push({ role: "user", content: optimized || messageText(m) });
    } else if (m.role === "assistant") {
      const text = messageText(m);
      if (text) out.push({ role: "assistant", content: text });
    }
  });
  return out;
}
