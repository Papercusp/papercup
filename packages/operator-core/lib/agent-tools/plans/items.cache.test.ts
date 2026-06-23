/**
 * plans:items cache integration (cache-expensive-tool-reads-round2-2026-06-23 P-002).
 *
 * Drives the REAL handler against a mocked source layer + the REAL operator cache to pin
 * the caching CONTRACT specific to plans:items: a repeat cross-plan query HITS (listPlanRows
 * runs once); a plan-table write busts it (tag invalidation); different args / workspaces
 * never share an entry (no cross-key / cross-workspace leak); the CACHE_LAYER kill-switch
 * disables caching. (Generic SWR/key semantics are pinned in cache/cached-read.test.ts.)
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  listPlanRows: vi.fn(async () => [] as unknown[]),
  getPlanRow: vi.fn(async () => null as unknown),
  planItemsForRow: vi.fn(() => [] as unknown[]),
  ctxToPlanSourceOpts: vi.fn(async () => ({ harnessSlug: "papercup" })),
}));

vi.mock("./source", async (orig) => {
  const actual = await orig<typeof import("./source")>();
  return {
    ...actual,
    listPlanRows: M.listPlanRows,
    getPlanRow: M.getPlanRow,
    planItemsForRow: M.planItemsForRow,
  };
});
vi.mock("./_ctx-opts", () => ({ ctxToPlanSourceOpts: M.ctxToPlanSourceOpts }));
vi.mock("../../issue-blocks-merge", async (orig) => {
  const actual = await orig<typeof import("../../issue-blocks-merge")>();
  return {
    ...actual,
    getAllBlockedPlanItems: vi.fn(async () => new Map<string, string[]>()),
  };
});

import tool from "./items";
import {
  getOperatorCache,
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";

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
  workspaceId = "ws-items",
): Promise<void> => {
  await tool.handler(args as never, ctx(workspaceId));
};

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.listPlanRows.mockClear();
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

describe("plans:items — cache wiring", () => {
  it("a repeat cross-plan query HITS (listPlanRows runs once)", async () => {
    await run({ actionable: true });
    await run({ actionable: true });
    expect(M.listPlanRows).toHaveBeenCalledTimes(1);
  });

  it("a harness_plans write BUSTS the entry (tag invalidation rebuilds)", async () => {
    await run({ actionable: true });
    expect(M.listPlanRows).toHaveBeenCalledTimes(1);
    getOperatorCache().invalidateByTags("ws-items", ["harness_plans"]);
    await run({ actionable: true });
    expect(M.listPlanRows).toHaveBeenCalledTimes(2);
  });

  it("a plan_revisions write also busts (every tagged table invalidates)", async () => {
    await run({ actionable: true });
    getOperatorCache().invalidateByTags("ws-items", ["plan_revisions"]);
    await run({ actionable: true });
    expect(M.listPlanRows).toHaveBeenCalledTimes(2);
  });

  it("different filters do NOT share an entry (no cross-arg leak)", async () => {
    await run({ actionable: true });
    await run({ needsHuman: true });
    expect(M.listPlanRows).toHaveBeenCalledTimes(2);
    // each independently cached on repeat
    await run({ actionable: true });
    await run({ needsHuman: true });
    expect(M.listPlanRows).toHaveBeenCalledTimes(2);
  });

  it("different workspaces do NOT share an entry (no cross-workspace leak)", async () => {
    await run({ actionable: true }, "ws-A");
    await run({ actionable: true }, "ws-B");
    expect(M.listPlanRows).toHaveBeenCalledTimes(2);
    getOperatorCache().invalidateByTags("ws-A", ["harness_plans"]);
    await run({ actionable: true }, "ws-A");
    await run({ actionable: true }, "ws-B");
    expect(M.listPlanRows).toHaveBeenCalledTimes(3);
  });

  it("CACHE_LAYER OFF ⇒ bypass: listPlanRows runs on every call", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await run({ actionable: true });
    await run({ actionable: true });
    await run({ actionable: true });
    expect(M.listPlanRows).toHaveBeenCalledTimes(3);
  });
});
