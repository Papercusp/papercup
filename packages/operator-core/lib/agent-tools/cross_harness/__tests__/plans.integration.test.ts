/**
 * cross_harness:plans_* tool wrapper tests — PG-backed (P-013 of
 * per-harness-plans-and-docs-2026-05-23, migrated for plans-pg-canonical-
 * migration-2026-06-03).
 *
 * Covers the operator-side glue: per-harness resolution (registry validation),
 * unknown-slug error envelope, workspaceId passthrough, and format pass-through.
 * The parsing/search engine is exercised by plans/__tests__/*; these tests
 * verify the routing.
 *
 * Plans now live in `harness_shared.harness_plans`, not on disk — so the harness
 * is still resolved via the (mocked) registry, but the plan CONTENT is seeded
 * into PG and the tools read it back through the real PG source. Runs against
 * the integration-tier baseline schema DB via the shared plans fixture and
 * cleans up its throwaway rows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  setupPlanPgFixture,
  cleanupPlans,
  seedPlan,
  type PlanPgFixture,
} from '../../plans/__tests__/_pg-tool-fixture';

// A throwaway harness slug, registered via the mock + seeded in PG.
const HARNESS = `zzz-xh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PLAN_SLUG = 'zzz-sheets-feature-x-2026-05-24';

const PLAN_BODY = `---
title: Sheets feature X
slug: ${PLAN_SLUG}
status: active
created: 2026-05-24
updated: 2026-05-24
owner: someone@example.com
---

## Now

**State:** kickoff
**Next:** finish phase 1

## Phase 1 — kickoff

- **P-001** \`todo\` Build the thing.
`;

let fx: PlanPgFixture;
let admin: postgres.Sql;
let wsId: string;

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    metadata: vi.fn(),
    workspaceId: 'default',
    role: 'operator' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  }) as never;

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

function mockRegistry(projects: Array<{ slug: string; path: string }>) {
  vi.doMock('../../../harness-registry', () => ({
    loadHarnessRegistry: vi.fn(async () => ({ projects })),
  }));
}

function mockPapercupDetection(detected: string | null) {
  vi.doMock('../../../harness/register-papercusp', () => ({
    LEGACY_STANDALONE_HARNESS_SLUG: 'papercup',
    detectPapercupRoot: vi.fn(() => detected),
  }));
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  wsId = fx.workspaceId;
}, 60_000);

beforeEach(async () => {
  // The harness lives only in the mocked registry; its plan content lives in PG.
  await seedPlan(admin, wsId, HARNESS, PLAN_SLUG, PLAN_BODY);
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock('../../../harness-registry');
  vi.doUnmock('../../../harness/register-papercusp');
  await cleanupPlans(admin, wsId, HARNESS);
});

afterAll(async () => {
  await fx?.dispose();
});

describe('cross_harness:plans_list', () => {
  it('throws when the harness is not registered', async () => {
    mockRegistry([]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_list')).default;
    await expect(tool.handler({ harnessSlug: 'missing' }, MAKE_CTX())).rejects.toThrow(
      /harness 'missing' not registered/,
    );
  });

  it('lists plans for a registered harness (read from PG)', async () => {
    mockRegistry([{ slug: HARNESS, path: '/tmp/whatever' }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_list')).default;
    const result = await tool.handler({ harnessSlug: HARNESS }, MAKE_CTX());
    const payload = parsePayload(result);
    expect(payload.harnessSlug).toBe(HARNESS);
    const plans = payload.plans as Array<{ slug: string; title: string }>;
    expect(plans).toHaveLength(1);
    expect(plans[0].slug).toBe(PLAN_SLUG);
    expect(plans[0].title).toBe('Sheets feature X');
  });

  it('forwards workspaceId to loadHarnessRegistry', async () => {
    const reg = vi.fn(async () => ({ projects: [{ slug: HARNESS, path: '/tmp/whatever' }] }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: reg }));
    mockPapercupDetection(null);
    const tool = (await import('../plans_list')).default;
    await tool.handler({ harnessSlug: HARNESS, workspaceId: 'default' }, MAKE_CTX());
    expect(reg).toHaveBeenCalledWith('default');
  });
});

describe('cross_harness:plans_get', () => {
  it('returns not_found when the plan slug is unknown', async () => {
    mockRegistry([{ slug: HARNESS, path: '/tmp/whatever' }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_get')).default;
    const result = await tool.handler(
      { harnessSlug: HARNESS, slug: 'does-not-exist' },
      MAKE_CTX(),
    );
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toBe('not_found');
    expect(payload.harnessSlug).toBe(HARNESS);
  });

  it('returns the parsed plan when slug is known (read from PG)', async () => {
    mockRegistry([{ slug: HARNESS, path: '/tmp/whatever' }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_get')).default;
    const result = await tool.handler(
      { harnessSlug: HARNESS, slug: PLAN_SLUG },
      MAKE_CTX(),
    );
    const payload = parsePayload(result);
    expect(payload.harnessSlug).toBe(HARNESS);
    expect(payload.legacy).toBe(false);
    const frontmatter = payload.frontmatter as { title: string };
    expect(frontmatter.title).toBe('Sheets feature X');
    const items = payload.items as Array<{ id: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('P-001');
  });
});

describe('cross_harness:plans_search', () => {
  it('finds the plan by title keyword', async () => {
    mockRegistry([{ slug: HARNESS, path: '/tmp/whatever' }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_search')).default;
    const result = await tool.handler({ harnessSlug: HARNESS, query: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result);
    expect(payload.harnessSlug).toBe(HARNESS);
    const hits = payload.hits as Array<{ plan: string; score: number }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].plan).toBe(PLAN_SLUG);
  });

  it('finds by item-text keyword', async () => {
    mockRegistry([{ slug: HARNESS, path: '/tmp/whatever' }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_search')).default;
    const result = await tool.handler(
      { harnessSlug: HARNESS, query: 'thing', scope: ['items'] },
      MAKE_CTX(),
    );
    const payload = parsePayload(result);
    const hits = payload.hits as Array<{ plan: string; matches: Array<{ scope: string }> }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].matches[0].scope).toBe('items');
  });

  it('empty query → empty hits', async () => {
    mockRegistry([{ slug: HARNESS, path: '/tmp/whatever' }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_search')).default;
    const result = await tool.handler({ harnessSlug: HARNESS, query: '   ' }, MAKE_CTX());
    const payload = parsePayload(result);
    expect(payload.hits).toEqual([]);
  });
});
