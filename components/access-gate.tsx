"use client";
import { useEffect, useState, type FormEvent } from "react";

type State = "checking" | "open" | "locked" | "closed";

/** Blocks the UI until /api/auth confirms a session. The API rejects
 *  unauthenticated calls regardless; this only spares the user a dead chat box. */
export function AccessGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>("checking");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth", { credentials: "same-origin" })
      .then((r) => {
        if (cancelled) return;
        setState(r.status === 204 ? "open" : r.status === 503 ? "closed" : "locked");
      })
      .catch(() => !cancelled && setState("locked"));
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (r.status === 204) {
        setToken("");
        setState("open");
      } else {
        const body = await r.json().catch(() => ({}));
        setError(body.error ?? `Sign-in failed (${r.status}).`);
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (state === "open") return <>{children}</>;
  if (state === "checking") return null;

  return (
    <main className="flex h-screen items-center justify-center bg-paper px-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-[0_2px_12px_rgba(29,26,21,0.05)]"
      >
        <h1 className="text-[13px] font-medium uppercase tracking-[0.14em] text-muted">EasyMode</h1>
        {state === "closed" ? (
          <p className="mt-3 text-sm text-rust">
            This deployment has no <code>EASYMODE_ACCESS_TOKEN</code> configured, so the API is
            disabled. Set it and redeploy.
          </p>
        ) : (
          <>
            <p className="mt-3 text-sm text-ink-soft">
              Enter the access token to use this app. Requests are billed to the owner&apos;s
              Anthropic account.
            </p>
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Access token"
              aria-label="Access token"
              className="mt-4 w-full rounded-xl border border-line bg-paper px-3 py-2 text-[15px] outline-none placeholder:text-muted focus:border-line-strong"
            />
            {error && <p className="mt-2 text-xs text-rust">{error}</p>}
            <button
              type="submit"
              disabled={busy || !token.trim()}
              className="mt-4 w-full rounded-xl bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-colors hover:bg-ink-soft disabled:opacity-30"
            >
              {busy ? "Checking…" : "Unlock"}
            </button>
          </>
        )}
      </form>
    </main>
  );
}
