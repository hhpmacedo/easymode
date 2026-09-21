# EasyMode

[![CI](https://github.com/hhpmacedo/easymode/actions/workflows/ci.yml/badge.svg)](https://github.com/hhpmacedo/easymode/actions/workflows/ci.yml)

An AI chat app that maximizes quality/price automatically: it rewrites your
message into an excellent prompt, routes it to the cheapest Anthropic model
that will do the job well, and shows its work — the rewritten prompt, the
routing reasoning, and estimated savings vs always using Opus.

## Run

    cp .env.example .env.local   # add your ANTHROPIC_API_KEY (+ EASYMODE_ACCESS_TOKEN)
    npm install
    npm run dev                  # http://localhost:3000

## How it works

Each turn: one Haiku call classifies the task, rewrites the prompt, and picks a
model (Haiku 4.5 / Sonnet 5 / Opus 4.8 / rarely Fable 5). A deterministic
guardrail bounds the choice. The chosen model streams the answer using the
optimized prompt. Savings = always-Opus counterfactual (same output length)
minus what we actually spent, router cost included.

Every answer request is assembled in a fixed, stable-first order with two
Anthropic prompt-cache breakpoints (end of the instruction layer; the latest
user turn), and a thread never drops model tiers mid-conversation — the cache
is per model. Cached input is priced at 10% (reads) / 125% (writes) in the
cost estimate; the "how?" panel shows how much of each turn came from cache.

## Scripts

    npm test          # unit tests (guardrail, cost math, storage, history)
    npm run eval      # routing eval fixture vs live classifier (needs API key)
    npm run eval:cache  # prompt-cache tripwire: turn two must read from cache (needs API key)
    npx playwright test  # e2e smoke (needs API key)

## Development

    npm run lint          # eslint (next/core-web-vitals + typescript)
    npm run format        # prettier
    npm run typecheck     # tsc --noEmit
    npm run e2e           # playwright smoke (needs API key)

- A husky pre-commit hook runs eslint + prettier on staged files.
- CI (GitHub Actions) runs lint/typecheck/test/build on every PR; the live
  routing eval and e2e smoke run on pushes to `main` and manual dispatch,
  and skip gracefully when the `ANTHROPIC_API_KEY` secret is absent.
- Model IDs and prices live only in `lib/pricing.ts` — change them there.
- Dependabot updates npm deps weekly (minor/patch grouped) and Actions monthly.

## Who pays: bring your own key (BYOK) or a shared key

`/api/chat` picks whose Anthropic account to bill, per request, in this order:

1. **The user's own key.** If the browser sends one (set it under **API key** in
   the header), that request is billed to their account and **bypasses the
   shared access token** — it can't touch your credit, so there is nothing to
   gate. The key is validated against Anthropic once (`POST /api/validate-key`),
   then kept in the browser's `localStorage` only and sent per request as the
   `x-anthropic-key` header. It is never written to our storage or logs.
   _Trade-off:_ a key in `localStorage` is exposed to any XSS on the page —
   acceptable for a personal/BYOK tool; don't paste a high-value org key.
2. **The server key** (`ANTHROPIC_API_KEY`), behind the access token below.
3. **Neither** → the API returns 400 asking the user to connect a key.

**Deployment modes fall out of this:**

- **BYOK-only (safe public demo):** set neither `ANTHROPIC_API_KEY` nor
  `EASYMODE_ACCESS_TOKEN`. Every visitor connects their own key; you pay nothing
  and there is no shared secret to leak.
- **Shared key:** set `ANTHROPIC_API_KEY` **and** `EASYMODE_ACCESS_TOKEN` (see
  below). Visitors who don't bring a key use yours, gated by the token.
- **Both:** set both, and BYOK still overrides per user.

## Access control (protecting your shared key)

When the request falls through to the server's `ANTHROPIC_API_KEY`, it is gated
by a second secret, `EASYMODE_ACCESS_TOKEN`:

- **Production:** required. If it is unset the API refuses every request (503)
  instead of running as an open proxy. Generate one with
  `openssl rand -base64 32` and set it in your host's environment.
- **Development:** optional. When unset, requests are allowed only when the app
  is addressed as `localhost` / `127.0.0.1`; any other host is denied.
- **Browser:** the UI asks for the token once and stores an HttpOnly,
  SameSite=Strict session cookie (30 days). `DELETE /api/auth` logs out.
- **Scripts:** send `Authorization: Bearer <token>` instead.
- **Brakes:** per-IP rate limits (30 chat calls / 10 min, 10 sign-in attempts /
  15 min), a 200 KB body cap, and a 200-message cap. The limiter is in-memory
  and keys on `x-forwarded-for`, so it only bites when a trusted reverse proxy
  sets that header. The token is the real boundary; the limiter caps damage.

Rotate the token by changing the env var and redeploying: existing sessions
stop working immediately. Never commit `.env.local` (it is gitignored). The
server-side `ANTHROPIC_API_KEY` stays server-side; a user's own key stays in
their browser and is only ever forwarded transiently. `lib/auth.ts`,
`lib/provider.ts`, and `lib/router.ts` are server-only — never import them from
`components/` or `app/page.tsx`.

Spec: `docs/superpowers/specs/2026-09-17-easymode-design.md` ·
Plan: `docs/superpowers/plans/2026-09-17-easymode-v1.md` · License: MIT
