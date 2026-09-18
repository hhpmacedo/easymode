import { describe, it, expect, afterEach, vi } from "vitest";
import {
  SESSION_COOKIE,
  authMode,
  isAuthenticated,
  parseCookies,
  safeEqual,
  sessionCookie,
  sessionValue,
  verifyToken,
  extractUserKey,
  resolveChatAuth,
  doorState,
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

describe("extractUserKey", () => {
  const GOODKEY = "sk-ant-api03-" + "a".repeat(40);
  it("returns a well-formed key from the header", () => {
    expect(extractUserKey(req("https://x/", { "x-anthropic-key": GOODKEY }))).toBe(GOODKEY);
  });
  it("ignores junk and a missing header", () => {
    expect(extractUserKey(req("https://x/", { "x-anthropic-key": "nope" }))).toBeUndefined();
    expect(extractUserKey(req("https://x/"))).toBeUndefined();
  });
});

describe("resolveChatAuth", () => {
  const GOODKEY = "sk-ant-api03-" + "a".repeat(40);
  const ipReq = (ip: string, headers: Record<string, string> = {}) =>
    req("https://x/", { "x-forwarded-for": ip, ...headers });
  afterEach(() => vi.unstubAllEnvs());

  it("bills a user key and bypasses the token gate even when closed", () => {
    vi.stubEnv("EASYMODE_ACCESS_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    const r = resolveChatAuth(ipReq("10.9.0.1", { "x-anthropic-key": GOODKEY }));
    expect(r.denied).toBeNull();
    expect(r.apiKey).toBe(GOODKEY);
  });

  it("uses the server key behind the token gate when no user key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-server-xxxxxxxxxxxxxxxxxxxxxx");
    vi.stubEnv("EASYMODE_ACCESS_TOKEN", TOKEN);
    expect(resolveChatAuth(ipReq("10.9.0.2")).denied?.status).toBe(401);
    const ok = resolveChatAuth(ipReq("10.9.0.3", { authorization: `Bearer ${TOKEN}` }));
    expect(ok.denied).toBeNull();
    expect(ok.apiKey).toBeUndefined();
  });

  it("asks to connect a key when neither user nor server key exists", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("EASYMODE_ACCESS_TOKEN", TOKEN);
    expect(resolveChatAuth(ipReq("10.9.0.4")).denied?.status).toBe(400);
  });
});

describe("doorState", () => {
  const at = (headers: Record<string, string> = {}) => req("https://app.example.com/", headers);
  it("is open when there is no server key (BYOK), regardless of token/host", () => {
    expect(doorState(at(), { hasServerKey: false, nodeEnv: "production", token: TOKEN })).toBe(
      "open",
    );
    expect(doorState(at(), { hasServerKey: false, nodeEnv: "production" })).toBe("open");
  });
  it("locks when a server key exists in token mode without credentials", () => {
    expect(doorState(at(), { hasServerKey: true, token: TOKEN, nodeEnv: "production" })).toBe(
      "locked",
    );
  });
  it("opens in token mode with a valid bearer", () => {
    expect(
      doorState(at({ authorization: `Bearer ${TOKEN}` }), {
        hasServerKey: true,
        token: TOKEN,
        nodeEnv: "production",
      }),
    ).toBe("open");
  });
  it("is closed when a server key exists in production with no token", () => {
    expect(doorState(at(), { hasServerKey: true, nodeEnv: "production" })).toBe("closed");
  });
  it("opens for loopback in dev with a server key and no token", () => {
    expect(
      doorState(req("http://localhost/"), { hasServerKey: true, nodeEnv: "development" }),
    ).toBe("open");
    expect(doorState(at(), { hasServerKey: true, nodeEnv: "development" })).toBe("locked");
  });
});
