/** Memory persistence (spec §5.1, §8): one localStorage key holding the
 *  memories and a per-month extraction cost ledger. Injectable Storage and
 *  clock so it is unit-testable; the browser singleton fires
 *  MEMORY_CHANGE_EVENT on every write so open views re-read. */
import { normalizeMemoryText } from "./memory";
import type { Memory, MemoryKind } from "./types";

export const MEMORY_KEY = "easymode:memory";
export const MEMORY_CHANGE_EVENT = "easymode:memory-change";

interface Persisted {
  memories: Memory[];
  /** USD spent on extraction, keyed "YYYY-MM". */
  costs: Record<string, number>;
}

function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export class MemoryStore {
  constructor(
    private storage: Storage,
    private now: () => number = Date.now,
    private onChange: () => void = () => {},
  ) {}

  private read(): Persisted {
    try {
      const raw = this.storage.getItem(MEMORY_KEY);
      if (!raw) return { memories: [], costs: {} };
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      return {
        memories: Array.isArray(parsed.memories) ? parsed.memories : [],
        costs: parsed.costs && typeof parsed.costs === "object" ? parsed.costs : {},
      };
    } catch {
      return { memories: [], costs: {} };
    }
  }

  private write(p: Persisted): void {
    this.storage.setItem(MEMORY_KEY, JSON.stringify(p));
    this.onChange();
  }

  list(): Memory[] {
    return this.read().memories;
  }

  active(): Memory[] {
    return this.list().filter((m) => m.status === "active");
  }

  add(text: string, kind: MemoryKind, source: Memory["source"], conversationId?: string): Memory {
    const p = this.read();
    const now = this.now();
    const memory: Memory = {
      id: crypto.randomUUID(),
      text: normalizeMemoryText(text),
      kind,
      source,
      conversationId,
      createdAt: now,
      updatedAt: now,
      status: "active",
    };
    p.memories.push(memory);
    this.write(p);
    return memory;
  }

  update(id: string, text: string): void {
    this.patch(id, { text: normalizeMemoryText(text) });
  }

  archive(id: string): void {
    this.patch(id, { status: "archived" });
  }

  restore(id: string): void {
    this.patch(id, { status: "active" });
  }

  private patch(id: string, changes: Partial<Memory>): void {
    const p = this.read();
    const m = p.memories.find((x) => x.id === id);
    if (!m) return;
    Object.assign(m, changes, { updatedAt: this.now() });
    this.write(p);
  }

  /** Persist a merged set (after extraction). Keeps the cost ledger. */
  replaceAll(memories: Memory[]): void {
    const p = this.read();
    this.write({ ...p, memories });
  }

  clearAll(): void {
    const p = this.read();
    this.write({ ...p, memories: [] });
  }

  recordCost(usd: number): void {
    const p = this.read();
    const k = monthKey(this.now());
    p.costs[k] = (p.costs[k] ?? 0) + usd;
    this.write(p);
  }

  monthCost(month: string = monthKey(this.now())): number {
    return this.read().costs[month] ?? 0;
  }
}

/** Browser singleton (client components only). */
export function browserMemoryStore(): MemoryStore {
  return new MemoryStore(window.localStorage, Date.now, () =>
    window.dispatchEvent(new Event(MEMORY_CHANGE_EVENT)),
  );
}
