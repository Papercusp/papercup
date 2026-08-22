/**
 * plans:items bounded-window contract (EI-20219728144911356).
 *
 * The tool must expose a validated limit so callers can bound a cross-plan
 * read without sending an undeclared argument. The cap is applied after the
 * handler's importance ordering and advertises truncation; the limit also
 * belongs in the cache key so different windows cannot share a response.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  listPlanRows: vi.fn(async () => [] as unknown[]),
  planItemsForRow: vi.fn((row: unknown) => (row as { planItems?: unknown[] }).planItems ?? []),
  getAllPlanItemCoverage: vi.fn(async () => new Map()),
  ctxToPlanSourceOpts: vi.fn(async () => ({ harnessSlug: "papercup" })),
}));

vi.mock("./source", async (orig) => {
  const actual = await orig<typeof import("./source")>();
  return {
    ...actual,
    listPlanRows: M.listPlanRows,
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
vi.mock("../../plan-item-coverage", async (orig) => {
  const actual = await orig<typeof import("../../plan-item-coverage")>();
  return { ...actual, getAllPlanItemCoverage: M.getAllPlanItemCoverage };
});

import tool from "./items";
import {
  resetCachedReadStatsForTests,
  resetOperatorCacheForTests,
} from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";

const item = (id: string, importance: "urgent" | "high" | "normal") => ({
  id,
  text: id,
  storedStatus: "todo",
  importance,
  blockedBy: [],
  decisionRefs: [],
  phase: "Phase 1",
  lineNumber: 1,
  rawLine: `- [ ] ${id}`,
  effectiveStatus: "todo",
  unresolvedBlockers: [],
  needsHuman: false,
  staleBlockedHint: null,
});

const plan = (slug: string, planItems: unknown[]) => ({
  planSlug: slug,
  archived: false,
  isLegacy: false,
  status: "active",
  content: "",
  created: "2026-08-01T00:00:00.000Z",
  planItems,
});

const contexts: Array<{ metadata: ReturnType<typeof vi.fn> }> = [];
const ctx = () => {
  const metadata = vi.fn();
  contexts.push({ metadata });
  return {
    workspaceId: "ws-items-limit",
    harnessSlug: "papercup",
    metadata,
    log: vi.fn(),
    progress: vi.fn(),
  } as never;
};

const run = async (args: Record<string, unknown>) =>
  tool.handler(args as never, ctx());

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  M.listPlanRows.mockReset();
  M.planItemsForRow.mockClear();
  M.getAllPlanItemCoverage.mockReset();
  M.getAllPlanItemCoverage.mockResolvedValue(new Map());
  contexts.length = 0;
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe("plans:items bounded limit", () => {
  it("accepts a positive bounded limit and rejects invalid values", () => {
    expect(tool.args.safeParse({ harness: "papercup", limit: 1 }).success).toBe(true);
    expect(tool.args.safeParse({ harness: "papercup", limit: 500 }).success).toBe(true);
    expect(tool.args.safeParse({ harness: "papercup", limit: 0 }).success).toBe(false);
    expect(tool.args.safeParse({ harness: "papercup", limit: 501 }).success).toBe(false);
    expect(tool.args.safeParse({ harness: "papercup", limit: 1.5 }).success).toBe(false);
  });

  it("caps after importance ordering and reports truncation", async () => {
    M.listPlanRows.mockResolvedValue([
      plan("p-normal", [item("P-003", "normal")]),
      plan("p-urgent", [item("P-001", "urgent")]),
      plan("p-high", [item("P-002", "high")]),
    ]);

    const result = (await run({ harness: "papercup", limit: 2 })) as {
      data: { items: Array<{ item: { id: string } }>; truncated?: boolean };
    };

    expect(result.data.items.map((row) => row.item.id)).toEqual(["P-001", "P-002"]);
    expect(result.data.truncated).toBe(true);
    expect(contexts[0].metadata).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2, totalCount: 3, truncated: true }),
    );
  });

  it("keeps different limits in separate cache entries", async () => {
    M.listPlanRows.mockResolvedValue([
      plan("p-urgent", [item("P-001", "urgent")]),
      plan("p-high", [item("P-002", "high")]),
    ]);

    const first = (await run({ harness: "papercup", limit: 1 })) as {
      data: { items: unknown[] };
    };
    const second = (await run({ harness: "papercup", limit: 2 })) as {
      data: { items: unknown[] };
    };

    expect(first.data.items).toHaveLength(1);
    expect(second.data.items).toHaveLength(2);
    expect(M.listPlanRows).toHaveBeenCalledTimes(2);
  });
});
