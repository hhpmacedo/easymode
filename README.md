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

## Scripts

    npm test          # unit tests (guardrail, cost math, storage, history)
    npm run eval      # routing eval fixture vs live classifier (needs API key)
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

## Access control (protecting your API key)

`/api/chat` is a proxy to the Anthropic API billed to your `ANTHROPIC_API_KEY`,
so it is gated by a second secret, `EASYMODE_ACCESS_TOKEN`:

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
stop working immediately. Never commit `.env.local` (it is gitignored) and keep
the Anthropic key server-side only; nothing under `components/` or `app/page.tsx`
may import `lib/auth.ts`, `lib/router.ts`, or `@ai-sdk/anthropic`.

Spec: `docs/superpowers/specs/2026-09-17-easymode-design.md` ·
Plan: `docs/superpowers/plans/2026-09-17-easymode-v1.md` · License: MIT
