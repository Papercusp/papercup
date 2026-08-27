/**
 * Real-PG proof that a structured plan writer cannot bypass the dependency
 * candidate verdict in withPlanLock. The exercised handler intentionally does
 * no whole-document lint of its own: plans:set-item-blocked-by surgically
 * rewrites one item line, making it the regression shape for the central seam.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import setItemBlockedByTool from '../set-item-blocked-by';
import {
  cleanupPlans,
  seedPlan,
  setupPlanPgFixture,
  type PlanPgFixture,
} from './_pg-tool-fixture';

const HARNESS = `zzz-candidate-deps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'candidate-dependency-structured-writer';

let fx: PlanPgFixture;
let admin: postgres.Sql;
let wsId: string;

function planBody(
  status: 'draft' | 'ready' | 'active',
  opts: { p1BlockedBy?: string[]; p2BlockedBy?: string[] } = {},
): string {
  const blockedBy = (refs: string[] | undefined) =>
    refs?.length ? ` blocked-by: ${refs.join(', ')}` : '';
  return `---
title: candidate dependency structured writer
slug: ${SLUG}
status: ${status}
created: 2026-08-27
updated: 2026-08-27
---

# candidate dependency structured writer

## Phase 1

- **P-001** \`todo\` first${blockedBy(opts.p1BlockedBy)}
- **P-002** \`todo\` second${blockedBy(opts.p2BlockedBy)}
`;
}

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: wsId,
    principal: { kind: 'agent', slug: 'agent-candidate-dependency-test', workspaceId: wsId },
  } as never;
}

async function runSetBlockedBy(item: string, blockedBy: string[]) {
  const response = (await setItemBlockedByTool.handler(
    { harness: HARNESS, slug: SLUG, item, blockedBy } as never,
    makeCtx(),
  )) as {
    data: {
      counts: { ok: number; failed: number };
      results: Array<Record<string, unknown>>;
    };
  };
  return {
    result: response.data.results[0]!,
    counts: response.data.counts,
  };
}

async function livePlan(): Promise<{ content: string; version: number }> {
  const rows = await admin<Array<{ content: string; version: number }>>`
    SELECT content, version
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return rows[0]!;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  wsId = fx.workspaceId;
}, 90_000);

beforeEach(async () => {
  await cleanupPlans(admin, wsId, HARNESS);
});

afterAll(async () => {
  await cleanupPlans(admin, wsId, HARNESS).catch(() => {});
  await fx?.dispose();
});

describe('withPlanLock candidate dependency admission — structured writer', () => {
  it('allows a draft forward ref, writes it, and surfaces invalid-draft evidence on the tool value', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('draft'));

    const { result, counts } = await runSetBlockedBy('P-001', ['P-099']);

    expect(counts).toEqual({ ok: 1, failed: 0 });
    expect(result).toMatchObject({
      ok: true,
      itemId: 'P-001',
      to: ['P-099'],
      dependencyDiagnostics: [
        {
          code: 'dependency_endpoint_missing',
          disposition: 'invalid-draft',
          itemId: 'P-001',
          ref: 'P-099',
          path: ['P-001', 'P-099'],
        },
      ],
    });
    expect((await livePlan()).content).toContain('P-001** `todo` first blocked-by: P-099');
  }, 60_000);

  it.each(['ready', 'active'] as const)(
    'rejects a dangling ref in an already-%s plan before the structured write lands',
    async (status) => {
      const seeded = planBody(status);
      await seedPlan(admin, wsId, HARNESS, SLUG, seeded);
      const before = await livePlan();

      const { result, counts } = await runSetBlockedBy('P-001', ['P-099']);

      expect(counts).toEqual({ ok: 0, failed: 1 });
      expect(result).toMatchObject({
        ok: false,
        itemId: 'P-001',
        error: 'invalid_plan_dependencies',
      });
      expect(await livePlan()).toEqual(before);
    },
    60_000,
  );

  it('uses locked op_status truth: a frontmatter draft already started cannot gain a dangling ref', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('draft'));
    await admin`
      UPDATE harness_shared.harness_plans
         SET op_status = 'started'
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    const before = await livePlan();

    const { result, counts } = await runSetBlockedBy('P-001', ['P-099']);

    expect(counts).toEqual({ ok: 0, failed: 1 });
    expect(result).toMatchObject({ ok: false, error: 'invalid_plan_dependencies' });
    expect(await livePlan()).toEqual(before);
  }, 60_000);

  it('rejects a reciprocal cycle even in a draft and leaves the prior DAG intact', async () => {
    await seedPlan(
      admin,
      wsId,
      HARNESS,
      SLUG,
      planBody('draft', { p2BlockedBy: ['P-001'] }),
    );
    const before = await livePlan();

    const { result, counts } = await runSetBlockedBy('P-001', ['P-002']);

    expect(counts).toEqual({ ok: 0, failed: 1 });
    expect(result).toMatchObject({ ok: false, error: 'invalid_plan_dependencies' });
    expect(await livePlan()).toEqual(before);
  }, 60_000);
});
