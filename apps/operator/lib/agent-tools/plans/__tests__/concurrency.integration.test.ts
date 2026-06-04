/**
 * concurrency.integration.test.ts — PG-canonical concurrency for plans:* writes.
 *
 * Plans now live in `harness_shared.harness_plans` (plans-pg-canonical-migration-
 * 2026-06-03). `withPlanLock` serializes same-plan writers with a PG advisory
 * xact lock on (workspace, harness, slug) and guards editor concurrency with an
 * optimistic version CAS — NOT the old filesystem O_EXCL lock. This test proves
 * the load-bearing invariant survives the migration:
 *
 *   Per agent-plan-tracking-2026-05-20.md §4.4 + P-206: two parallel calls that
 *   allocate IDs against the SAME plan MUST produce sequential, non-colliding
 *   IDs — the read-modify-write under the advisory lock is what makes ID
 *   allocation (D-NNN / P-NNN) race-free.
 *
 * Runs against the integration-tier baseline schema DB (the full harness_shared
 * schema applied from migrations) via the shared fixture, driving the REAL
 * withPlanLock against real Postgres. Cleans up its throwaway plan rows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { withPlanLock } from '../with-plan-lock';
import { allocateNextDecisionId, appendDecisionToBody } from '../add-decision';
import { allocateNextItemId, appendItemToBody, buildItemLine } from '../add-item';
import { getPlanRow } from '../source';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

// A throwaway harness slug so this test never collides with — or deletes — the
// real papercup plan rows. Unique per run.
const HARNESS = `zzz-conc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let fx: PlanPgFixture;
let admin: postgres.Sql;
let wsId: string;

const planBody = (slug: string) => `---
title: ${slug}
slug: ${slug}
status: active
created: 2026-05-20
updated: 2026-05-20
---

# ${slug}

## Now

**State:** test
**Next:** test

## Phase 1

- **P-001** \`done\` seed item

## Decisions

### D-001 — seed decision
Date: 2026-05-20
seed body
`;

/** Result payload for the test mutators — passed as the explicit
 *  `withPlanLock<T>` type argument so `T` is fixed, not inferred from the
 *  union-returning mutator (which TS would narrow to one branch). */
type LockTestValue = { ok: true; id: string } | { ok: false };

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  wsId = fx.workspaceId;
}, 60_000);

afterEach(async () => {
  await cleanupPlans(admin, wsId, HARNESS);
});

afterAll(async () => {
  await fx?.dispose();
});

describe('plans:* concurrent ID allocation (PG advisory lock + version CAS)', () => {
  it('two parallel add-decision calls produce sequential non-colliding D-NNN', async () => {
    const slug = `zzz-conc-decisions-${Math.random().toString(36).slice(2, 8)}`;
    await seedPlan(admin, wsId, HARNESS, slug, planBody(slug));

    const mkDecisionOp = (label: string) =>
      withPlanLock<LockTestValue>(
        null,
        { slug, intent: `add-decision ${label}`, harnessSlug: HARNESS, workspaceId: wsId, ttlSec: 30 },
        async (current) => {
          if (current === null) return { newBody: null, value: { ok: false as const } };
          // Simulate the same RMW the real tool does.
          const id = allocateNextDecisionId(current);
          const next = appendDecisionToBody(current, id, label, `body ${label}`, '2026-05-20', []);
          return { newBody: next, value: { ok: true as const, id } };
        },
      );

    const [resA, resB] = await Promise.all([mkDecisionOp('A'), mkDecisionOp('B')]);

    // Both succeed (one queued behind the other on the advisory lock).
    expect(resA.kind).toBe('applied');
    expect(resB.kind).toBe('applied');
    if (resA.kind !== 'applied' || resB.kind !== 'applied') return;
    expect(resA.value.ok).toBe(true);
    expect(resB.value.ok).toBe(true);
    if (!resA.value.ok || !resB.value.ok) return;

    // Seed had D-001 → the two writers must allocate D-002 + D-003, never collide.
    const ids = [resA.value.id, resB.value.id].sort();
    expect(ids).toEqual(['D-002', 'D-003']);

    // The serialized writers bumped version 1 → 3 (two successful upserts).
    const finalVersions = [resA.version, resB.version].sort((a, b) => a - b);
    expect(finalVersions).toEqual([2, 3]);

    // Final PG row holds both decisions.
    const row = await getPlanRow(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    expect(row).not.toBeNull();
    expect(row!.version).toBe(3);
    expect(row!.content).toContain('### D-002');
    expect(row!.content).toContain('### D-003');
  }, 60_000);

  it('two parallel add-item calls produce sequential non-colliding P-NNN', async () => {
    const slug = `zzz-conc-items-${Math.random().toString(36).slice(2, 8)}`;
    await seedPlan(admin, wsId, HARNESS, slug, planBody(slug));

    const mkItemOp = (label: string) =>
      withPlanLock<LockTestValue>(
        null,
        { slug, intent: `add-item ${label}`, harnessSlug: HARNESS, workspaceId: wsId, ttlSec: 30 },
        async (current) => {
          if (current === null) return { newBody: null, value: { ok: false as const } };
          const id = allocateNextItemId(current);
          const line = buildItemLine(id, `item ${label}`, []);
          const { newBody } = appendItemToBody(current, 'Phase 1', line);
          return { newBody, value: { ok: true as const, id } };
        },
      );

    const [resA, resB] = await Promise.all([mkItemOp('A'), mkItemOp('B')]);

    expect(resA.kind).toBe('applied');
    expect(resB.kind).toBe('applied');
    if (resA.kind !== 'applied' || resB.kind !== 'applied') return;
    if (!resA.value.ok || !resB.value.ok) return;

    // Seed had P-001 (item). allocateNextItemId scans for ALL P-NNN tokens,
    // so the two serialized writers get P-002 + P-003.
    const ids = [resA.value.id, resB.value.id].sort();
    expect(ids).toEqual(['P-002', 'P-003']);

    const row = await getPlanRow(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    expect(row!.content).toContain('P-002');
    expect(row!.content).toContain('P-003');
  }, 60_000);

  it('a stale-version write is NOT clobbered — the advisory lock serializes the RMW', async () => {
    // Both writers read the live body inside the lock (not from a stale snapshot),
    // so even a pure body append from each lands without loss. This is the
    // serialization guarantee the advisory lock provides for same-plan writers.
    const slug = `zzz-conc-serial-${Math.random().toString(36).slice(2, 8)}`;
    await seedPlan(admin, wsId, HARNESS, slug, planBody(slug));

    const append = (marker: string) =>
      withPlanLock<{ ok: true }>(
        null,
        { slug, intent: `append ${marker}`, harnessSlug: HARNESS, workspaceId: wsId, ttlSec: 30 },
        async (current) => {
          if (current === null) return { newBody: null, value: { ok: true } };
          return { newBody: current + `\n<!-- ${marker} -->\n`, value: { ok: true } };
        },
      );

    await Promise.all([append('alpha'), append('beta'), append('gamma')]);

    const row = await getPlanRow(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    // No write lost: all three markers present, version bumped 1 → 4.
    expect(row!.content).toContain('<!-- alpha -->');
    expect(row!.content).toContain('<!-- beta -->');
    expect(row!.content).toContain('<!-- gamma -->');
    expect(row!.version).toBe(4);
  }, 60_000);
});
