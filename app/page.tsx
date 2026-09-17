"use client";
import { useCallback, useEffect, useState } from "react";
import { ChatView } from "@/components/chat-view";
import { Sidebar } from "@/components/sidebar";
import { browserStore } from "@/lib/storage";
import type { ConversationMeta, ConversationStore } from "@/lib/storage";

export default function Home() {
  const [store, setStore] = useState<ConversationStore | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // localStorage only exists client-side.
  useEffect(() => {
    const s = browserStore();
    setStore(s);
    const list = s.list();
    setConversations(list);
    setActiveId(list[0]?.id ?? s.create().id);
    if (!list.length) setConversations(s.list());
  }, []);

  const refresh = useCallback(() => store && setConversations(store.list()), [store]);

  if (!store || !activeId) return null;

  return (
    <main className="flex h-screen">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onNew={() => { const c = store.create(); refresh(); setActiveId(c.id); }}
        onSelect={setActiveId}
        onRename={(id, t) => { store.rename(id, t); refresh(); }}
        onDelete={(id) => {
          store.remove(id);
          const rest = store.list();
          setConversations(rest);
          setActiveId(rest[0]?.id ?? store.create().id);
          refresh();
        }}
      />
      {/* key= remounts useChat state per conversation */}
      <ChatView
        key={activeId}
        conversationId={activeId}
        initialMessages={store.getMessages(activeId)}
        store={store}
        onMessagesChanged={refresh}
      />
    </main>
  );
}
