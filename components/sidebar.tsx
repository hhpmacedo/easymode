"use client";
import type { ConversationMeta } from "@/lib/storage";

interface Props {
  conversations: ConversationMeta[];
  activeId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

export function Sidebar({ conversations, activeId, onNew, onSelect, onRename, onDelete }: Props) {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-paper">
      <div className="px-4 pt-5 pb-3">
        <p className="font-serif text-xl italic tracking-tight text-ink">EasyMode</p>
        <p className="mt-0.5 text-[11px] uppercase tracking-[0.14em] text-muted">
          quality / price, maximized
        </p>
      </div>
      <div className="px-3 pb-2">
        <button
          onClick={onNew}
          className="w-full rounded-xl bg-ink py-2.5 text-sm font-medium text-paper transition-colors hover:bg-ink-soft"
        >
          New chat
        </button>
      </div>
      <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-[0.14em] text-muted">
        Conversations
      </p>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center rounded-lg border px-2.5 py-2 text-sm transition-colors ${
              c.id === activeId
                ? "border-line bg-surface text-ink shadow-[0_1px_2px_rgba(29,26,21,0.04)]"
                : "border-transparent text-ink-soft hover:bg-surface/70"
            }`}
          >
            <button
              onClick={() => onSelect(c.id)}
              className="flex-1 truncate text-left"
              title={c.title}
            >
              {c.title}
            </button>
            <button
              onClick={() => {
                const t = prompt("Rename conversation", c.title);
                if (t) onRename(c.id, t);
              }}
              className="hidden px-1 text-xs text-muted hover:text-ink group-hover:block"
              aria-label="Rename"
            >
              ✎
            </button>
            <button
              onClick={() => confirm("Delete this conversation?") && onDelete(c.id)}
              className="hidden px-1 text-xs text-muted hover:text-rust group-hover:block"
              aria-label="Delete"
            >
              ×
            </button>
          </div>
        ))}
      </nav>
    </aside>
  );
}
