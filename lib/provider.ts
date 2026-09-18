/** Anthropic provider selection. SERVER ONLY.
 *
 *  EasyMode runs in two billing modes, decided per request:
 *  - BYOK: the request carries the user's own key (header) → bill their account.
 *  - Shared: no user key → use the server's ANTHROPIC_API_KEY (behind the gate).
 *
 *  `providerFor` returns a provider bound to whichever key applies. A user key
 *  is used transiently to build the provider and never stored or logged. */
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";

export type AnthropicProvider = typeof anthropic;

/** Anthropic keys look like `sk-ant-...`. A cheap format gate so we never build
 *  a provider from obvious junk and so the UI can validate before spending. */
export function isAnthropicKeyFormat(key: unknown): key is string {
  return typeof key === "string" && /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

/** Provider bound to `apiKey` when given, else the ambient env-key provider. */
export function providerFor(apiKey?: string): AnthropicProvider {
  return apiKey ? createAnthropic({ apiKey }) : anthropic;
}
