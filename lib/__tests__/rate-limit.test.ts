import { describe, it, expect } from "vitest";
import { RateLimiter, clientKey } from "../rate-limit";

describe("RateLimiter", () => {
  it("allows up to the limit inside a window, then blocks with Retry-After", () => {
    let now = 1_000_000;
    const rl = new RateLimiter({ limit: 3, windowMs: 60_000 }, () => now);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a")).toMatchObject({ allowed: true, remaining: 0 });
    const blocked = rl.check("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60);
    // Other keys are independent.
    expect(rl.check("b").allowed).toBe(true);
    // Window slides: after 60s the first hit expires.
    now += 60_001;
    expect(rl.check("a").allowed).toBe(true);
  });
});

describe("clientKey", () => {
  const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });
  it("prefers the first x-forwarded-for hop, then x-real-ip, else unknown", () => {
    expect(clientKey(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
    expect(clientKey(req({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientKey(req({}))).toBe("unknown");
  });
});
