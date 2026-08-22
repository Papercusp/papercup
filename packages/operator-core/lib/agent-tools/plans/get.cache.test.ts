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
      items: [
        {
          id: "P-001",
          text: "first item",
          storedStatus: "todo",
          importance: "normal",
          blockedBy: [],
          decisionRefs: [],
          phase: null,
          lineNumber: 1,
          rawLine: "- **P-001** `todo` — first item",
        },
        {
          id: "P-009",
          text: "the item requested from a large plan",
          storedStatus: "todo",
          importance: "normal",
          blockedBy: [],
          decisionRefs: [],
          phase: null,
          lineNumber: 2,
          rawLine: "- **P-009** `todo` — the item requested from a large plan",
        },
      ],
    },
    archived: false,
    row: {
      workspaceId: "ws-get",
      planSlug: slug,
      harnessSlug: "papercup",
      version: 1,
      promotePolicy: null,
      forcedPast: {
        count: 1,
        latest: {
          reason: "auditor unavailable",
          checks: ["acceptance_unaudited"],
          forcedAt: "2026-08-20T22:30:00.000Z",
          forcedBy: { ownerId: "su-forcer", ownerLabel: "Forcing agent" },
          legacy: false,
        },
      },
    },
  })),
  ctxToPlanSourceOpts: vi.fn(async () => ({ harnessSlug: "papercup" })),
  resolveCtxHarnessSlug: vi.fn(() => "papercup"),
  resolveEffectiveHarnessSlug: vi.fn(() => "papercup"),
  getAcceptanceRubricForPlan: vi.fn(async (slug: string) => ({
    rubricId: `rubric-${slug}`,
    status: "ratified",
    criteria: [{ id: "criterion-1" }],
    classRef: "plan-class-code",
  })),
  getLatestPlanAudit: vi.fn(async (slug: string) => ({
    planSlug: slug,
    harnessSlug: "papercup",
    auditSeq: 7,
    createdBy: "su-auditor",
    createdAt: "2026-08-20T23:00:00.000Z",
    auditedSha: "abc123",
    items: [
      {
        itemId: "P-001",
        verdict: "implemented",
        citations: [{ kind: "code", path: "src/a.ts", blobSha: "blob-a" }],
        auditedSha: "abc123",
        auditedAt: "2026-08-20T23:00:00.000Z",
        itemTextHash: "item-hash",
      },
    ],
    findings: [],
    summary: "code truth verified",
  })),
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
vi.mock("../../rubrics", () => ({
  getAcceptanceRubricForPlan: M.getAcceptanceRubricForPlan,
}));
vi.mock("../../plan-audits", () => ({
  getLatestPlanAudit: M.getLatestPlanAudit,
}));

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
): Promise<{ results: Array<Record<string, unknown>> }> =>
  ((await tool.handler(args as never, ctx(workspaceId))) as {
    data: { results: Array<Record<string, unknown>> };
  }).data;

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.readPlanBySlug.mockClear();
  M.getAcceptanceRubricForPlan.mockClear();
  M.getLatestPlanAudit.mockClear();
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

  it("does not cache a not_found result when a later read succeeds", async () => {
    M.readPlanBySlug.mockResolvedValueOnce(null as never);

    const missing = await run({ slug: "eventually-present" });
    expect(missing.results[0]).toMatchObject({
      ok: false,
      slug: "eventually-present",
      error: "not_found",
    });

    const recovered = await run({ slug: "eventually-present" });
    expect(recovered.results[0]).toMatchObject({
      ok: true,
      slug: "eventually-present",
    });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
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

  it("a plan_audits write busts the entry so latestAudit cannot stay stale", async () => {
    await run({ slug: "alpha" });
    expect(M.getLatestPlanAudit).toHaveBeenCalledTimes(1);
    getOperatorCache().invalidateByTags("ws-get", ["plan_audits"]);
    await run({ slug: "alpha" });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
    expect(M.getLatestPlanAudit).toHaveBeenCalledTimes(2);
  });

  it("surfaces latestAudit beside acceptanceRubric in the structured read", async () => {
    const body = await run({ slug: "alpha" });
    expect(body.results[0]).toMatchObject({
      acceptanceRubric: {
        rubricId: "rubric-alpha",
        status: "ratified",
        criteriaCount: 1,
        classRef: "plan-class-code",
      },
      latestAudit: {
        planSlug: "alpha",
        auditSeq: 7,
        auditedSha: "abc123",
        items: [
          {
            itemId: "P-001",
            auditedSha: "abc123",
            citations: [{ kind: "code", path: "src/a.ts", blobSha: "blob-a" }],
          },
        ],
      },
    });
    expect(M.getLatestPlanAudit).toHaveBeenCalledWith("alpha", {
      workspaceId: "ws-get",
      harnessSlug: "papercup",
    });
  });

  it("surfaces the permanent forced-past marker on ordinary and meta reads", async () => {
    const sections = await run({ slug: "alpha" });
    expect(sections.results[0]).toMatchObject({
      forcedPast: {
        count: 1,
        latest: {
          reason: "auditor unavailable",
          checks: ["acceptance_unaudited"],
          forcedBy: { ownerId: "su-forcer" },
        },
      },
    });

    const meta = await run({ slug: "alpha", mode: "meta" });
    expect(meta.results[0]).toMatchObject({ forcedPast: { count: 1 } });
  });

  it("keeps meta reads lean and does not fetch rubric/audit decorations", async () => {
    const body = await run({ slug: "alpha", mode: "meta" });
    expect(body.results[0]).not.toHaveProperty("acceptanceRubric");
    expect(body.results[0]).not.toHaveProperty("latestAudit");
    expect(M.getAcceptanceRubricForPlan).not.toHaveBeenCalled();
    expect(M.getLatestPlanAudit).not.toHaveBeenCalled();
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

  it("returns only requested plan items and reports missing ids without hiding the plan total", async () => {
    const body = await run({ slug: "alpha", items: ["P-009", "P-404"] });
    expect(body.results[0]).toMatchObject({
      counts: { items: 2 },
      itemSelection: {
        requested: ["P-009", "P-404"],
        matched: ["P-009"],
        missing: ["P-404"],
      },
      items: [{ id: "P-009", text: "the item requested from a large plan" }],
    });
  });

  it("keeps item selections in separate cache entries", async () => {
    await run({ slug: "alpha", items: ["P-001"] });
    await run({ slug: "alpha", items: ["P-009"] });
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
