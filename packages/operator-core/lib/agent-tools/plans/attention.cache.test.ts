/**
 * plans:attention cache integration (cache-expensive-tool-reads-2026-06-22 P-003).
 *
 * Drives the REAL handler against a mocked source layer + the REAL operator cache.
 * Pins the caching CONTRACT specific to plans:attention:
 *   - a repeat call HITS (the ~10-source aggregation runs once)
 *   - a plan-table write BUSTS it (tags = plan tables → ECA bump rebuilds)
 *   - harnessFilter / includeArchived are in the key (no cross-arg leak)
 *   - NO cross-PRINCIPAL leak: the feed is principal-agnostic, so two callers with
 *     DIFFERENT role/principal but the same ws+args SHARE one entry AND get byte-
 *     identical data (there is no per-caller view to leak — D-001)
 *   - CACHE_LAYER OFF ⇒ bypass (the aggregation runs every call)
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  readAllPlans: vi.fn(async () => [] as unknown[]),
  ctxToPlanSourceOpts: vi.fn(async () => ({ harnessSlug: "papercup" })),
}));

vi.mock("./source", () => ({ readAllPlans: M.readAllPlans }));
vi.mock("./_ctx-opts", () => ({ ctxToPlanSourceOpts: M.ctxToPlanSourceOpts }));
vi.mock("../_harness-scope", async (orig) => {
  const actual = await orig<typeof import("../_harness-scope")>();
  return { ...actual, harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx };
});
vi.mock("../../attention/sources", async (orig) => {
  const actual = await orig<typeof import("../../attention/sources")>();
  return { ...actual, planItemsToAttention: vi.fn(() => [] as unknown[]) };
});
// Every other source → empty (no PG in the unit env).
vi.mock("../coordination/escalations", () => ({
  listEscalations: vi.fn(async () => []),
}));
vi.mock("../coordination/conversations", () => ({
  listConversationsWithTopics: vi.fn(async () => []),
}));
vi.mock("../coordination/messages", () => ({
  readInbox: vi.fn(async () => []),
  readAckedMsgIds: vi.fn(async () => new Set()),
}));
vi.mock("../coordination/identity", () => ({ ADMIN_COORD_UI_OWNER: "admin" }));
vi.mock("@papercusp/db-org", async (orig) => {
  const actual = await orig<typeof import("@papercusp/db-org")>();
  return { ...actual, getOrgPg: () => ({ sql: async () => [] }) };
});
vi.mock("../../attention/operator-report-source", () => ({
  readRecentOperatorReports: vi.fn(async () => []),
}));
vi.mock("../../harness/improvements/read-items", () => ({
  readImprovementItems: vi.fn(async () => []),
}));
vi.mock("../../operator-standing-candidates", () => ({
  readCandidates: vi.fn(async () => []),
}));
vi.mock("../../scout/routed-ledger", () => ({
  readRoutedIdeas: vi.fn(async () => []),
  readScoutPlanRefs: vi.fn(async () => new Set()),
}));
vi.mock("../../plan-items/convert", () => ({
  listConvertedPlanItemRefs: vi.fn(async () => new Set()),
}));
vi.mock("../../attention/triage-store", () => ({
  readTriageByWorkspace: vi.fn(async () => new Map()),
}));

import tool from "./attention";
import {
  getOperatorCache,
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";

const ctx = (
  workspaceId: string,
  role = "operator",
  principalSlug = "agent-a",
): never =>
  ({
    workspaceId,
    harnessSlug: "papercup",
    role,
    principal: { slug: principalSlug },
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const run = async (
  args: Record<string, unknown>,
  c = ctx("ws-attn"),
): Promise<{ groups: unknown[]; tierCounts: Record<string, number> }> => {
  // The handler returns a {data} envelope (context-trimming-tiers P-021) —
  // serialization to content[] happens in defineTool dispatch, not here.
  const res = (await tool.handler(args as never, c)) as {
    data: { groups: unknown[]; tierCounts: Record<string, number> };
  };
  return res.data;
};

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.readAllPlans.mockClear();
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

describe("plans:attention — cache wiring", () => {
  it("a repeat call HITS (the aggregation runs once)", async () => {
    await run({});
    await run({});
    expect(M.readAllPlans).toHaveBeenCalledTimes(1);
  });

  it("a plan-table write BUSTS the entry", async () => {
    await run({});
    getOperatorCache().invalidateByTags("ws-attn", ["harness_plans"]);
    await run({});
    expect(M.readAllPlans).toHaveBeenCalledTimes(2);
  });

  it("harnessFilter is in the key (no cross-arg leak)", async () => {
    await run({ harnessSlug: "h1" });
    await run({ harnessSlug: "h2" });
    expect(M.readAllPlans).toHaveBeenCalledTimes(2);
    await run({ harnessSlug: "h1" }); // cached
    expect(M.readAllPlans).toHaveBeenCalledTimes(2);
  });

  it("includeArchived is in the key", async () => {
    await run({});
    await run({ includeArchived: true });
    expect(M.readAllPlans).toHaveBeenCalledTimes(2);
  });

  it("NO cross-principal leak: differing role/principal SHARE one entry + identical data", async () => {
    const a = await run({}, ctx("ws-attn", "operator", "agent-a"));
    const b = await run({}, ctx("ws-attn", "sentinel", "agent-b"));
    // The feed is principal-agnostic → the second caller HITS the same entry…
    expect(M.readAllPlans).toHaveBeenCalledTimes(1);
    // …and gets byte-identical data (nothing caller-specific was cached / leaked).
    expect(b).toEqual(a);
  });

  it("CACHE_LAYER OFF ⇒ bypass: the aggregation runs on every call", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await run({});
    await run({});
    expect(M.readAllPlans).toHaveBeenCalledTimes(2);
  });
});
