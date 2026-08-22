/**
 * Regression coverage for plans:items' unknown plan-scope contract (EI-21193120005663960).
 *
 * A stale/unregistered or registered-but-non-Hive harness is an empty plan read,
 * not a structural tool failure. Other resolver failures remain visible.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  listPlanRows: vi.fn(async () => [] as unknown[]),
  getPlanRow: vi.fn(async () => null as unknown),
  getAllPlanItemCoverage: vi.fn(async () => new Map()),
  ctxToPlanSourceOpts: vi.fn(async () => ({ harnessSlug: "desktop-notes-demo" })),
}));

vi.mock("./source", async (orig) => {
  const actual = await orig<typeof import("./source")>();
  return {
    ...actual,
    listPlanRows: M.listPlanRows,
    getPlanRow: M.getPlanRow,
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
vi.mock("../../plan-item-coverage", async (orig) => {
  const actual = await orig<typeof import("../../plan-item-coverage")>();
  return { ...actual, getAllPlanItemCoverage: M.getAllPlanItemCoverage };
});

import tool, { isUnknownPlanScopeError } from "./items";
import {
  resetCachedReadStatsForTests,
  resetOperatorCacheForTests,
} from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";
const HARNESS = "desktop-notes-demo";

const ctx = (metadata: ReturnType<typeof vi.fn>): never =>
  ({
    workspaceId: "ws-items-unknown-harness",
    harnessSlug: HARNESS,
    metadata,
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const unknownHarnessError = (message: string) =>
  new Error(`resolvePlanScope: ${message}`);

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  M.listPlanRows.mockReset();
  M.getPlanRow.mockReset();
  M.getAllPlanItemCoverage.mockReset();
  M.getAllPlanItemCoverage.mockResolvedValue(new Map());
  M.ctxToPlanSourceOpts.mockResolvedValue({ harnessSlug: HARNESS });
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe("plans:items unknown plan scope", () => {
  it("recognizes only the resolver's unknown/non-Hive scope failures", () => {
    expect(
      isUnknownPlanScopeError(
        unknownHarnessError("harness 'desktop-notes-demo' is not registered"),
      ),
    ).toBe(true);
    expect(
      isUnknownPlanScopeError(
        unknownHarnessError(
          "plans are Hive-scoped, but 'pot-verify' is not a Hive home",
        ),
      ),
    ).toBe(true);
    expect(isUnknownPlanScopeError(new Error("database unavailable"))).toBe(false);
  });

  it("returns an empty cross-plan read and warning metadata for an unknown harness", async () => {
    M.listPlanRows.mockRejectedValueOnce(
      unknownHarnessError(
        "harness 'desktop-notes-demo' is not registered in the harness registry",
      ),
    );
    const metadata = vi.fn();

    const result = (await tool.handler({ harness: HARNESS } as never, ctx(metadata))) as {
      data: { items: unknown[] };
    };

    expect(result.data.items).toEqual([]);
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 0,
        totalCount: 0,
        scope: "all",
        unknownHarnesses: [HARNESS],
      }),
    );
  });

  it("returns an empty single-plan read and warning metadata for a non-Hive harness", async () => {
    M.getPlanRow.mockRejectedValueOnce(
      unknownHarnessError(
        "plans are Hive-scoped, but 'desktop-notes-demo' is not a Hive home",
      ),
    );
    const metadata = vi.fn();

    const result = (await tool.handler(
      { harness: HARNESS, slug: "some-plan" } as never,
      ctx(metadata),
    )) as { data: { items: unknown[] } };

    expect(result.data.items).toEqual([]);
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 0,
        totalCount: 0,
        scope: "some-plan",
        unknownHarnesses: [HARNESS],
      }),
    );
  });

  it("still propagates unrelated plan-source failures", async () => {
    M.listPlanRows.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      tool.handler({ harness: HARNESS } as never, ctx(vi.fn())),
    ).rejects.toThrow("database unavailable");
  });
});
