/**
 * plans:list — the groupBy/aggregateOnly aggregate path
 * (claimable-read-tool-and-sql-encapsulation-audit-2026-07-21 P-005).
 *
 * The contract this pins, in the order it can break:
 *  - the aggregate counts EVERY matched row, and `limit` bounds only the rows
 *    returned (the whole point — a limited aggregate is a WRONG answer, and it
 *    is the failure a naive "group the returned page" implementation gives);
 *  - aggregateOnly returns the groups with no rows, and skips the expensive
 *    per-plan item pass unless the dimension is item-derived (importance);
 *  - a call WITHOUT groupBy is byte-identical to before (no `groups` key);
 *  - group ordering is stable (count desc, ties alphabetical, null bucket last);
 *  - the cache does not serve a row-mode entry to an aggregate call.
 *
 * Drives the REAL handler against a mocked source layer (same seam as
 * list.cache.test.ts) so no PG is required.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  // vitest 4 infers a vi.fn mock's Parameters from its initial implementation
  // — a zero-arg arrow made `.mock.calls[N]` the empty tuple `[]`, so indexing
  // `?.[0]` on a call (below) failed to typecheck (TS2493) even though the real
  // listPlanIndexRows always takes one opts arg. An explicit unused param keeps
  // the mock body identical while giving `.mock.calls[N][0]` a real element type.
  listPlanIndexRows: vi.fn(async (_opts?: unknown) => [] as unknown[]),
  listPlanIndexRowsForWorkspace: vi.fn(async (_opts?: unknown) => [] as unknown[]),
  getPlanContentsBySlugs: vi.fn(async () => new Map<string, string>()),
  resolveHarnessPlansDir: vi.fn(async (slug: string) => ({
    harnessSlug: slug,
  })),
  ctxToPlanSourceOpts: vi.fn(async () => ({ harnessSlug: "papercup" })),
}));

vi.mock("./source", async (orig) => {
  const actual = await orig<typeof import("./source")>();
  return {
    ...actual,
    listPlanIndexRows: M.listPlanIndexRows,
    listPlanIndexRowsForWorkspace: M.listPlanIndexRowsForWorkspace,
    getPlanContentsBySlugs: M.getPlanContentsBySlugs,
    resolveHarnessPlansDir: M.resolveHarnessPlansDir,
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
vi.mock("../../scout/routed-ledger", () => ({
  readScoutPlanRefs: vi.fn(async () => new Set<string>()),
  readRoutedIdeas: vi.fn(async () => []),
}));

import tool from "./list";
import {
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";

/** A minimal index row — only the columns plans:list projects. */
const row = (over: Record<string, unknown>): unknown => ({
  planSlug: "p",
  title: "P",
  status: "active",
  created: "2026-07-01",
  updated: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  owner: null,
  initiative: null,
  template: null,
  forcedPast: null,
  archived: false,
  isLegacy: false,
  items: [],
  decisions: [],
  nowNext: null,
  opStatus: null,
  opPriority: null,
  schedule: null,
  scheduledAt: null,
  scheduleActive: false,
  harnessSlug: "papercup",
  ...over,
});

const ctx = (workspaceId = "ws-groupby"): never =>
  ({
    workspaceId,
    harnessSlug: "papercup",
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

type ListResult = {
  data: { plans: unknown[]; groups?: Array<{ key: string | null; count: number }> };
};

const run = async (args: Record<string, unknown>): Promise<ListResult["data"]> => {
  const res = (await tool.handler(args as never, ctx())) as ListResult;
  return res.data;
};

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(false);
  M.listPlanIndexRows.mockReset();
  M.listPlanIndexRows.mockResolvedValue([]);
  setFlagOverridesForTest({ [CACHE_LAYER]: false });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe("plans:list — groupBy aggregates", () => {
  it("surfaces the permanent forced-past marker on each plan row", async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({
        planSlug: "forced",
        forcedPast: {
          count: 1,
          latest: {
            reason: "explicit exception",
            checks: ["audit_coverage_stale"],
            forcedAt: "2026-08-20T22:30:00.000Z",
            forcedBy: { ownerId: "su-forcer", ownerLabel: "Forcing agent" },
            legacy: false,
          },
        },
      }),
    ]);

    const { plans } = await run({});
    expect(plans[0]).toMatchObject({
      slug: "forced",
      forcedPast: {
        count: 1,
        latest: { reason: "explicit exception", checks: ["audit_coverage_stale"] },
      },
    });
  });

  it("counts every matched row per dimension value", async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: "a", status: "active" }),
      row({ planSlug: "b", status: "active" }),
      row({ planSlug: "c", status: "shipped" }),
    ]);
    const { groups } = await run({ groupBy: "status" });
    expect(groups).toEqual([
      { key: "active", count: 2 },
      { key: "shipped", count: 1 },
    ]);
  });

  it("`limit` bounds the returned ROWS but never the aggregate", async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: "a", status: "active" }),
      row({ planSlug: "b", status: "active" }),
      row({ planSlug: "c", status: "shipped" }),
    ]);
    const { plans, groups } = await run({ groupBy: "status", limit: 1 });
    expect(plans).toHaveLength(1);
    // The counts still cover all three — a limited aggregate would be wrong.
    expect(groups).toEqual([
      { key: "active", count: 2 },
      { key: "shipped", count: 1 },
    ]);
    // ...and the limit was NOT pushed into the SQL fetch (which would have
    // truncated the set the aggregate sees).
    expect(M.listPlanIndexRows.mock.calls[0]?.[0]).not.toHaveProperty("limit");
  });

  it("aggregateOnly returns the groups with no rows", async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: "a", status: "active" }),
      row({ planSlug: "b", status: "draft" }),
    ]);
    const { plans, groups } = await run({
      groupBy: "status",
      aggregateOnly: true,
    });
    expect(plans).toEqual([]);
    expect(groups).toEqual([
      { key: "active", count: 1 },
      { key: "draft", count: 1 },
    ]);
  });

  it("aggregateOnly is ignored without groupBy (rows still come back)", async () => {
    M.listPlanIndexRows.mockResolvedValue([row({ planSlug: "a" })]);
    const { plans, groups } = await run({ aggregateOnly: true });
    expect(plans).toHaveLength(1);
    expect(groups).toBeUndefined();
  });

  it("no groupBy ⇒ no `groups` key at all (unchanged shape)", async () => {
    M.listPlanIndexRows.mockResolvedValue([row({ planSlug: "a" })]);
    const data = await run({});
    expect(data).not.toHaveProperty("groups");
  });

  it("buckets createdDay by UTC day, null bucket last", async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: "a", created: "2026-07-01" }),
      row({ planSlug: "b", created: "2026-07-01" }),
      row({ planSlug: "c", created: "2026-07-02" }),
      row({ planSlug: "d", created: null }),
    ]);
    const { groups } = await run({ groupBy: "createdDay" });
    expect(groups).toEqual([
      { key: "2026-07-01", count: 2 },
      { key: "2026-07-02", count: 1 },
      { key: null, count: 1 },
    ]);
  });

  it("ties sort alphabetically, and the null bucket sorts last on a tie", async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: "a", owner: "zoe" }),
      row({ planSlug: "b", owner: "avi" }),
      row({ planSlug: "c", owner: null }),
    ]);
    const { groups } = await run({ groupBy: "owner" });
    expect(groups).toEqual([
      { key: "avi", count: 1 },
      { key: "zoe", count: 1 },
      { key: null, count: 1 },
    ]);
  });

  it("groups a boolean dimension into true/false buckets", async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: "a", schedule: "0 * * * *" }),
      row({ planSlug: "b" }),
      row({ planSlug: "c" }),
    ]);
    const { groups } = await run({ groupBy: "scheduled" });
    expect(groups).toEqual([
      { key: "false", count: 2 },
      { key: "true", count: 1 },
    ]);
  });

  it("an item-derived dimension (importance) still resolves items under aggregateOnly", async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({
        planSlug: "a",
        items: [
          {
            id: "P-001",
            text: "x",
            status: "todo",
            importance: "high",
            blockedBy: [],
            decisionRefs: [],
            phase: null,
          },
        ],
      }),
      row({ planSlug: "b", items: [] }),
    ]);
    const { groups } = await run({
      groupBy: "importance",
      aggregateOnly: true,
    });
    // 'a' has an open high item; 'b' has no open items ⇒ null bucket.
    expect(groups).toEqual([
      { key: "high", count: 1 },
      { key: null, count: 1 },
    ]);
  });
});

describe("plans:list — groupBy cache isolation", () => {
  beforeEach(async () => {
    __setCachedReadEnabledForTests(true);
    setFlagOverridesForTest({ [CACHE_LAYER]: true });
    await _refreshCacheLayerForTests();
  });

  afterEach(async () => {
    __setCachedReadEnabledForTests(false);
  });

  it("an aggregate call does NOT reuse the row-mode cache entry", async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: "a", status: "active" }),
      row({ planSlug: "b", status: "shipped" }),
    ]);
    const plain = await run({});
    expect(plain).not.toHaveProperty("groups");

    const agg = await run({ groupBy: "status" });
    expect(agg.groups).toEqual([
      { key: "active", count: 1 },
      { key: "shipped", count: 1 },
    ]);

    // Distinct cache keys ⇒ the source was fetched once per mode.
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);

    // ...and each mode is independently cached on repeat.
    await run({});
    await run({ groupBy: "status" });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });

  it("aggregateOnly gets its own entry (rows vs no-rows never collide)", async () => {
    M.listPlanIndexRows.mockResolvedValue([row({ planSlug: "a" })]);
    const withRows = await run({ groupBy: "status" });
    const noRows = await run({ groupBy: "status", aggregateOnly: true });
    expect(withRows.plans).toHaveLength(1);
    expect(noRows.plans).toEqual([]);
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });
});
