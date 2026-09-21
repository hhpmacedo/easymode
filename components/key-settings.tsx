"use client";
import { useState, type FormEvent } from "react";
import { clearUserKey, getUserKey, maskKey, setUserKey } from "@/lib/client-key";
import { isAnthropicKeyFormat } from "@/lib/provider";

type Status = "idle" | "validating" | "error";

/** Connect / disconnect your own Anthropic key (the "API key" tab in Settings).
 *  The key stays in this browser (localStorage); we validate it against
 *  Anthropic before saving, then send it per request so it bills your account. */
export function KeyPanel() {
  // The modal only ever mounts on a client click, so reading localStorage in
  // the lazy initializer is safe — no SSR/hydration path reaches this.
  const [saved, setSaved] = useState<string | null>(() => getUserKey());
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    const key = draft.trim();
    if (!isAnthropicKeyFormat(key)) {
      setError("That does not look like an Anthropic API key (starts with sk-ant-).");
      setStatus("error");
      return;
    }
    setStatus("validating");
    setError(null);
    try {
      const r = await fetch("/api/validate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (r.status === 204) {
        setUserKey(key);
        setSaved(key);
        setDraft("");
        setStatus("idle");
      } else {
        const body = await r.json().catch(() => ({}));
        setError(body.error ?? `Validation failed (${r.status}).`);
        setStatus("error");
      }
    } catch {
      setError("Network error. Try again.");
      setStatus("error");
    }
  };

  const disconnect = () => {
    clearUserKey();
    setSaved(null);
    setDraft("");
    setStatus("idle");
    setError(null);
  };

  return saved ? (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-pine/20 bg-pine-soft px-3 py-2.5 text-sm text-pine-deep">
        <span className="text-pine">●</span>
        <span>
          Connected · <span className="tabular">{maskKey(saved)}</span>
        </span>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Requests bill your account. The key is stored in this browser only and sent per request —
        never saved on our servers.
      </p>
      <button
        onClick={disconnect}
        className="w-full rounded-xl border border-line py-2.5 text-sm font-medium text-ink transition-colors hover:bg-paper"
      >
        Disconnect
      </button>
    </div>
  ) : (
    <form onSubmit={connect} className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Paste a personal API key to bill usage to your own Anthropic account. It stays in this
        browser — we never store it. Get one at{" "}
        <a
          href="https://platform.claude.com/settings/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="text-pine underline"
        >
          platform.claude.com
        </a>
        .
      </p>
      <input
        type="password"
        autoComplete="off"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="sk-ant-…"
        aria-label="Anthropic API key"
        className="tabular w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm outline-none focus:border-line-strong"
      />
      {error && <p className="text-[13px] text-rust">{error}</p>}
      <button
        type="submit"
        disabled={status === "validating" || !draft.trim()}
        className="w-full rounded-xl bg-ink py-2.5 text-sm font-medium text-paper transition-colors hover:bg-ink-soft disabled:opacity-40"
      >
        {status === "validating" ? "Validating…" : "Connect"}
      </button>
    </form>
  );
}
