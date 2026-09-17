# EasyMode

An AI chat app that maximizes quality/price automatically: it rewrites your
message into an excellent prompt, routes it to the cheapest Anthropic model
that will do the job well, and shows its work — the rewritten prompt, the
routing reasoning, and estimated savings vs always using Opus.

## Run

    cp .env.example .env.local   # add your ANTHROPIC_API_KEY
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

Spec: docs/superpowers/specs/2026-09-17-easymode-design.md
