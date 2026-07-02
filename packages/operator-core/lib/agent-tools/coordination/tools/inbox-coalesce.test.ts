/**
 * coord:inbox — EI-6144 ambient/broadcast coalescing (read-time ×N fold).
 * Pure fold (coalesceRepeatedBroadcasts) + handler-level pins with mocked deps
 * (same seam layout as coord-inbox-cache.test.ts; cachedRead pass-through).
 * Pins:
 *   • identical (from, kind, category, summary) broadcasts to '*' collapse to
 *     ONE row — the NEWEST — annotated repeat_count + first_seen_ts;
 *   • direct messages and uncategorized broadcasts NEVER coalesce (a peer
 *     legitimately repeating itself is not a firehose);
 *   • no duplicates ⇒ the input array is returned as-is (no churn);
 *   • handler: the fold runs BEFORE the `limit` slice, so repetition no longer
 *     crowds distinct signal out of the window; summary.coalesced_dupes counts
 *     the folded rows;
 *   • composition with WI-1444: a coalesced stale alarm still gets the
 *     resolved:true annotation (fold first, annotate the representative).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/inbox-coalesce.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  readInbox: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../identity", () => ({
  resolveAgentIdentity: (ctx: { ownerId?: string }) => ({
    ownerId: ctx?.ownerId ?? "owner-a",
  }),
}));
vi.mock("../actor-identity", () => ({
  resolveActorIdentity: async (ctx: { ownerId?: string }) => ({
    ownerId: ctx?.ownerId ?? "owner-a",
  }),
  actorMailboxKeys: () => [] as string[],
}));
vi.mock("../messages", () => ({
  readInbox: M.readInbox,
  drainAndDeliverUserMailbox: vi.fn(async () => {}),
}));
vi.mock("../presence", () => ({
  heartbeatPresence: vi.fn(async () => {}),
  getPresence: vi.fn(async () => null),
}));
vi.mock("../watermarks", () => ({
  readWatermark: vi.fn(async () => ({ messages_shown_ts: "" })),
  writeWatermark: vi.fn(async () => {}),
}));
vi.mock("@papercusp/coordination/core", () => ({
  emptyWatermark: () => ({ messages_shown_ts: "" }),
}));
vi.mock("../presence-snapshot", () => ({
  resolvePresenceScope: async () => ({}),
  assemblePresenceSnapshot: async () => ({}),
  renderPresenceRebootstrapBlock: () => "",
  consumePresenceRebootstrap: async () => null,
}));
vi.mock("../../../coord-schema", () => ({ renderInjection: () => "" }));
vi.mock("../../../cache", () => ({
  cachedRead: async (
    _ctx: unknown,
    _key: unknown,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

import tool, { coalesceRepeatedBroadcasts } from "./inbox";

const ctx = (ownerId = "owner-a"): never =>
  ({ ownerId, workspaceId: "ws", metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;

type InboxOut = {
  entries: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
};
const callInbox = async (args: Record<string, unknown> = {}): Promise<InboxOut> => {
  const res = (await tool.handler(args as never, ctx())) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as InboxOut;
};

/** ts helper: minute `m` on a fixed day, zero-padded. */
const at = (m: number) =>
  `2026-07-01T10:${String(m).padStart(2, "0")}:00.000Z`;

const broadcast = (
  m: number,
  summary: string,
  over: Record<string, unknown> = {},
) => ({
  ts: at(m),
  msg_id: `m-${m}`,
  from: "system-watchdog",
  to: ["*"],
  kind: "message",
  category: "doc-drift",
  summary,
  ...over,
});
const direct = (m: number, summary: string) => ({
  ts: at(m),
  msg_id: `d-${m}`,
  from: "peer",
  to: ["owner-a"],
  kind: "message",
  category: "doc-drift",
  summary,
});

beforeEach(() => {
  vi.clearAllMocks();
  M.readInbox.mockImplementation(async () => []);
});

describe("coalesceRepeatedBroadcasts (pure)", () => {
  it("collapses identical categorized broadcasts to the newest row with repeat_count + first_seen_ts", () => {
    const rows = [
      broadcast(1, "docs drifted"),
      broadcast(2, "something else"),
      broadcast(3, "docs drifted"),
      broadcast(5, "docs drifted"),
    ];
    const out = coalesceRepeatedBroadcasts(rows);
    expect(out.map((e) => e.msg_id)).toEqual(["m-2", "m-5"]);
    expect(out[1]).toMatchObject({
      repeat_count: 3,
      first_seen_ts: at(1),
      ts: at(5),
    });
    // the singleton is untouched (no repeat_count noise)
    expect(out[0]!.repeat_count).toBeUndefined();
  });

  it("direct messages never coalesce, even when verbatim-identical", () => {
    const rows = [direct(1, "same"), direct(2, "same"), direct(3, "same")];
    expect(coalesceRepeatedBroadcasts(rows)).toHaveLength(3);
  });

  it("uncategorized broadcasts never coalesce", () => {
    const rows = [
      broadcast(1, "same", { category: undefined }),
      broadcast(2, "same", { category: undefined }),
    ];
    expect(coalesceRepeatedBroadcasts(rows)).toHaveLength(2);
  });

  it("different senders / categories / kinds stay distinct", () => {
    const rows = [
      broadcast(1, "same"),
      broadcast(2, "same", { from: "other-sender" }),
      broadcast(3, "same", { category: "severe-event" }),
      broadcast(4, "same", { kind: "notify" }),
    ];
    expect(coalesceRepeatedBroadcasts(rows)).toHaveLength(4);
  });

  it("no duplicates ⇒ the input array is returned as-is (no churn)", () => {
    const rows = [broadcast(1, "a"), broadcast(2, "b")];
    expect(coalesceRepeatedBroadcasts(rows)).toBe(rows);
  });
});

describe("coord:inbox handler (fold before the limit window)", () => {
  it("repetition no longer crowds distinct signal out of a small window", async () => {
    const rows: Array<Record<string, unknown>> = [];
    // 3 distinct old messages, then 30 identical watchdog repeats on top.
    rows.push(direct(1, "distinct one"));
    rows.push(direct(2, "distinct two"));
    rows.push(direct(3, "distinct three"));
    for (let m = 10; m < 40; m++) rows.push(broadcast(m, "git-sync STALLED on x"));
    M.readInbox.mockImplementation(async () => rows);

    const out = await callInbox({ limit: 5 });
    // 33 raw rows → 4 coalesced (3 distinct + 1 ×30 representative); all fit.
    expect(out.summary).toMatchObject({
      total: 33,
      coalesced_dupes: 29,
      returned: 4,
      truncated: 0,
    });
    const rep = out.entries.find((e) => e.repeat_count !== undefined)!;
    expect(rep).toMatchObject({
      msg_id: "m-39",
      repeat_count: 30,
      first_seen_ts: at(10),
    });
    expect(out.entries.map((e) => e.summary)).toContain("distinct one");
  });

  it("composes with WI-1444: a coalesced stale alarm carries resolved:true", async () => {
    const rows: Array<Record<string, unknown>> = [
      broadcast(1, "git-sync STALLED on x", {
        category: "severe-event",
        condition_key: "git-sync-stall:x",
      }),
      broadcast(2, "git-sync STALLED on x", {
        category: "severe-event",
        condition_key: "git-sync-stall:x",
      }),
      broadcast(9, "git-sync RECOVERED on x", {
        category: "severe-event-resolved",
        condition_key: "git-sync-stall:x",
        resolves_condition: "git-sync-stall:x",
      }),
    ];
    M.readInbox.mockImplementation(async () => rows);
    const out = await callInbox();
    const rep = out.entries.find((e) => e.repeat_count !== undefined)!;
    expect(rep).toMatchObject({
      msg_id: "m-2",
      repeat_count: 2,
      resolved: true,
      resolved_at: at(9),
    });
  });
});
