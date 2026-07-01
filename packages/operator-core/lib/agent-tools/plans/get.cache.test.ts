/**
 * plans:get cache integration (cache-expensive-tool-reads-round2-2026-06-23 P-001).
 *
 * Drives the REAL handler against a mocked source/decoration layer + the REAL operator
 * cache to pin the caching CONTRACT specific to plans:get: a repeat call for the same
 * slug HITS (readPlanBySlug runs once); a plan-table write busts it (tag invalidation);
 * different slug / mode / workspace never share an entry (no cross-key / cross-workspace
 * leak); the CACHE_LAYER kill-switch disables caching. (Generic SWR/key semantics are
 * pinned in cache/cached-read.test.ts; this file proves the wiring — right tags, right key,
 * per-slug granularity.)
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  readPlanBySlug: vi.fn(async (slug: string) => ({
    parsed: {
      isLegacy: false,
      slug,
      prose: "## Now\nbody\n",
      raw: `slug: ${slug}\n`,
      frontmatter: { slug },
      now: { state: "s", next: "n" },
      decisions: [],
      items: [],
    },
    archived: false,
    row: { version: 1, promotePolicy: null },
  })),
  ctxToPlanSourceOpts: vi.fn(async () => ({ harnessSlug: "papercup" })),
  resolveCtxHarnessSlug: vi.fn(() => "papercup"),
  resolveEffectiveHarnessSlug: vi.fn(() => "papercup"),
}));

vi.mock("./source", async (orig) => {
  const actual = await orig<typeof import("./source")>();
  return { ...actual, readPlanBySlug: M.readPlanBySlug };
});
vi.mock("./_ctx-opts", () => ({
  ctxToPlanSourceOpts: M.ctxToPlanSourceOpts,
  resolveCtxHarnessSlug: M.resolveCtxHarnessSlug,
  resolveEffectiveHarnessSlug: M.resolveEffectiveHarnessSlug,
}));
vi.mock("../../issue-blocks-merge", async (orig) => {
  const actual = await orig<typeof import("../../issue-blocks-merge")>();
  return {
    ...actual,
    overlayIssueBlocksForPlan: vi.fn(async (_slug: string, items: unknown[]) => ({
      items,
      blockingIssues: {},
    })),
  };
});
// The linkedFeatures / planItemTests decorations query PG via withWorkspace; in the
// unit test there's no DB, so make it throw — both reads are wrapped in a non-fatal
// try/catch and degrade to empty, which is exactly the path we want to exercise.
vi.mock("@papercusp/db-org", async (orig) => {
  const actual = await orig<typeof import("@papercusp/db-org")>();
  return {
    ...actual,
    withWorkspace: vi.fn(async () => {
      throw new Error("no-db-in-unit-test");
    }),
  };
});

import tool from "./get";
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
  workspaceId = "ws-get",
): Promise<void> => {
  await tool.handler(args as never, ctx(workspaceId));
};

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.readPlanBySlug.mockClear();
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

describe("plans:get — cache wiring", () => {
  it("a repeat call for the same slug HITS (readPlanBySlug runs once)", async () => {
    await run({ slug: "alpha" });
    await run({ slug: "alpha" });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(1);
  });

  it("a harness_plans write BUSTS the entry (tag invalidation rebuilds)", async () => {
    await run({ slug: "alpha" });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(1);
    getOperatorCache().invalidateByTags("ws-get", ["harness_plans"]);
    await run({ slug: "alpha" });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
  });

  it("a plan_revisions write also busts (every tagged table invalidates)", async () => {
    await run({ slug: "alpha" });
    getOperatorCache().invalidateByTags("ws-get", ["plan_revisions"]);
    await run({ slug: "alpha" });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
  });

  it("different slugs do NOT share an entry (per-slug key)", async () => {
    await run({ slug: "alpha" });
    await run({ slug: "beta" });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
    // each independently cached on repeat
    await run({ slug: "alpha" });
    await run({ slug: "beta" });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
  });

  it("different mode does NOT share an entry (mode is in the key)", async () => {
    await run({ slug: "alpha", mode: "meta" });
    await run({ slug: "alpha", mode: "full" });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
  });

  it("different workspaces do NOT share an entry (no cross-workspace leak)", async () => {
    await run({ slug: "alpha" }, "ws-A");
    await run({ slug: "alpha" }, "ws-B");
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
    getOperatorCache().invalidateByTags("ws-A", ["harness_plans"]);
    await run({ slug: "alpha" }, "ws-A");
    await run({ slug: "alpha" }, "ws-B");
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(3);
  });

  it("CACHE_LAYER OFF ⇒ bypass: readPlanBySlug runs on every call", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await run({ slug: "alpha" });
    await run({ slug: "alpha" });
    await run({ slug: "alpha" });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(3);
  });
});
