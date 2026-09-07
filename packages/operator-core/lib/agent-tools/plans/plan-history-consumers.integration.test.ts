/**
 * P-008 real-PostgreSQL proof for bounded plan-history delivery.
 *
 * One canonical plan row and one descendant checkpoint are read through the
 * actual production consumers: plans:get (including exact raw-ref recovery),
 * the launch context bundle, and the complete fleet leader-brief builder.  The
 * baseline-schema fixture keeps every store real while unique ids isolate this
 * suite from concurrent integration files.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { workItemCheckpointScope, setWorkItemCheckpoint } from '../../work-item-checkpoint';
import { DEFAULT_CLAIM_SPEC } from '../../scheduler/claim-spec';
import { fleetSpecBeeKey, setClaimSpec } from '../../scheduler/claim-spec-store';
import { buildLeaderBrief } from '../fleet/leader-brief';
import plansGetTool from './get';
import { buildPlanContextBundle } from './context-bundle';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './__tests__/_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-plan-history-${RUN}`;
const PLAN = `plan-history-consumers-${RUN}`;
const CHILD = `WI-plan-history-${RUN}`;
const FLEET = `plan-history-fleet-${RUN}`;
const CHILD_LESSON =
  'Outcome: the descendant repair shipped. Root cause: the delivery cursor advanced before projection. Residue: preserve the exact recovery reference.';

const PLAN_CONTENT = `---
title: Plan history consumer integration
status: active
---

# Plan history consumer integration

## Now

State: proving production history consumers.

Next: retain the descendant lesson in every leader-facing sink.

## Work

- **P-001** \`todo\` — Exercise bounded descendant history.

## Decisions

### D-001 — Preserve the current correction

Date: 2026-09-07

The plan's own authority remains current while child evidence contributes learned history.
`;

const CTX = {
  isSuperuser: true,
  uiClientId: 'su-plan-history-consumer-integration',
  workspaceId: 'default',
  harnessSlug: HARNESS,
  metadata: vi.fn(),
  log: vi.fn(),
  progress: vi.fn(),
} as never;

let fx: PlanPgFixture;
let admin: postgres.Sql;
let previousWorkspaceId: string | undefined;

beforeAll(async () => {
  previousWorkspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  process.env.PAPERCUSP_WORKSPACE_ID = fx.workspaceId;

  await seedPlan(admin, fx.workspaceId, HARNESS, PLAN, PLAN_CONTENT);
  await admin`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, summary, status,
       source_plan_slug, source_plan_item_ids, payload, last_progress_at)
    VALUES
      (${fx.workspaceId}, ${HARNESS}, ${CHILD}, 'bug', 'Descendant delivery repair',
       'A completed child with a lesson the plan must inherit.', 'open', ${PLAN}, ARRAY['P-001'],
       ${admin.json({
         plan_item: { plan_slug: PLAN, item_id: 'P-001', harness_slug: HARNESS },
       })}, now())
  `;
  await setWorkItemCheckpoint({ harness: HARNESS, workItemId: CHILD, workspaceId: fx.workspaceId }, CHILD_LESSON);

  const stored = await setClaimSpec(
    {
      cupId: fleetSpecBeeKey(FLEET),
      workspaceId: fx.workspaceId,
      updatedBy: 'su-plan-history-consumer-integration',
      spec: {
        ...DEFAULT_CLAIM_SPEC,
        specId: `${FLEET}-lane`,
        view: { filter: { field: 'plan', op: '=', value: PLAN } },
      },
    },
    admin,
  );
  expect(stored).toMatchObject({ ok: true, errors: [] });
}, 90_000);

afterAll(async () => {
  await admin`
    DELETE FROM harness_shared.carry_notes
     WHERE workspace_id = ${fx.workspaceId}
       AND scope = ${workItemCheckpointScope(HARNESS, CHILD)}
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.work_items
     WHERE workspace_id = ${fx.workspaceId}
       AND harness_slug = ${HARNESS}
       AND feature_id = ${CHILD}
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.cup_claim_specs
     WHERE workspace_id = ${fx.workspaceId}
       AND bee_id = ${fleetSpecBeeKey(FLEET)}
  `.catch(() => {});
  await cleanupPlans(admin, fx.workspaceId, HARNESS).catch(() => {});
  if (previousWorkspaceId === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = previousWorkspaceId;
  await fx?.dispose();
});

function dataOf<T>(value: unknown): T {
  return (value as { data: T }).data;
}

describe('bounded plan history production consumers', () => {
  it('delivers one stored child lesson through plans:get, launch context and the full leader builder', async () => {
    const planRead = dataOf<{ results: Array<Record<string, unknown>> }>(
      await plansGetTool.handler({ slug: PLAN, harness: HARNESS, mode: 'full' } as never, CTX),
    );
    const planResult = planRead.results[0] as {
      history: {
        status: string;
        brief: { attempts: Array<{ rawRef: string; text: string }> };
      };
    };
    expect(planResult.history.status).toBe('available');
    expect(JSON.stringify(planResult.history)).toContain(CHILD_LESSON);
    const rawRef = planResult.history.brief.attempts.find((attempt) => attempt.rawRef.startsWith(`${CHILD}#`))?.rawRef;
    expect(rawRef).toBe(`${CHILD}#checkpoint`);

    const recoveredRead = dataOf<{ results: Array<Record<string, unknown>> }>(
      await plansGetTool.handler(
        { slug: PLAN, harness: HARNESS, heading: 'History', priorAttemptRefs: [rawRef] } as never,
        CTX,
      ),
    );
    expect(JSON.stringify(recoveredRead.results[0])).toContain(CHILD_LESSON);

    const bundle = await buildPlanContextBundle(PLAN, {
      workspaceId: fx.workspaceId,
      harnessSlug: HARNESS,
    });
    expect(bundle?.history?.status).toBe('available');
    expect(bundle?.text).toContain('PLAN HISTORY — own and bounded child evidence');
    expect(bundle?.text).toContain(CHILD_LESSON);
    expect(bundle?.text).toContain(rawRef);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leader = await buildLeaderBrief(
      { fleet: FLEET, harness: HARNESS, workspace: fx.workspaceId, include_stale: true },
      {
        ownerId: 'su-plan-history-consumer-integration',
        actorWorkspace: fx.workspaceId,
        allowLeadershipWrites: false,
        resolveCallerMembership: false,
      },
    );
    const unexpectedWarnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => !message.startsWith('[bounded-timeout]'));
    warn.mockRestore();
    expect(unexpectedWarnings).toEqual([]);
    expect(leader.data).toMatchObject({ ok: true, planHistory: { status: 'available' } });
    if (!('planHistory' in leader.data) || !leader.data.planHistory) {
      throw new Error('full leader output omitted planHistory');
    }
    expect(JSON.stringify(leader.data.planHistory)).toContain(CHILD_LESSON);
    expect(JSON.stringify(leader.data.planHistory)).toContain(rawRef);
  }, 60_000);
});
