import type { ModelId } from "./types";

/** Single source of truth for prices. USD per 1M tokens. Verified against the
 *  Anthropic pricing docs on this date. */
export const PRICES_AS_OF = "2026-09-18";

export const PRICING: Record<
  ModelId,
  { inputPerMTok: number; outputPerMTok: number; label: string }
> = {
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0, label: "Haiku 4.5" },
  "claude-sonnet-5": { inputPerMTok: 3.0, outputPerMTok: 15.0, label: "Sonnet 5" },
  "claude-opus-5": { inputPerMTok: 5.0, outputPerMTok: 25.0, label: "Opus 5" },
  "claude-fable-5-1": { inputPerMTok: 10.0, outputPerMTok: 50.0, label: "Fable 5.1" },
  // Legacy — superseded at the same price. Kept so older stored conversations
  // still resolve a label/price.
  "claude-opus-4-8": { inputPerMTok: 5.0, outputPerMTok: 25.0, label: "Opus 4.8" },
  "claude-fable-5": { inputPerMTok: 10.0, outputPerMTok: 50.0, label: "Fable 5" },
};

/** The premium ceiling the savings estimate compares against: the current
 *  flagship general model, Opus 5. */
export const BASELINE_MODEL: ModelId = "claude-opus-5";
export const CLASSIFIER_MODEL: ModelId = "claude-haiku-4-5";
export const DEFAULT_FALLBACK_MODEL: ModelId = "claude-sonnet-5";

/** Prompt-cache pricing relative to the model's input rate (5-minute TTL). */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Runaway guard on answer length, by tier — generous on purpose. The cost
 *  control is the tier ratchet plus caching, not this cap (spec §3.3). */
export const MAX_OUTPUT_TOKENS: Record<ModelId, number> = {
  "claude-haiku-4-5": 8_000,
  "claude-sonnet-5": 16_000,
  "claude-opus-5": 32_000,
  "claude-fable-5-1": 32_000,
  "claude-opus-4-8": 32_000,
  "claude-fable-5": 32_000,
};
