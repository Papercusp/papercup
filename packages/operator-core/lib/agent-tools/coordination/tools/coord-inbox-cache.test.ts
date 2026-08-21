/**
 * coord:inbox cache integration (cache-expensive-tool-reads-2026-06-22 P-008).
 * Only the pure readInbox() derive is cached; every side effect (heartbeat,
 * watermark, mailbox drain) must STILL run on a cache hit. REAL cache + mocked deps.
 * Pins: hit-on-repeat (derive runs once); side effects run every call; per-OWNER
 * key (no cross-principal leak); coord_event_log bump invalidates; CACHE_LAYER bypass.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  readInbox: vi.fn(async () => [] as unknown[]),
  heartbeatPresence: vi.fn(async () => {}),
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
vi.mock("../presence", () => ({ heartbeatPresence: M.heartbeatPresence }));
// This suite pins CACHE behavior — the heartbeat throttle (EI-6797) is a
// separate concern, so disable it here (always-beat) so "side effects run on a
// cache hit" is tested independently of coalescing. The throttle itself is
// covered by presence-beat-throttle.test.ts + inbox-heartbeat-throttle.test.ts.
//
// ⚠ The `importOriginal` spread is LOAD-BEARING — do not "simplify" it back to a
// bare factory. This suite only wants to stub createPresenceBeatThrottle, but a
// bare `() => ({ createPresenceBeatThrottle })` factory makes every OTHER export
// of the module undefined. dispatch-heartbeat.ts imports PRESENCE_BEAT_INTERVAL_MS
// and evaluates it at MODULE SCOPE (`export const DISPATCH_BEAT_INTERVAL_MS =
// PRESENCE_BEAT_INTERVAL_MS`), reached from here via projected-tool-deps.ts — so a
// missing export throws at import time and the whole suite fails to COLLECT, with
// no failing assertion to point at. That red froze `main` fleet-wide as part of the
// green-checkpoint RED-23 streak (WI-40270). Spreading the real module keeps this
// mock partial, so adding a new export to presence-beat-throttle can never strand
// it again.
vi.mock("../presence-beat-throttle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../presence-beat-throttle")>()),
  createPresenceBeatThrottle: () => ({
    shouldBeat: () => true,
    reset: () => {},
    size: () => 0,
  }),
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

import tool from "./inbox";
import {
  getOperatorCache,
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from "../../../cache";
import { _refreshCacheLayerForTests } from "../../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";
const ctx = (ownerId: string, workspaceId = "ws-inbox"): never =>
  ({
    ownerId,
    workspaceId,
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const inbox = (owner: string): Promise<unknown> =>
  tool.handler({} as never, ctx(owner));

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.readInbox.mockClear();
  M.heartbeatPresence.mockClear();
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  __setCachedReadEnabledForTests(false);
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe("coord:inbox — cache the derive, keep side effects", () => {
  it("a repeat read HITS the derive (readInbox runs once)", async () => {
    await inbox("owner-a");
    await inbox("owner-a");
    expect(M.readInbox).toHaveBeenCalledTimes(1);
  });

  it("side effects (heartbeat) STILL run on every call, even a cache hit", async () => {
    await inbox("owner-a"); // miss → derive + heartbeat
    await inbox("owner-a"); // hit → heartbeat STILL runs (it is outside the cache)
    expect(M.readInbox).toHaveBeenCalledTimes(1); // derive cached
    expect(M.heartbeatPresence).toHaveBeenCalledTimes(2); // liveness never dropped
  });

  it("NO cross-principal leak: a different owner gets its OWN derive (separate entry)", async () => {
    await inbox("owner-a");
    await inbox("owner-b");
    expect(M.readInbox).toHaveBeenCalledTimes(2);
    await inbox("owner-a"); // cached
    await inbox("owner-b"); // cached
    expect(M.readInbox).toHaveBeenCalledTimes(2);
  });

  it("a coord_event_log bump invalidates the derive (rebuild on next read)", async () => {
    await inbox("owner-a");
    expect(M.readInbox).toHaveBeenCalledTimes(1);
    getOperatorCache().invalidateByTags("ws-inbox", ["coord_event_log"]);
    await inbox("owner-a");
    expect(M.readInbox).toHaveBeenCalledTimes(2);
  });

  it("CACHE_LAYER OFF ⇒ bypass: the derive runs every call", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await inbox("owner-a");
    await inbox("owner-a");
    expect(M.readInbox).toHaveBeenCalledTimes(2);
  });
});

// EI-18667514339699744: coord:inbox returns its rows under `entries`; coord:orient
// folds the SAME rows under `recent`. A caller reading the wrong key for the surface
// it's actually on got a silent [] (indistinguishable from "no mail") instead of an
// error. Pin that coord:inbox's own result exposes BOTH key names for the same array.
describe("coord:inbox — `recent` alias (EI-18667514339699744)", () => {
  it("exposes the same rows under both `entries` and `recent`", async () => {
    M.readInbox.mockResolvedValueOnce([
      { msg_id: "m1", kind: "message", from: "peer", ts: "2026-07-26T00:00:00Z", summary: "hi" },
    ] as unknown[]);
    const result = (await inbox("owner-a")) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { entries: unknown[]; recent: unknown[] };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.recent).toEqual(parsed.entries);
  });
});
