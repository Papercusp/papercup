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
vi.mock("../presence-beat-throttle", () => ({
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
