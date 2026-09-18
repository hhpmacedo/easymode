import { describe, it, expect } from "vitest";
import {
  SESSION_COOKIE,
  authMode,
  isAuthenticated,
  parseCookies,
  safeEqual,
  sessionCookie,
  sessionValue,
  verifyToken,
} from "../auth";

const TOKEN = "correct-horse-battery-staple";
const prod = { token: TOKEN, nodeEnv: "production" };
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe("authMode", () => {
  it("is token when set, closed in production without one, open otherwise", () => {
    expect(authMode(prod)).toBe("token");
    expect(authMode({ token: "  ", nodeEnv: "production" })).toBe("closed");
    expect(authMode({ nodeEnv: "production" })).toBe("closed");
    expect(authMode({ nodeEnv: "development" })).toBe("open");
    expect(authMode({ nodeEnv: "test" })).toBe("open");
  });
});

describe("verifyToken / safeEqual", () => {
  it("accepts only the exact token", () => {
    expect(verifyToken(TOKEN, prod)).toBe(true);
    expect(verifyToken(TOKEN + "x", prod)).toBe(false);
    expect(verifyToken("", prod)).toBe(false);
    expect(verifyToken(undefined, prod)).toBe(false);
    expect(verifyToken(42, prod)).toBe(false);
  });
  it("never verifies when no token is configured", () => {
    expect(verifyToken("", { nodeEnv: "development" })).toBe(false);
    expect(verifyToken("anything", { nodeEnv: "development" })).toBe(false);
  });
  it("compares strings of different lengths without throwing", () => {
    expect(safeEqual("a", "abc")).toBe(false);
    expect(safeEqual("abc", "abc")).toBe(true);
  });
});

describe("isAuthenticated", () => {
  it("accepts a bearer header or the session cookie in token mode", () => {
    const r = "https://app.example/api/chat";
    expect(isAuthenticated(req(r), prod)).toBe(false);
    expect(isAuthenticated(req(r, { authorization: `Bearer ${TOKEN}` }), prod)).toBe(true);
    expect(isAuthenticated(req(r, { authorization: `Bearer nope` }), prod)).toBe(false);
    const good = `${SESSION_COOKIE}=${sessionValue(TOKEN)}`;
    expect(isAuthenticated(req(r, { cookie: `theme=dark; ${good}` }), prod)).toBe(true);
    expect(isAuthenticated(req(r, { cookie: `${SESSION_COOKIE}=${TOKEN}` }), prod)).toBe(false);
    expect(isAuthenticated(req(r, { cookie: `${SESSION_COOKIE}=` }), prod)).toBe(false);
  });
  it("denies everything when closed, even with a cookie", () => {
    const env = { nodeEnv: "production" };
    const c = { cookie: `${SESSION_COOKIE}=${sessionValue("")}` };
    expect(isAuthenticated(req("https://app.example/api/chat", c), env)).toBe(false);
  });
  it("in open mode allows loopback hosts only", () => {
    const env = { nodeEnv: "development" };
    expect(isAuthenticated(req("http://localhost:3000/api/chat"), env)).toBe(true);
    expect(isAuthenticated(req("http://127.0.0.1:3000/api/chat"), env)).toBe(true);
    expect(isAuthenticated(req("http://[::1]:3000/api/chat"), env)).toBe(true);
    expect(isAuthenticated(req("http://192.168.1.20:3000/api/chat"), env)).toBe(false);
    expect(isAuthenticated(req("http://easymode.example/api/chat"), env)).toBe(false);
  });
});

describe("cookies", () => {
  it("parses a cookie header", () => {
    expect(parseCookies("a=1; b=x%20y; bad; =nope")).toEqual({ a: "1", b: "x y" });
    expect(parseCookies(null)).toEqual({});
  });
  it("serializes a hardened session cookie", () => {
    const c = sessionCookie(req("https://app.example/api/auth"), "v");
    expect(c).toContain(`${SESSION_COOKIE}=v`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Secure");
    expect(c).toContain("Path=/");
    expect(sessionCookie(req("http://localhost:3000/api/auth"), "v")).not.toContain("Secure");
    expect(sessionCookie(req("http://localhost:3000/api/auth"), "", 0)).toContain("Max-Age=0");
  });
  it("derives a session value that does not contain the token", () => {
    expect(sessionValue(TOKEN)).not.toContain(TOKEN);
    expect(sessionValue(TOKEN)).toBe(sessionValue(TOKEN));
    expect(sessionValue(TOKEN)).not.toBe(sessionValue(TOKEN + "x"));
  });
});
