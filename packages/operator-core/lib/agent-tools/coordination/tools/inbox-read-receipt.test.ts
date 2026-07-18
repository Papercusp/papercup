/**
 * coord:inbox — EI-2042 read-receipt cursor write-through.
 *
 * `coord:inbox` advances the CALLER's `messages_shown_ts` watermark to the
 * newest entry just SHOWN to them (summary.newest_ts), deterministically in
 * tool code at the moment the `[coord+N]` block is assembled — NOT at
 * turn-end (that's `messages_since_ts`, written by coord:watermark-set). A
 * sender then reads a PEER's `messages_shown_ts` (via coord:watermark
 * `{ agent, sent_ts }`) as a read-receipt: `>= sent_ts` means the peer's
 * `[coord+N]` injection already showed it.
 *
 * Pins:
 *   • a read that surfaces entries advances the watermark to summary.newest_ts;
 *   • the monotonic guard: writeWatermark is skipped when newest_ts is not
 *     STRICTLY newer than the already-stored messages_shown_ts (never moves
 *     the read-receipt cursor backward — you can't un-see a message);
 *   • an empty read (no entries, no newest_ts) never calls writeWatermark;
 *   • the write is best-effort — a writeWatermark rejection never breaks the
 *     inbox read itself.
 *
 * Same mocked-deps seam as the sibling inbox-*.test.ts files in this dir.
 *
 * Run: cd packages/operator-core && npx vitest run \
 *   lib/agent-tools/coordination/tools/inbox-read-receipt.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  readInbox: vi.fn(async () => [] as unknown[]),
  readWatermark: vi.fn(async () => ({ messages_shown_ts: "" })),
  writeWatermark: vi.fn(async () => ({})),
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
  readWatermark: M.readWatermark,
  writeWatermark: M.writeWatermark,
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

import tool from "./inbox";

const ctx = (ownerId = "owner-a"): never =>
  ({ ownerId, workspaceId: "ws", metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;

const callInbox = async (
  args: Record<string, unknown> = {},
  owner = "owner-a",
): Promise<Record<string, unknown>> => {
  const res = (await tool.handler(args as never, ctx(owner))) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

const msg = (ts: string, id: string) => ({
  ts,
  msg_id: id,
  from: "peer-b",
  to: ["owner-a"],
  kind: "message",
  summary: `hello ${id}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  M.readInbox.mockImplementation(async () => []);
  M.readWatermark.mockImplementation(async () => ({ messages_shown_ts: "" }));
  M.writeWatermark.mockImplementation(async () => ({}));
});

describe("coord:inbox EI-2042 read-receipt write-through", () => {
  it("advances messages_shown_ts to the newest shown entry's ts", async () => {
    const a = msg("2026-07-18T10:00:00.000Z", "m1");
    const b = msg("2026-07-18T10:05:00.000Z", "m2");
    M.readInbox.mockImplementation(async () => [a, b]);
    const out = await callInbox();
    expect(out.summary).toMatchObject({ newest_ts: b.ts });
    expect(M.writeWatermark).toHaveBeenCalledTimes(1);
    expect(M.writeWatermark).toHaveBeenCalledWith("owner-a", {
      messages_shown_ts: b.ts,
    });
  });

  it("monotonic guard: does NOT move the cursor backward or write when already caught up", async () => {
    const a = msg("2026-07-18T09:00:00.000Z", "m-old");
    M.readInbox.mockImplementation(async () => [a]);
    // Already shown something newer than this read's newest entry.
    M.readWatermark.mockImplementation(async () => ({
      messages_shown_ts: "2026-07-18T09:30:00.000Z",
    }));
    await callInbox();
    expect(M.writeWatermark).not.toHaveBeenCalled();
  });

  it("an empty read (no entries) never calls writeWatermark", async () => {
    M.readInbox.mockImplementation(async () => []);
    const out = await callInbox();
    expect(out.summary).toMatchObject({ newest_ts: null });
    expect(M.writeWatermark).not.toHaveBeenCalled();
  });

  it("is best-effort: a writeWatermark rejection never breaks the inbox read", async () => {
    const a = msg("2026-07-18T10:00:00.000Z", "m1");
    M.readInbox.mockImplementation(async () => [a]);
    M.writeWatermark.mockImplementation(async () => {
      throw new Error("boom");
    });
    const out = await callInbox();
    expect(out.summary).toMatchObject({ newest_ts: a.ts });
    expect(out.entries).toHaveLength(1);
  });

  it("scopes the write to the CALLING owner's watermark", async () => {
    const a = msg("2026-07-18T10:00:00.000Z", "m1");
    M.readInbox.mockImplementation(async () => [a]);
    await callInbox({}, "owner-z");
    expect(M.writeWatermark).toHaveBeenCalledWith(
      "owner-z",
      expect.objectContaining({ messages_shown_ts: a.ts }),
    );
  });
});
