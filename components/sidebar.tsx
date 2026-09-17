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
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="p-3">
        <button onClick={onNew} className="w-full rounded-lg bg-blue-600 py-2 text-sm font-medium hover:bg-blue-500">
          + New chat
        </button>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center rounded-lg px-2 py-1.5 text-sm ${
              c.id === activeId ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/50"
            }`}
          >
            <button onClick={() => onSelect(c.id)} className="flex-1 truncate text-left" title={c.title}>
              {c.title}
            </button>
            <button
              onClick={() => {
                const t = prompt("Rename conversation", c.title);
                if (t) onRename(c.id, t);
              }}
              className="hidden px-1 text-xs text-zinc-500 hover:text-zinc-200 group-hover:block"
              aria-label="Rename"
            >
              ✎
            </button>
            <button
              onClick={() => confirm("Delete this conversation?") && onDelete(c.id)}
              className="hidden px-1 text-xs text-zinc-500 hover:text-red-400 group-hover:block"
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
