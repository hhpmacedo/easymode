/** Minimal in-memory sliding-window rate limiter. Per-process only: on a
 *  multi-instance/serverless deploy each instance keeps its own counters, so
 *  treat this as a brake on runaway spend, not as the security boundary (the
 *  access token in lib/auth.ts is). Pure aside from the injected clock; unit-tested. */

export interface RateLimitRule {
  /** Max hits allowed per key inside `windowMs`. */
  limit: number;
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  /** Seconds until the oldest hit in the window expires (>= 1 when blocked). */
  retryAfterSec: number;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly rule: RateLimitRule,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit for `key` unless the rule is exhausted. */
  check(key: string): RateLimitVerdict {
    const t = this.now();
    const floor = t - this.rule.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((h) => h > floor);
    if (recent.length >= this.rule.limit) {
      this.hits.set(key, recent);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((recent[0] + this.rule.windowMs - t) / 1000)),
      };
    }
    recent.push(t);
    this.hits.set(key, recent);
    // Opportunistic GC so idle keys don't accumulate forever.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (!v.some((h) => h > floor)) this.hits.delete(k);
    }
    return { allowed: true, remaining: this.rule.limit - recent.length, retryAfterSec: 0 };
  }
}

/** Best-effort client identity. `x-forwarded-for` is attacker-controlled unless
 *  a trusted reverse proxy overwrites it, so a spoofer can dodge the limiter —
 *  never the token check. */
export function clientKey(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
