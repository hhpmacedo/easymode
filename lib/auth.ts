/** Access control for the API routes. SERVER ONLY — never import from client code.
 *
 *  `/api/chat` is a proxy to the Anthropic API paid for by ANTHROPIC_API_KEY, so
 *  every request must prove it comes from the app's owner. The proof is a shared
 *  secret, EASYMODE_ACCESS_TOKEN, presented either as a bearer header (scripts)
 *  or, after `POST /api/auth`, as an HttpOnly session cookie (the browser UI).
 *
 *  Modes, decided by the environment:
 *  - token: EASYMODE_ACCESS_TOKEN is set → every request needs it.
 *  - closed: unset in production → deny everything (fail closed, never open a
 *    public proxy by accident).
 *  - open: unset outside production AND the request targets a loopback host →
 *    allowed, for `npm run dev` convenience. Any other host is denied. */
import { createHash, timingSafeEqual } from "node:crypto";
import { RateLimiter, clientKey } from "./rate-limit";
import { isAnthropicKeyFormat } from "./provider";

/** Header a browser/script uses to bill an Anthropic request to its own key. */
export const USER_KEY_HEADER = "x-anthropic-key";

export const SESSION_COOKIE = "easymode_session";
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days
export const MIN_TOKEN_LENGTH = 16;

export type AuthMode = "token" | "closed" | "open";

/** Front-door verdict for the whole UI (the AccessGate):
 *  - open: render the app (either BYOK, an authenticated session, or dev loopback)
 *  - locked: show the access-token unlock form
 *  - closed: misconfigured (server key set in prod but no token) */
export type DoorState = "open" | "locked" | "closed";

export interface AuthEnv {
  token?: string;
  nodeEnv?: string;
  /** Whether the server has an ANTHROPIC_API_KEY worth protecting. */
  hasServerKey?: boolean;
}

function envFromProcess(): AuthEnv {
  return {
    token: process.env.EASYMODE_ACCESS_TOKEN,
    nodeEnv: process.env.NODE_ENV,
    hasServerKey: hasServerKey(),
  };
}

export function authMode(env: AuthEnv = envFromProcess()): AuthMode {
  if (env.token && env.token.trim()) return "token";
  return env.nodeEnv === "production" ? "closed" : "open";
}

/** Whether the UI should let a visitor in. The access token guards the *server*
 *  key; with no server key there is nothing to protect, so the door is open for
 *  bring-your-own-key use (any host). */
export function doorState(req: Request, env: AuthEnv = envFromProcess()): DoorState {
  if (!env.hasServerKey) return "open";
  const mode = authMode(env);
  if (mode === "closed") return "closed";
  if (mode === "open") return isLoopbackHost(req) ? "open" : "locked";
  return isAuthenticated(req, env) ? "open" : "locked";
}

/** Session cookie value: a digest of the token, so a leaked cookie never shows
 *  the token itself in plain text (it still grants access until rotated). */
export function sessionValue(token: string): string {
  return createHash("sha256").update(`easymode-session:${token}`).digest("hex");
}

/** Constant-time equality over fixed-length digests, so neither length nor
 *  prefix of the secret leaks through timing. */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

export function verifyToken(candidate: unknown, env: AuthEnv = envFromProcess()): boolean {
  if (typeof candidate !== "string" || !candidate) return false;
  if (authMode(env) !== "token") return false;
  return safeEqual(candidate, env.token!.trim());
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[name] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function isLoopbackHost(req: Request): boolean {
  let host = "";
  try {
    host = new URL(req.url).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Does this request carry valid credentials (bearer header or session cookie)? */
export function isAuthenticated(req: Request, env: AuthEnv = envFromProcess()): boolean {
  const mode = authMode(env);
  if (mode === "closed") return false;
  if (mode === "open") return isLoopbackHost(req);
  const token = env.token!.trim();
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ") && safeEqual(auth.slice(7).trim(), token)) return true;
  const cookie = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  return !!cookie && safeEqual(cookie, sessionValue(token));
}

function isSecureRequest(req: Request): boolean {
  if (process.env.NODE_ENV === "production") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Set-Cookie header value for a fresh session (or, with maxAge 0, a logout). */
export function sessionCookie(req: Request, value: string, maxAgeSec = SESSION_MAX_AGE_SEC) {
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSec}`,
  ];
  if (isSecureRequest(req)) attrs.push("Secure");
  return attrs.join("; ");
}

// One limiter per process: chat calls burn API credit, login attempts guess the
// token, key-validation pings could brute-check stolen keys through our proxy.
const chatLimiter = new RateLimiter({ limit: 30, windowMs: 10 * 60_000 });
const loginLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60_000 });
const validateLimiter = new RateLimiter({ limit: 20, windowMs: 15 * 60_000 });
// Background jobs (compaction, memory extraction) get their own,
// tighter limiter so a shared-key operator can bound them independently.
const compactLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60_000 });
const extractLimiter = new RateLimiter({ limit: 20, windowMs: 15 * 60_000 });

const CLOSED_MESSAGE =
  "EASYMODE_ACCESS_TOKEN is not configured, so the API is disabled in production. " +
  "Set it (e.g. `openssl rand -base64 32`) and redeploy.";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers });
}

/** 503 when the deployment has no token configured in production, else null. */
export function guardClosed(): Response | null {
  return authMode() === "closed" ? json(503, { error: CLOSED_MESSAGE }) : null;
}

/** Returns a response to send instead of the handler when access is denied. */
export function guardChat(req: Request, limiter: RateLimiter = chatLimiter): Response | null {
  const closed = guardClosed();
  if (closed) return closed;
  if (!isAuthenticated(req)) return json(401, { error: "Access token required." });
  const verdict = limiter.check(clientKey(req));
  if (!verdict.allowed) {
    return json(
      429,
      { error: "Too many requests. Try again shortly." },
      { "Retry-After": String(verdict.retryAfterSec) },
    );
  }
  return null;
}

export function guardLogin(req: Request): Response | null {
  const closed = guardClosed();
  if (closed) return closed;
  const verdict = loginLimiter.check(clientKey(req));
  if (!verdict.allowed) {
    return json(
      429,
      { error: "Too many attempts. Try again later." },
      { "Retry-After": String(verdict.retryAfterSec) },
    );
  }
  return null;
}

/** Rate-limit the key-validation endpoint. No token gate: BYOK validation must
 *  work on a deployment that has no shared secret configured. */
export function guardValidate(req: Request): Response | null {
  const verdict = validateLimiter.check(clientKey(req));
  if (!verdict.allowed) {
    return json(
      429,
      { error: "Too many attempts. Try again later." },
      { "Retry-After": String(verdict.retryAfterSec) },
    );
  }
  return null;
}

/** The caller's own Anthropic key, if they sent a well-formed one. Junk is
 *  ignored (treated as absent) so the shared-key path can still handle it. */
export function extractUserKey(req: Request): string | undefined {
  const raw = req.headers.get(USER_KEY_HEADER)?.trim();
  return raw && isAnthropicKeyFormat(raw) ? raw : undefined;
}

function hasServerKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

const CONNECT_MESSAGE =
  "No Anthropic key available. Connect your own key in Settings to start chatting.";

export interface ChatAuth {
  /** Send this instead of running the handler; null means proceed. */
  denied: Response | null;
  /** The key to bill this request to; undefined means the server env key. */
  apiKey?: string;
}

function resolveAuth(req: Request, limiter: RateLimiter): ChatAuth {
  const userKey = extractUserKey(req);
  if (userKey) {
    const verdict = limiter.check(clientKey(req));
    if (!verdict.allowed) {
      return {
        denied: json(
          429,
          { error: "Too many requests. Try again shortly." },
          { "Retry-After": String(verdict.retryAfterSec) },
        ),
      };
    }
    return { denied: null, apiKey: userKey };
  }
  if (hasServerKey()) {
    return { denied: guardChat(req, limiter), apiKey: undefined };
  }
  return { denied: json(400, { error: CONNECT_MESSAGE }) };
}

/** Decide who pays for a chat request and whether it may proceed.
 *
 *  Precedence:
 *  1. The caller brought its own key → bill them; bypass the shared-key gate
 *     (they can't spend our credit), but still rate-limit to protect the proxy.
 *  2. No user key, a server key is configured → shared mode: full access-token
 *     gate (guardChat) and bill our env key.
 *  3. Neither → nothing to serve: 400 telling them to connect a key. */
export function resolveChatAuth(req: Request): ChatAuth {
  return resolveAuth(req, chatLimiter);
}

/** Same precedence as chat, on the compaction limiter (spec §7.2). */
export function resolveCompactAuth(req: Request): ChatAuth {
  return resolveAuth(req, compactLimiter);
}

/** Same precedence as chat, on the memory-extraction limiter (spec §5.3). */
export function resolveExtractAuth(req: Request): ChatAuth {
  return resolveAuth(req, extractLimiter);
}
