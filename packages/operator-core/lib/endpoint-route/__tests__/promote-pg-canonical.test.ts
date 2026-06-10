/**
 * Audit P-077 — the phase-promotion cluster is PG-canonical:
 *
 *   - POST /harness/:slug/promote records the pending review ONLY in
 *     `harness_shared.pending_reviews` (the pre-P-077 worktree JSON write is
 *     gone — that was the storage-policy "PG mirror with file primary"
 *     anti-pattern).
 *   - POST /harness/:slug/promote/:id/confirm looks the promotion up in PG,
 *     resolves it in PG, and touches the FS only to overwrite a LEGACY
 *     pre-P-077 JSON in place (never creates one).
 *
 * Harness mirrors destructive-public-routes.test.ts: registerRoute →
 * throwaway Hono app → app.request(); all side-effecting deps mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── side-effect mocks ────────────────────────────────────────────────────────
const writeFile = vi.fn(async () => {});
const appendFile = vi.fn(async () => {});
const existsSync = vi.fn((_p: string) => true);
vi.mock('node:fs', () => ({ existsSync: (p: string) => existsSync(p) }));
vi.mock('node:fs/promises', () => ({
  writeFile: (...a: unknown[]) => writeFile(...(a as [])),
  appendFile: (...a: unknown[]) => appendFile(...(a as [])),
  mkdir: vi.fn(async () => {}),
}));
const execFileSync = vi.fn(() => 'deadbeef\n');
vi.mock('node:child_process', () => ({
  execFileSync: (...a: unknown[]) => execFileSync(...(a as [])),
}));

vi.mock('../../harness-core', () => ({
  resolvePhasedProject: vi.fn(async (slug: string) => ({ slug, path: '/proj', name: slug })),
  safeRead: vi.fn(() => null),
  parseFeatures: vi.fn(async () => []),
  harnessDir: (p: { path: string }) => `${p.path}/.papercusp`,
}));
vi.mock('../../harness-phases', () => ({
  ALL_PHASES: ['staging', 'testing', 'production'],
  phasePath: (_p: unknown, phase: string) => `/wt/${phase}`,
  phasePhaseLabel: (s?: string) => s ?? 'staging',
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../harness-effective-config', () => ({
  readEffectiveHarnessConfig: vi.fn(async () => ({})),
}));
const notifySyncInvalidate = vi.fn();
vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: (...a: unknown[]) => notifySyncInvalidate(...(a as [])),
}));
vi.mock('../../papercusp-root', () => ({ papercuspPath: (...p: string[]) => `/pc/${p.join('/')}` }));

// ── fake drizzle db (tables + and/eq stay REAL — fakeDb ignores filters) ────
const inserted: Array<{ table: unknown; values: unknown }> = [];
const updated: Array<{ set: unknown }> = [];
let selectRows: unknown[] = [];

function fakeDb() {
  return {
    insert: (table: unknown) => ({
      values: (v: unknown) => {
        inserted.push({ table, values: v });
        const done = Promise.resolve();
        return Object.assign(done, {
          onConflictDoUpdate: () => Promise.resolve(),
          onConflictDoNothing: () => Promise.resolve(),
        });
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectRows,
          orderBy: () => ({ limit: async () => selectRows }),
        }),
      }),
    }),
    update: () => ({
      set: (s: unknown) => ({
        where: async () => {
          updated.push({ set: s });
        },
      }),
    }),
  };
}
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ db: fakeDb() }) };
});

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import { generated } from '@papercusp/db-org';
import promoteRoutes from '../routes/harness/promote';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;
const [promote, confirmPromotion] = promoteRoutes as AnyRoute[];

function appWith(def: AnyRoute): Hono {
  const app = new Hono();
  registerRoute(app, def);
  return app;
}
const post = (path: string, b: unknown = {}) => [
  path,
  { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  updated.length = 0;
  selectRows = [];
  existsSync.mockImplementation(() => true);
});

describe('POST /harness/:slug/promote — PG-only pending review (P-077)', () => {
  it('inserts the review into PG and writes NO worktree JSON', async () => {
    // infra-contract / legacy files irrelevant here; worktrees must exist.
    const res = await appWith(promote)
      .request(...post('/harness/h/promote', { from: 'staging', to: 'testing' }));
    expect(res.status).toBe(200);

    const reviewInserts = inserted.filter(
      (i) => i.table === generated.pendingReviewsInHarnessShared,
    );
    expect(reviewInserts).toHaveLength(1);
    expect(reviewInserts[0].values).toMatchObject({
      harnessSlug: 'h', phase: 'staging', kind: 'promotion', resolved: false,
    });
    expect(notifySyncInvalidate).toHaveBeenCalledWith(
      'pendingReviews.byHarness', { harnessSlug: 'h' },
    );
    // The dual-write is gone: nothing lands under pending-reviews/.
    for (const call of writeFile.mock.calls as unknown as [string][]) {
      expect(String(call[0])).not.toContain('pending-reviews');
    }
    // supervisor-notes append (agent-facing doc) still happens.
    expect(appendFile).toHaveBeenCalled();
  });
});

describe('POST /harness/:slug/promote/:id/confirm — PG lookup + PG resolve (P-077)', () => {
  const pgRow = (overrides: Record<string, unknown> = {}) => ({
    payload: {
      id: 'promotion-1-staging-to-testing', kind: 'promotion',
      from: 'staging', to: 'testing', resolved: false,
      ...overrides,
    },
    phase: 'staging',
    resolved: false,
  });

  it('404s when PG has no such promotion', async () => {
    selectRows = [];
    const res = await appWith(confirmPromotion)
      .request(...post('/harness/h/promote/promotion-x/confirm'));
    expect(res.status).toBe(404);
  });

  it('409s when the PG row is already resolved', async () => {
    const row = pgRow();
    row.resolved = true;
    selectRows = [row];
    const res = await appWith(confirmPromotion)
      .request(...post('/harness/h/promote/promotion-1-staging-to-testing/confirm'));
    expect(res.status).toBe(409);
  });

  it('merges, records the promotion, and resolves in PG; no legacy file → no write', async () => {
    selectRows = [pgRow()];
    // No infra-contract (smoke off) and no legacy JSON anywhere.
    existsSync.mockImplementation(() => false);

    const res = await appWith(confirmPromotion)
      .request(...post('/harness/h/promote/promotion-1-staging-to-testing/confirm'));
    expect(res.status).toBe(200);

    // git fetch + ff-merge against the destination worktree
    const gitCalls = execFileSync.mock.calls.map((c) => (c as unknown[])[1] as string[]);
    expect(gitCalls.some((a) => a.includes('fetch'))).toBe(true);
    expect(gitCalls.some((a) => a.includes('merge'))).toBe(true);

    // promotion recorded + review resolved in PG
    expect(
      inserted.some((i) => i.table === generated.harnessPromotionsInHarnessShared),
    ).toBe(true);
    expect(updated).toHaveLength(1);
    expect(updated[0].set).toMatchObject({ resolved: true });
    expect(notifySyncInvalidate).toHaveBeenCalledWith(
      'pendingReviews.byHarness', { harnessSlug: 'h' },
    );
    // PG-canonical: no file writes for the review itself
    for (const call of writeFile.mock.calls as unknown as [string][]) {
      expect(String(call[0])).not.toContain('pending-reviews');
    }
  });

  it('overwrites a LEGACY pre-P-077 JSON in place when one exists', async () => {
    selectRows = [pgRow()];
    existsSync.mockImplementation((p: string) =>
      // only the staging legacy file exists; infra-contract stays absent
      p === '/wt/staging/.papercusp/pending-reviews/promotion-1-staging-to-testing.json'
      || p.startsWith('/wt/'),
    );

    const res = await appWith(confirmPromotion)
      .request(...post('/harness/h/promote/promotion-1-staging-to-testing/confirm'));
    expect(res.status).toBe(200);

    const legacyWrites = (writeFile.mock.calls as unknown as [string, string][])
      .filter(([p]) => String(p).includes('pending-reviews'));
    expect(legacyWrites).toHaveLength(1);
    expect(JSON.parse(legacyWrites[0][1])).toMatchObject({ resolved: true, status: 'promoted' });
  });
});
