/**
 * plans:get — `include` compatibility alias for `includeRaw` (EI-21913230259449717).
 *
 * A caller reached for the generic `include` (the shape several other read
 * tools use for a boolean opt-in) instead of this tool's specific
 * `includeRaw` and hit invalid_args before any read ran. This pins:
 *   - the schema accepts `include` as an alias;
 *   - the handler resolves it identically to `includeRaw` (the `raw` field
 *     appears in mode:'full' output);
 *   - an explicit `includeRaw` wins when both are supplied;
 *   - the two spellings share ONE cache entry (the alias is resolved BEFORE
 *     the cache key is built, not after — otherwise a slim agent-cached
 *     entry from `include:true` could be served to a caller expecting `raw`
 *     via `includeRaw:true`, or vice versa).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => {
  const planFixture = (slug: string) => ({
    parsed: {
      isLegacy: false,
      slug,
      prose: "## Now\nbody\n",
      raw: `slug: ${slug}\nfull raw bytes\n`,
      frontmatter: { slug },
      now: { state: "s", next: "n" },
      decisions: [],
      items: [],
    },
    archived: false,
    row: {
      workspaceId: "ws-get-include",
      planSlug: slug,
      harnessSlug: "papercup",
      version: 1,
      promotePolicy: null,
      forcedPast: null,
    },
  });
  type PlanRead = ReturnType<typeof planFixture> | null;
  return {
    planHarnessesForSlugs: vi.fn(async () => new Map<string, string[]>()),
    readPlanBySlug: vi.fn(async (slug: string): Promise<PlanRead> => planFixture(slug)),
    ctxToPlanSourceOpts: vi.fn(async (ctx: { harnessSlug?: string }) => ({
      harnessSlug: ctx.harnessSlug ?? "papercup",
    })),
    resolveCtxHarnessSlug: vi.fn(() => "papercup"),
    resolveEffectiveHarnessSlug: vi.fn(() => "papercup"),
    getAcceptanceRubricForPlan: vi.fn(async () => null),
    getLatestPlanAudit: vi.fn(async () => null),
  };
});

vi.mock("./source", async (orig) => {
  const actual = await orig<typeof import("./source")>();
  return {
    ...actual,
    planHarnessesForSlugs: M.planHarnessesForSlugs,
    readPlanBySlug: M.readPlanBySlug,
  };
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
import { dispatchProjectedTool, lookupByMcpName } from "@papercusp/agent-mcp";
import { resetOperatorCacheForTests, resetCachedReadStatsForTests, __setCachedReadEnabledForTests } from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";

const ctx = (workspaceId = "ws-get-include", harnessSlug = "papercup"): never =>
  ({
    workspaceId,
    harnessSlug,
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const run = async (args: Record<string, unknown>) =>
  ((await tool.handler(args as never, ctx())) as {
    data: { results: Array<Record<string, unknown>> };
  }).data;

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.readPlanBySlug.mockClear();
  M.planHarnessesForSlugs.mockReset();
  M.planHarnessesForSlugs.mockResolvedValue(new Map());
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

describe("plans:get — `include` alias for `includeRaw`", () => {
  it("accepts `include` in the schema", () => {
    expect(tool.args.safeParse({ slug: "alpha", include: true }).success).toBe(true);
    expect(tool.args.safeParse({ slug: "alpha", include: "all" }).success).toBe(false); // boolean, not the string a caller might guess
  });

  it("EI-21913230259449717: `include:true` returns `raw` in mode:'full', same as `includeRaw:true`", async () => {
    const viaAlias = await run({ slug: "alpha", mode: "full", include: true });
    expect(viaAlias.results[0]).toMatchObject({ ok: true, raw: "slug: alpha\nfull raw bytes\n" });
  });

  it("omitting both `include` and `includeRaw` omits `raw`", async () => {
    const result = await run({ slug: "alpha", mode: "full" });
    expect(result.results[0]).not.toHaveProperty("raw");
  });

  it("an explicit `includeRaw` wins when both `include` and `includeRaw` are supplied", async () => {
    const result = await run({ slug: "alpha", mode: "full", include: true, includeRaw: false });
    expect(result.results[0]).not.toHaveProperty("raw");
  });

  it("`include:true` and `includeRaw:true` for the same slug share ONE cache entry", async () => {
    await run({ slug: "alpha", mode: "full", include: true });
    await run({ slug: "alpha", mode: "full", includeRaw: true });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(1);
  });
});

describe("plans:get — `detail` compatibility alias (EI-21905561475819210)", () => {
  it("accepts boolean and summary/full spellings, while rejecting unrelated values", () => {
    expect(tool.args.safeParse({ slug: "alpha", detail: true }).success).toBe(true);
    expect(tool.args.safeParse({ slug: "alpha", detail: false }).success).toBe(true);
    expect(tool.args.safeParse({ slug: "alpha", detail: "full" }).success).toBe(true);
    expect(tool.args.safeParse({ slug: "alpha", detail: "summary" }).success).toBe(true);
    expect(tool.args.safeParse({ slug: "alpha", detail: "all" }).success).toBe(false);
  });

  it("maps detail:true/full to the full payload and false/summary to default sections", async () => {
    const full = await run({ slug: "alpha", detail: true });
    expect(full.results[0]).toMatchObject({ ok: true, prose: "## Now\nbody\n" });

    const summary = await run({ slug: "beta", detail: false });
    expect(summary.results[0]).not.toHaveProperty("prose");

    const fullString = await run({ slug: "gamma", detail: "full" });
    expect(fullString.results[0]).toMatchObject({ ok: true, prose: "## Now\nbody\n" });

    const summaryString = await run({ slug: "delta", detail: "summary" });
    expect(summaryString.results[0]).not.toHaveProperty("prose");
  });

  it("explicit mode wins over detail and projected dispatch accepts detail:true", async () => {
    const meta = await run({ slug: "alpha", mode: "meta", detail: true });
    expect(meta.results[0]).not.toHaveProperty("prose");

    const projected = lookupByMcpName("plans:get");
    expect(projected, "plans:get must be registered").toBeTruthy();
    const dispatched = await dispatchProjectedTool(
      projected!,
      "plans:get",
      { slug: "projected-detail", detail: true },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: "ws-get-include",
        harnessSlug: "papercup",
        runId: "plans-get-detail-dispatch",
        role: "su",
        gateBypass: { role: true, capability: true, quota: true },
        transport: "mcp",
        requestedFormat: "json",
        requestedStructured: true,
      } as never,
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(dispatched.result?.structuredContent).toMatchObject({ ok: true });
    // The projected serializer may canonicalize a bare Markdown line while
    // preserving the full body; the contract under test is that detail:true
    // reaches the full-payload branch through the real dispatch path.
    expect(
      (
        dispatched.result?.structuredContent as
          | { results?: Array<{ prose?: unknown }> }
          | undefined
      )?.results?.[0]?.prose,
    ).toEqual(expect.stringContaining("body"));
  });

  it("normalizes detail:true and mode:'full' to one cache entry", async () => {
    await run({ slug: "cached-detail", detail: true });
    await run({ slug: "cached-detail", mode: "full" });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(1);
  });
});
