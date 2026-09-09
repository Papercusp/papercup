/**
 * plans:list — status + limit combined must not silently under-return
 * (EI-19932192274787948).
 *
 * `status` (and `includeLegacy:false`) are filtered in JS AFTER the source
 * fetch (list.ts's per-row loop) — the DB `status` column can be NULL for a
 * legacy plan, which JS treats as "draft" but a SQL `status = $1` predicate
 * cannot match, so list.ts never pushes `status` into the SQL WHERE clause.
 * `limit`, however, USED to be pushed into the SQL fetch unconditionally
 * (skipped only for `groupBy`) — so it bounded the PRE-status-filter row
 * window (every status), and the JS status filter then whittled that window
 * down. A caller passing a generous `limit` to avoid truncation got a
 * well-formed, plausible, WRONG "complete" answer with no truncation flag.
 *
 * Drives the REAL handler against a mocked source layer (mirrors
 * list.cache.test.ts's harness) whose mock `listPlanIndexRows` faithfully
 * emulates the real SQL: it applies LIMIT to the full row set BEFORE any
 * status filtering (there is none in the mock — matching the real query,
 * where `status` is never passed down for this exact reason).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  listPlanIndexRows: vi.fn(async (opts: { limit?: number }) => [] as unknown[]),
  listPlanIndexRowsForWorkspace: vi.fn(async () => [] as unknown[]),
  getPlanContentsBySlugs: vi.fn(async () => new Map<string, string>()),
  resolveHarnessPlansDir: vi.fn(async (slug: string) => ({ harnessSlug: slug })),
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

const ctx = () => {
  const metadata = vi.fn();
  return { obj: { workspaceId: "ws-status-limit", harnessSlug: "papercup", metadata, log: vi.fn(), progress: vi.fn() } as never, metadata };
};

const run = async (args: Record<string, unknown>) => {
  const { obj, metadata } = ctx();
  const res = (await tool.handler(args as never, obj)) as {
    data: { plans: { slug: string; status: string }[]; truncated?: boolean };
  };
  return { plans: res.data.plans, truncated: res.data.truncated, metadata };
};

/** A minimal-but-complete fixture row — every field list.ts's per-row loop reads. */
function makeRow(slug: string, status: string, isLegacy = false): Record<string, unknown> {
  return {
    workspaceId: "ws-status-limit",
    harnessSlug: "papercup",
    planSlug: slug,
    title: slug,
    status,
    created: "2026-08-01T00:00:00.000Z",
    updated: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    owner: null,
    initiative: null,
    template: null,
    archived: false,
    isLegacy,
    items: [],
    nowNext: null,
    opStatus: null,
    opPriority: null,
    schedule: null,
    scheduleActive: false,
    scheduledAt: null,
  };
}

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(false); // isolate the fetch/filter contract from caching
  M.listPlanIndexRows.mockClear();
});

describe("plans:list — status + limit combined (EI-19932192274787948)", () => {
  // 8 'shipped' plans FIRST, then 4 'active' plans — arranged so a naive
  // pre-status-filter LIMIT window (the bug) grabs only shipped rows and
  // silently reports zero/few active matches.
  const SHIPPED = Array.from({ length: 8 }, (_, i) => makeRow(`shipped-${i}`, "shipped"));
  const ACTIVE = Array.from({ length: 4 }, (_, i) => makeRow(`active-${i}`, "active"));
  const ALL_ROWS = [...SHIPPED, ...ACTIVE];

  beforeEach(() => {
    M.listPlanIndexRows.mockImplementation(async (opts: { limit?: number }) =>
      typeof opts?.limit === "number" ? ALL_ROWS.slice(0, opts.limit) : ALL_ROWS,
    );
  });

  it("a limit LARGER than the total row count but not pushed for status still returns every true match", async () => {
    // limit:5 sits between the true match count (4 active) and the total row
    // count (12) — exactly the "far larger than the true match count" shape
    // from the bug report, reproduced against a small fixture.
    const { plans } = await run({ status: "active", limit: 5 });
    expect(plans).toHaveLength(4);
    expect(plans.map((p) => p.slug).sort()).toEqual(["active-0", "active-1", "active-2", "active-3"]);
  });

  it("recurrence guard: status+limit returns the SAME count as status alone when limit exceeds the true match count", async () => {
    const withLimit = await run({ status: "active", limit: 500 });
    const noLimit = await run({ status: "active" });
    expect(withLimit.plans).toHaveLength(noLimit.plans.length);
    expect(withLimit.plans).toHaveLength(4);
  });

  it("does NOT push `limit` into the SQL fetch when `status` is set (the actual fix)", async () => {
    await run({ status: "active", limit: 5 });
    const calls = M.listPlanIndexRows.mock.calls as Array<[{ limit?: number }]>;
    expect(calls.length).toBeGreaterThan(0);
    for (const [opts] of calls) expect(opts.limit).toBeUndefined();
  });

  it("a limit SMALLER than the true match count still caps the result and reports truncated:true", async () => {
    const { plans, truncated, metadata } = await run({ status: "active", limit: 2 });
    expect(plans).toHaveLength(2);
    expect(truncated).toBe(true);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ truncated: true }));
  });

  it("no limit clamp when the match count fits — truncated is omitted, not false", async () => {
    const { plans, truncated } = await run({ status: "active", limit: 500 });
    expect(plans).toHaveLength(4);
    expect(truncated).toBeUndefined();
  });

  it("without a status filter, limit is still pushed into SQL (unaffected fast path)", async () => {
    await run({ limit: 3 });
    const calls = M.listPlanIndexRows.mock.calls as Array<[{ limit?: number }]>;
    expect(calls[calls.length - 1][0].limit).toBe(3);
  });

  it("includeFinished:false removes only shipped/superseded rows and preserves API default compatibility", async () => {
    const defaultResult = await run({});
    expect(defaultResult.plans).toHaveLength(12);
    const activeResult = await run({ includeFinished: false });
    expect(activeResult.plans.map((p) => p.slug).sort()).toEqual([
      "active-0",
      "active-1",
      "active-2",
      "active-3",
    ]);
    const calls = M.listPlanIndexRows.mock.calls as Array<[{ limit?: number }]>;
    for (const [opts] of calls) expect(opts.limit).toBeUndefined();
  });

  // Same defect class the bug report calls out generically: any OTHER
  // JS-side post-filter combined with limit is exposed to the identical bug.
  // includeLegacy:false is the other JS-side post-filter list.ts applies.
  it("includeLegacy:false + limit also returns the true match count (same defect class)", async () => {
    const LEGACY = Array.from({ length: 6 }, (_, i) => makeRow(`legacy-${i}`, "draft", true));
    const REAL = Array.from({ length: 3 }, (_, i) => makeRow(`real-${i}`, "draft", false));
    M.listPlanIndexRows.mockImplementation(async (opts: { limit?: number }) => {
      const rows = [...LEGACY, ...REAL];
      return typeof opts?.limit === "number" ? rows.slice(0, opts.limit) : rows;
    });
    const { plans } = await run({ includeLegacy: false, limit: 4 });
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.slug).sort()).toEqual(["real-0", "real-1", "real-2"]);
  });
});
