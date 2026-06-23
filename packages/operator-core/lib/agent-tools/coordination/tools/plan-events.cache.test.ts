/**
 * coord:plan-events cache integration (cache-expensive-tool-reads-round2-2026-06-23 P-003).
 *
 * Pins the caching CONTRACT: a repeat call with the same read-dimensions HITS (readPlanEvents
 * runs once); a coord_event_log write busts it (the DEBOUNCED tag); a limit-only difference
 * SHARES the entry (limit is a presentation bound, not in the key); different since_ts /
 * workspace never share an entry; the CACHE_LAYER kill-switch disables caching.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  readPlanEvents: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../plan-events", async (orig) => {
  const actual = await orig<typeof import("../plan-events")>();
  return { ...actual, readPlanEvents: M.readPlanEvents };
});

import tool from "./plan-events";
import {
  getOperatorCache,
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from "../../../cache";
import { _refreshCacheLayerForTests } from "../../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";

const ctx = (workspaceId: string): never =>
  ({
    workspaceId,
    harnessSlug: "papercup",
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const run = async (
  args: Record<string, unknown>,
  workspaceId = "ws-pe",
): Promise<void> => {
  await tool.handler(args as never, ctx(workspaceId));
};

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.readPlanEvents.mockClear();
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

describe("coord:plan-events — cache wiring", () => {
  it("a repeat call HITS (readPlanEvents runs once)", async () => {
    await run({});
    await run({});
    expect(M.readPlanEvents).toHaveBeenCalledTimes(1);
  });

  it("a coord_event_log write BUSTS the entry (debounced tag → ECA bump rebuilds)", async () => {
    await run({});
    expect(M.readPlanEvents).toHaveBeenCalledTimes(1);
    getOperatorCache().invalidateByTags("ws-pe", ["coord_event_log"]);
    await run({});
    expect(M.readPlanEvents).toHaveBeenCalledTimes(2);
  });

  it("a limit-only difference SHARES the entry (limit is not a read dimension)", async () => {
    await run({ limit: 10 });
    await run({ limit: 50 });
    expect(M.readPlanEvents).toHaveBeenCalledTimes(1);
  });

  it("different since_ts do NOT share an entry (read dimension)", async () => {
    await run({ since_ts: "2026-06-23T00:00:00Z" });
    await run({ since_ts: "2026-06-23T01:00:00Z" });
    expect(M.readPlanEvents).toHaveBeenCalledTimes(2);
  });

  it("different workspaces do NOT share an entry (no cross-workspace leak)", async () => {
    await run({}, "ws-A");
    await run({}, "ws-B");
    expect(M.readPlanEvents).toHaveBeenCalledTimes(2);
    getOperatorCache().invalidateByTags("ws-A", ["coord_event_log"]);
    await run({}, "ws-A");
    await run({}, "ws-B");
    expect(M.readPlanEvents).toHaveBeenCalledTimes(3);
  });

  it("CACHE_LAYER OFF ⇒ bypass: readPlanEvents runs on every call", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await run({});
    await run({});
    await run({});
    expect(M.readPlanEvents).toHaveBeenCalledTimes(3);
  });
});
