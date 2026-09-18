import { describe, it, expect } from "vitest";
import {
  chooseCompactionBoundary,
  compactionSummarySchema,
  COMPACTION_ACK,
  estimateTokens,
  lastInputTokens,
  nextContextTokens,
  parseCompactionContext,
  renderCompaction,
  transcriptText,
} from "../compaction";
import type { CompactionSummary, EasyUIMessage } from "../types";

function user(id: string, text: string): EasyUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as EasyUIMessage;
}
function assistant(id: string, text: string, inputTokens?: number): EasyUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: inputTokens ? { usage: { inputTokens, outputTokens: 1 } } : undefined,
  } as EasyUIMessage;
}
/** A turn pair whose assistant text is ~`tokens` tokens (chars/4). */
function turn(n: number, tokens: number): EasyUIMessage[] {
  return [user(`u${n}`, `question ${n}`), assistant(`a${n}`, "x".repeat(tokens * 4))];
}

const summary: CompactionSummary = {
  goal: "Ship the caching layer",
  decisions: ["ratchet tiers", "two breakpoints"],
  facts: ["Sonnet 5 is $2/$10"],
  artifacts: [],
  open: ["memory extraction"],
};

describe("estimateTokens", () => {
  it("is chars/4, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("chooseCompactionBoundary", () => {
  it("returns null when the whole thread fits in the verbatim tail", () => {
    const msgs = [...turn(1, 1000), ...turn(2, 1000)];
    expect(chooseCompactionBoundary(msgs, undefined, 8000)).toBeNull();
  });
  it("picks the latest assistant turn that leaves at least the tail verbatim", () => {
    // tail budget 5K: a4 (3K) + a3 (3K) = 6K ≥ 5K, so the boundary is a2.
    const msgs = [...turn(1, 3000), ...turn(2, 3000), ...turn(3, 3000), ...turn(4, 3000)];
    const c = chooseCompactionBoundary(msgs, undefined, 5000);
    expect(c?.throughMessageId).toBe("a2");
    expect(c?.toCompact.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });
  it("only compacts turns after a previous boundary", () => {
    const msgs = [
      ...turn(1, 3000),
      ...turn(2, 3000),
      ...turn(3, 3000),
      ...turn(4, 3000),
      ...turn(5, 3000),
    ];
    const c = chooseCompactionBoundary(msgs, "a2", 5000);
    expect(c?.throughMessageId).toBe("a3");
    expect(c?.toCompact.map((m) => m.id)).toEqual(["u3", "a3"]);
  });
  it("returns null when nothing new lies before the tail", () => {
    const msgs = [...turn(1, 3000), ...turn(2, 3000), ...turn(3, 3000)];
    expect(chooseCompactionBoundary(msgs, "a2", 5000)).toBeNull();
  });
  it("never cuts inside a turn: the boundary is always an assistant message", () => {
    const msgs = [...turn(1, 3000), ...turn(2, 3000), user("u3", "x".repeat(20_000))];
    const c = chooseCompactionBoundary(msgs, undefined, 5000);
    expect(c?.throughMessageId).toBe("a2");
  });
});

describe("renderCompaction", () => {
  it("is deterministic and tagged, with one line per item", () => {
    const a = renderCompaction(summary);
    expect(a).toBe(renderCompaction({ ...summary }));
    expect(a.startsWith("<compaction_summary>")).toBe(true);
    expect(a.endsWith("</compaction_summary>")).toBe(true);
    expect(a).toContain("Goal: Ship the caching layer");
    expect(a).toContain("- ratchet tiers\n- two breakpoints");
    expect(a).toContain("Artifacts: none");
  });
  it("has a fixed assistant acknowledgement", () => {
    expect(COMPACTION_ACK.length).toBeGreaterThan(10);
  });
});

describe("transcriptText", () => {
  it("renders raw turns as USER/ASSISTANT lines", () => {
    expect(transcriptText([user("1", "hi"), assistant("2", "hello")])).toBe(
      "USER: hi\n\nASSISTANT: hello",
    );
  });
});

describe("lastInputTokens", () => {
  it("reads the latest assistant turn's context size, else 0", () => {
    expect(lastInputTokens([])).toBe(0);
    expect(lastInputTokens([user("1", "a"), assistant("2", "b", 41_000), user("3", "c")])).toBe(
      41_000,
    );
  });
});

describe("schemas", () => {
  it("accepts a well-formed summary and rejects a malformed one", () => {
    expect(compactionSummarySchema.safeParse(summary).success).toBe(true);
    expect(compactionSummarySchema.safeParse({ goal: 1 }).success).toBe(false);
  });
  it("parses a compaction context or returns undefined", () => {
    expect(parseCompactionContext({ throughMessageId: "a2", summary })).toEqual({
      throughMessageId: "a2",
      summary,
    });
    expect(parseCompactionContext({ throughMessageId: "", summary })).toBeUndefined();
    expect(parseCompactionContext(null)).toBeUndefined();
    expect(
      parseCompactionContext({ throughMessageId: "a2", summary: { goal: "x" } }),
    ).toBeUndefined();
  });
});

describe("nextContextTokens", () => {
  it("reports the measured size when there is no compaction", () => {
    expect(nextContextTokens([user("1", "a"), assistant("2", "b", 41_000)])).toBe(41_000);
  });
  it("estimates summary + tail right after a compaction, before any new answer", () => {
    const msgs = [
      user("1", "a"),
      assistant("2", "x".repeat(4000), 41_000),
      user("3", "y".repeat(400)),
    ];
    const n = nextContextTokens(msgs, { throughMessageId: "2", summary });
    expect(n).toBe(estimateTokens(renderCompaction(summary)) + 100);
  });
  it("returns to the measured size once a turn has been answered on the compacted thread", () => {
    const msgs = [
      user("1", "a"),
      assistant("2", "b", 41_000),
      user("3", "c"),
      assistant("4", "d", 3_500),
    ];
    expect(nextContextTokens(msgs, { throughMessageId: "2", summary })).toBe(3_500);
  });
  it("falls back to the measured size when the boundary id is gone", () => {
    expect(
      nextContextTokens([user("1", "a"), assistant("2", "b", 41_000)], {
        throughMessageId: "zz",
        summary,
      }),
    ).toBe(41_000);
  });
});

describe("summary caps", () => {
  it("rejects oversized fields so the cached prefix stays bounded", () => {
    expect(compactionSummarySchema.safeParse({ ...summary, goal: "g".repeat(2_001) }).success).toBe(
      false,
    );
    expect(
      compactionSummarySchema.safeParse({ ...summary, facts: Array(61).fill("f") }).success,
    ).toBe(false);
  });
});
