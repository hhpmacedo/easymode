import type { ModelId } from "./types";

/** Single source of truth for prices. USD per 1M tokens. */
export const PRICES_AS_OF = "2026-09-17";

export const PRICING: Record<
  ModelId,
  { inputPerMTok: number; outputPerMTok: number; label: string }
> = {
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0, label: "Haiku 4.5" },
  "claude-sonnet-5": { inputPerMTok: 3.0, outputPerMTok: 15.0, label: "Sonnet 5" },
  "claude-opus-4-8": { inputPerMTok: 5.0, outputPerMTok: 25.0, label: "Opus 4.8" },
  "claude-fable-5": { inputPerMTok: 10.0, outputPerMTok: 50.0, label: "Fable 5" },
};

export const BASELINE_MODEL: ModelId = "claude-opus-4-8";
export const CLASSIFIER_MODEL: ModelId = "claude-haiku-4-5";
export const DEFAULT_FALLBACK_MODEL: ModelId = "claude-sonnet-5";
