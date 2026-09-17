import { messageText } from "./types";
import type { EasyUIMessage } from "./types";

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

const INDEX_KEY = "easymode:index";
const msgKey = (id: string) => `easymode:conv:${id}`;
const TITLE_MAX = 35;

export class ConversationStore {
  constructor(private storage: Storage) {}

  private readIndex(): ConversationMeta[] {
    try {
      const raw = this.storage.getItem(INDEX_KEY);
      return raw ? (JSON.parse(raw) as ConversationMeta[]) : [];
    } catch {
      return [];
    }
  }

  private writeIndex(index: ConversationMeta[]): void {
    this.storage.setItem(INDEX_KEY, JSON.stringify(index));
  }

  list(): ConversationMeta[] {
    return this.readIndex().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  create(): ConversationMeta {
    const now = Date.now();
    const meta: ConversationMeta = {
      id: crypto.randomUUID(),
      title: "New chat",
      createdAt: now,
      updatedAt: now,
    };
    this.writeIndex([meta, ...this.readIndex()]);
    return meta;
  }

  getMessages(id: string): EasyUIMessage[] {
    try {
      const raw = this.storage.getItem(msgKey(id));
      return raw ? (JSON.parse(raw) as EasyUIMessage[]) : [];
    } catch {
      return [];
    }
  }

  saveMessages(id: string, messages: EasyUIMessage[]): void {
    const json = JSON.stringify(messages);
    // No-op when nothing changed (e.g. re-mount on conversation switch) so
    // updatedAt — and thus sidebar order — only moves on real updates.
    if (this.storage.getItem(msgKey(id)) === json) return;
    this.storage.setItem(msgKey(id), json);
    const index = this.readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return;
    meta.updatedAt = Date.now();
    if (meta.title === "New chat") {
      const first = messages.find((m) => m.role === "user");
      if (first) {
        const text = messageText(first);
        meta.title = text.length > TITLE_MAX ? text.slice(0, TITLE_MAX) + "…" : text;
      }
    }
    this.writeIndex(index);
  }

  rename(id: string, title: string): void {
    const index = this.readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return;
    meta.title = title;
    this.writeIndex(index);
  }

  remove(id: string): void {
    this.storage.removeItem(msgKey(id));
    this.writeIndex(this.readIndex().filter((c) => c.id !== id));
  }
}

/** Browser singleton (client components only). */
export function browserStore(): ConversationStore {
  return new ConversationStore(window.localStorage);
}
