/**
 * store.integration.test.ts — the IO leg of the auto-revert tripwire store
 * (queen-autonomy-policy-2026-06-13 B-16 / P-080, P-081) against a real migrated
 * Postgres: migration 266's table lands, arming inserts an armed row, the sweep
 * helpers flip status (cleared / tripped / reverted) with the CAS guard, evidence
 * reads back the rows, and the grants are append/update-but-not-delete. The pure
 * model is core.test.ts / graduation.test.ts / scan.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import {
  getTripwire,
  insertTripwire,
  listArmedTripwires,
  listRecentTripwires,
  markTripwireCleared,
  markTripwireReverted,
  markTripwireTripped,
  readTripwireEvidence,
} from './store';
import { armTripwireForDecision } from './scan';
import type { AutonomyDecision } from '../decider';
import type { TripwireArming } from './core';

let db: OrgTestDb;
const WS = 'ws-tripwire-test';

function decision(over: Partial<AutonomyDecision> = {}): AutonomyDecision {
  return {
    posture: 'auto',
    category: 'implementation',
    action: 'work_items:create',
    riskTier: 'low',
    authority: 'system',
    reversibility: 'reversible',
    effectiveCeiling: 'low',
    protected: false,
    armed: true,
    wouldAutoIfArmed: true,
    reasons: [],
    ...over,
  };
}

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('autonomy_tripwires table + grants (migration 266)', () => {
  it('the table exists with the expected grants (no DELETE/TRUNCATE for harness_app)', async () => {
    const grants = await db.adminSql<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'harness_shared' AND table_name = 'autonomy_tripwires'
         AND grantee = 'harness_app'`;
    const set = new Set(grants.map((g) => g.privilege_type));
    expect(set.has('SELECT')).toBe(true);
    expect(set.has('INSERT')).toBe(true);
    expect(set.has('UPDATE')).toBe(true);
    expect(set.has('DELETE')).toBe(false);
    expect(set.has('TRUNCATE')).toBe(false);
  });

  it('the CHECK bars an irreversible row (belt-and-braces)', async () => {
    await expect(db.adminSql`
      INSERT INTO harness_shared.autonomy_tripwires
        (id, workspace_id, category, finding_class, revert_handle, status, window_until, reversibility)
      VALUES ('tw-bad', ${WS}, 'implementation', 'x', '{}'::jsonb, 'armed', now(), 'irreversible')`).rejects.toThrow();
  });
});

describe('armTripwireForDecision + store round-trip', () => {
  it('arms a reversible auto decision and lists it; refuses a gated one', async () => {
    const ok = await armTripwireForDecision(
      db.adminSql,
      WS,
      { decision: decision(), revertHandle: { kind: 'config-edit', sha: 'deadbeef' }, decisionId: 'disp-123', windowHours: 24 },
      Date.now(),
    );
    expect(ok.armed).toBe(true);

    const refused = await armTripwireForDecision(
      db.adminSql,
      WS,
      { decision: decision({ reversibility: 'irreversible' }), revertHandle: { kind: 'x' } },
    );
    expect(refused.armed).toBe(false);

    const armed = await listArmedTripwires(db.adminSql, WS);
    expect(armed).toHaveLength(1);
    expect(armed[0]!.category).toBe('implementation');
    expect(armed[0]!.findingClass).toBe('work_items:create');
    expect(armed[0]!.revertHandle).toMatchObject({ kind: 'config-edit', sha: 'deadbeef' });
    expect(armed[0]!.decisionId).toBe('disp-123'); // mig 269 link slot round-trips
    expect(armed[0]!.status).toBe('armed');
  });

  it('CAS transitions: armed → cleared, armed → tripped → reverted', async () => {
    const arming: TripwireArming = {
      category: 'inbox-triage',
      findingClass: 'inbox:triage',
      action: 'inbox:triage',
      riskTier: 'trivial',
      revertHandle: { kind: 'flag-flip', prior: false },
      decision: decision({ category: 'inbox-triage', action: 'inbox:triage' }),
      armedAtMs: Date.now(),
      windowUntilMs: Date.now() + 3_600_000,
    };
    const idA = await insertTripwire(db.adminSql, WS, arming);
    const idB = await insertTripwire(db.adminSql, WS, { ...arming, findingClass: 'inbox:other', action: 'inbox:other' });
    expect(idA && idB).toBeTruthy();

    const now = Date.now();
    await markTripwireCleared(db.adminSql, WS, idA!, now);
    await markTripwireTripped(db.adminSql, WS, idB!, 'gym-regression', now);
    await markTripwireReverted(db.adminSql, WS, idB!, now);

    const a = await getTripwire(db.adminSql, WS, idA!);
    const b = await getTripwire(db.adminSql, WS, idB!);
    expect(a!.status).toBe('cleared');
    expect(b!.status).toBe('reverted');
    expect(b!.tripReason).toBe('gym-regression');

    // CAS: a second clear on an already-resolved row is a no-op.
    await markTripwireCleared(db.adminSql, WS, idB!, now);
    expect((await getTripwire(db.adminSql, WS, idB!))!.status).toBe('reverted');
  });

  it('readTripwireEvidence returns rows in the lookback window; recent feed is newest-first', async () => {
    const evidence = await readTripwireEvidence(db.adminSql, WS, { lookbackDays: 90, nowMs: Date.now() });
    expect(evidence.length).toBeGreaterThanOrEqual(3);
    const recent = await listRecentTripwires(db.adminSql, WS, { limit: 10 });
    expect(recent.length).toBeGreaterThanOrEqual(3);
    // newest-first
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i - 1]!.armedAtMs).toBeGreaterThanOrEqual(recent[i]!.armedAtMs);
    }
  });
});
