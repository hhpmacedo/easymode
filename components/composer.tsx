"use client";
import { useState } from "react";

export function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  };
  return (
    <div className="border-t border-zinc-800 p-4">
      <div className="flex items-end gap-2 rounded-xl border border-zinc-700 bg-zinc-900 p-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          rows={Math.min(6, text.split("\n").length)}
          placeholder="Ask anything — we'll handle the prompting."
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1 outline-none placeholder:text-zinc-600"
        />
        <button
          onClick={submit}
          disabled={disabled || !text.trim()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
