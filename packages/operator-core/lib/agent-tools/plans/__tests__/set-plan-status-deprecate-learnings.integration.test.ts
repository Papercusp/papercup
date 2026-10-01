/**
 * set-plan-status-deprecate-learnings.integration.test.ts — the Queen↔Scout
 * deprecate→learnings observation, end-to-end through the REAL handler + PG
 * (queen-scout-feedback-loop-2026-06-20 P-006 / brief B10).
 *
 * Proves the loop-closing property the pure deprecate-learnings.test.ts can't:
 * a `status:'superseded'` set carrying `learnings` ACTUALLY (a) supersedes the
 * draft AND (b) lands a structured, source-tagged learnings observation in
 * engineer_issues that the digest's READ seam (readObservationItems) surfaces —
 * so a dead draft re-enters Scout's corpus-digest (no dead ends, D-002).
 *
 * Drives the REAL setPlanStatusTool.handler through Postgres via withPlanLock +
 * captureImprovement → createIssue, on the shared baseline-schema fixture.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/set-plan-status-deprecate-learnings.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import setPlanStatusTool from '../set-plan-status';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { readObservationItems } from '../../../harness/improvements/read-items';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-sps-deprec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'zzz-sps-deprec-plan-2026-06-20';
const WS = DEFAULT_WORKSPACE_ID;

const LEARNINGS = {
  tried: 'A heuristic clustered CI retry lines into a per-test flake score.',
  stalled: 'No ground-truth labels existed to calibrate the score, so it never beat a coin flip.',
  salvageable: 'The retry-marker parser is reusable; the scoring premise is not.',
};

function planBody(status: 'draft' | 'ready' | 'superseded' | 'shipped'): string {
  return `---
title: Deprecate Learnings Plan
slug: ${SLUG}
created: 2026-06-20
updated: 2026-06-20
status: ${status}
---

# Deprecate Learnings Plan

## Now

**State:** Where things stand.

**Next:** The next concrete action.

## Background

Some prose.

## Decisions
`;
}

/** ctx for the handler — `role` drives the derived deprecate attribution. */
function makeCtx(role?: string) {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    ...(role ? { role } : {}),
    principal: { kind: 'agent', slug: 'agent-deprec-test', workspaceId: WS },
  } as never;
}

async function runDeprecate(
  args: Record<string, unknown>,
  role?: string,
): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const res = (await setPlanStatusTool.handler(
    { harness: HARNESS, slug: SLUG, ...args } as never,
    makeCtx(role),
  )) as { data: { results: Record<string, unknown>[]; counts?: { failed?: number } } };
  // Bulk-pattern envelope: per-slug result at data.results[0]; failure ⇒ counts.failed > 0.
  return { data: res.data.results[0], isError: (res.data.counts?.failed ?? 0) > 0 };
}

/** The raw observation rows for this harness scope (admin bypasses RLS). */
async function observationRows(): Promise<
  Array<{ title: string; kind: string; scope: string; payload: Record<string, unknown> }>
> {
  return admin<Array<{ title: string; kind: string; scope: string; payload: Record<string, unknown> }>>`
    SELECT title, kind, scope, payload
      FROM harness_shared.engineer_issues
     WHERE scope = ${'harness:' + HARNESS}
       AND payload->>'lane' = 'observation'
     ORDER BY created_at DESC`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 60_000);

afterAll(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  // Observations live in engineer_issues (not harness_plans), so clean them too.
  await admin`DELETE FROM harness_shared.engineer_issues WHERE scope = ${'harness:' + HARNESS}`.catch(() => {});
});

describe('plans:set-plan-status — deprecate emits a learnings observation (B10)', () => {
  it('superseded + learnings: supersedes AND lands a source-tagged observation the digest reads', async () => {
    await seedPlan(admin, WS, HARNESS, SLUG, planBody('draft'));

    const { data, isError } = await runDeprecate(
      { status: 'superseded', learnings: LEARNINGS, evidence: ['wi:WI-42'] },
      'mug', // → deprecatedBy 'Queen'
    );

    // (a) the supersede happened.
    expect(isError).toBe(false);
    expect(data).toMatchObject({ ok: true, changed: true, newStatus: 'superseded' });
    // (b) the handler reports the emitted observation.
    expect(data.learningsObservation).toMatchObject({ emitted: true, created: true });
    expect((data.learningsObservation as { issueId?: string }).issueId).toBeTruthy();

    // (c) the durable row: source-tagged scope + camelCase payload.observation.sourceHive
    //     (converges with B1's structured-observation v2 schema).
    const rows = await observationRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe('change');
    expect(row.scope).toBe(`harness:${HARNESS}`);
    expect(row.title).toContain('Deprecated draft');
    const obs = row.payload.observation as Record<string, unknown>;
    expect(obs.sourceHive).toBe(HARNESS); // camelCase
    expect(obs.kind).toBe('gap');
    expect(Array.isArray(obs.refs) && (obs.refs as string[]).includes(`plan:${SLUG}`)).toBe(true);
    const meta = row.payload.deprecateLearnings as Record<string, unknown>;
    expect(meta.planSlug).toBe(SLUG);
    expect(meta.deprecatedBy).toBe('Queen');
    expect(meta.salvageable).toBe(LEARNINGS.salvageable);

    // (d) the loop CLOSES: the observation is readable through the SAME seam the
    //     Scout corpus-digest unions into its friction lane (corpus-digest-deps).
    const candidates = await readObservationItems({ harnessSlug: HARNESS });
    const found = candidates.find((c) => c.title.includes('Deprecated draft'));
    expect(found).toBeTruthy();
    expect(found?.scope).toBe(`harness:${HARNESS}`);
    expect(found?.body).toContain(LEARNINGS.salvageable);
  });

  it('an explicit sourceHive overrides the harness for the source-tag', async () => {
    await seedPlan(admin, WS, HARNESS, SLUG, planBody('draft'));

    const { data } = await runDeprecate({
      status: 'superseded',
      learnings: LEARNINGS,
      sourceHive: 'some-other-hive',
    });
    expect(data.learningsObservation).toMatchObject({ emitted: true });

    // The observation is scoped to the explicit source hive, not HARNESS.
    const rows = await admin<Array<{ scope: string; payload: Record<string, unknown> }>>`
      SELECT scope, payload FROM harness_shared.engineer_issues
       WHERE scope = ${'harness:some-other-hive'} AND payload->>'lane' = 'observation'`;
    expect(rows).toHaveLength(1);
    expect((rows[0].payload.observation as Record<string, unknown>).sourceHive).toBe('some-other-hive');
    await admin`DELETE FROM harness_shared.engineer_issues WHERE scope = 'harness:some-other-hive'`.catch(() => {});
  });

  it('a plain reject (superseded WITHOUT learnings) emits NO observation', async () => {
    await seedPlan(admin, WS, HARNESS, SLUG, planBody('draft'));

    const { data, isError } = await runDeprecate({ status: 'superseded' });
    expect(isError).toBe(false);
    expect(data).toMatchObject({ ok: true, newStatus: 'superseded' });
    expect(data.learningsObservation).toBeUndefined();
    expect(await observationRows()).toHaveLength(0);
  });

  it('learnings on a NON-superseded status (ready→draft) is ignored (deprecate-only)', async () => {
    await seedPlan(admin, WS, HARNESS, SLUG, planBody('ready'));
    await admin`
      UPDATE harness_shared.harness_plans SET status = 'ready'
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;

    const { data, isError } = await runDeprecate({ status: 'draft', learnings: LEARNINGS });
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data).toMatchObject({ ok: true, newStatus: 'draft' });
    expect(data.learningsObservation).toBeUndefined();
    expect(await observationRows()).toHaveLength(0);
  });
});
