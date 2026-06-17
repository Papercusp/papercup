/**
 * policy-store.integration.test.ts — the IO leg of the autonomy-policy store
 * (queen-autonomy-policy-2026-06-13 B-03 / P-021, P-022, P-023) against a real
 * migrated Postgres: migration 259's table + seed land, the read returns the
 * complete behavior-neutral policy, upserts enforce the invariants (valid
 * category/level; graduated clamped ≤ ceiling; locked ⇒ never-auto), an audit
 * row is written, the grants are append/update-but-not-delete, and the
 * `autonomy.policy` sync resolver returns the policy. The pure model is
 * policy.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import {
  getAutonomyCategoryPolicy,
  readAutonomyPolicy,
  setAutonomyPolicy,
} from './policy-store';
import { effectiveCeiling } from './policy';
import { AUTONOMY_CATEGORY_IDS, PROTECTED_CATEGORIES } from './categories';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('autonomy_policy seed + read (migration 259)', () => {
  it('seeds the 13 canonical categories for the default workspace, all behavior-neutral', async () => {
    const policy = await readAutonomyPolicy(db.adminSql, 'default');
    expect(policy.map((p) => p.category)).toEqual([...AUTONOMY_CATEGORY_IDS]);
    for (const p of policy) {
      expect(p.ceiling).toBe('never-auto'); // D-007: never-auto shipped default
      expect(effectiveCeiling(p)).toBe('never-auto');
    }
    const locked = new Set(policy.filter((p) => p.locked).map((p) => p.category));
    expect(locked).toEqual(new Set(PROTECTED_CATEGORIES)); // D-005
  });

  it('an unseeded workspace reads as all-defaults — fail-safe never-auto (D-010)', async () => {
    const policy = await readAutonomyPolicy(db.adminSql, 'ws-never-seeded');
    expect(policy).toHaveLength(AUTONOMY_CATEGORY_IDS.length);
    expect(policy.every((p) => effectiveCeiling(p) === 'never-auto')).toBe(true);
    const locked = new Set(policy.filter((p) => p.locked).map((p) => p.category));
    expect(locked).toEqual(new Set(PROTECTED_CATEGORIES));
  });

  it('grants: harness_app may SELECT/INSERT/UPDATE but never DELETE/TRUNCATE', async () => {
    const grants = await db.adminSql<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'harness_shared' AND table_name = 'autonomy_policy'
         AND grantee = 'harness_app'`;
    const set = new Set(grants.map((g) => g.privilege_type));
    expect(set.has('SELECT')).toBe(true);
    expect(set.has('INSERT')).toBe(true);
    expect(set.has('UPDATE')).toBe(true);
    expect(set.has('DELETE')).toBe(false);
    expect(set.has('TRUNCATE')).toBe(false);
  });
});

describe('setAutonomyPolicy', () => {
  const WS = 'ws-set-test';

  it('upserts a ceiling and reads it back; effective stays never-auto until graduation earns', async () => {
    const r = await setAutonomyPolicy(
      db.adminSql,
      WS,
      { category: 'inbox-triage', ceiling: 'low', reason: 'unit-test set' },
      'tester',
    );
    expect(r.ceiling).toBe('low');
    // The owner set the CAP; graduation hasn't earned anything yet, so the
    // effective auto-decide level is still none (D-004: min(ceiling, graduated)).
    expect(r.graduatedLevel).toBe('never-auto');
    expect(effectiveCeiling(r)).toBe('never-auto');
    const read = await getAutonomyCategoryPolicy(db.adminSql, WS, 'inbox-triage');
    expect(read.ceiling).toBe('low');
    // A second set updates in place (upsert on the (workspace, category) PK).
    const r2 = await setAutonomyPolicy(
      db.adminSql,
      WS,
      { category: 'inbox-triage', ceiling: 'moderate', reason: 'unit-test update' },
      'tester',
    );
    expect(r2.ceiling).toBe('moderate');
    const rows = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.autonomy_policy
       WHERE workspace_id = ${WS} AND category = 'inbox-triage'`;
    expect(rows[0]!.n).toBe(1);
  });

  it('graduation within the cap raises the effective ceiling (D-004 min)', async () => {
    const r = await setAutonomyPolicy(
      db.adminSql,
      WS,
      { category: 'escalations', ceiling: 'high', graduatedLevel: 'moderate', reason: 'graduation test' },
      'tester',
    );
    expect(r.ceiling).toBe('high');
    expect(r.graduatedLevel).toBe('moderate');
    expect(effectiveCeiling(r)).toBe('moderate'); // min(high, moderate)
  });

  it('clamps graduatedLevel to ≤ ceiling — never raises autonomy past the cap (D-005)', async () => {
    const r = await setAutonomyPolicy(
      db.adminSql,
      WS,
      { category: 'work-prioritization', ceiling: 'low', graduatedLevel: 'high', reason: 'clamp test' },
      'tester',
    );
    expect(r.graduatedLevel).toBe('low');
    expect(effectiveCeiling(r)).toBe('low');
    const read = await getAutonomyCategoryPolicy(db.adminSql, WS, 'work-prioritization');
    expect(read.graduatedLevel).toBe('low');
  });

  it('a SEPARATE-call lowered ceiling RE-CLAMPS a prior graduated level back down (owner-authority walk-back, D-005)', async () => {
    // Gap 2: the single-call clamp is covered above. This is the dangerous
    // SEPARATE-call path — the owner first grants headroom + a graduated level,
    // then later LOWERS the ceiling alone (no graduatedLevel in the second call).
    // A stale graduated level surviving above the new ceiling would let the Queen
    // auto-decide PAST current owner authority (D-005) — a real safety bug.
    const r1 = await setAutonomyPolicy(
      db.adminSql,
      WS,
      { category: 'inbox-triage', ceiling: 'high', graduatedLevel: 'moderate', reason: 'walk-back: grant' },
      'tester',
    );
    expect(r1.ceiling).toBe('high');
    expect(r1.graduatedLevel).toBe('moderate');
    expect(effectiveCeiling(r1)).toBe('moderate');

    // Lower the ceiling alone — graduatedLevel omitted (it must re-clamp, not persist stale).
    const r2 = await setAutonomyPolicy(
      db.adminSql,
      WS,
      { category: 'inbox-triage', ceiling: 'low', reason: 'walk-back: lower ceiling' },
      'tester',
    );
    expect(r2.ceiling).toBe('low');
    expect(r2.graduatedLevel).toBe('low'); // re-clamped from 'moderate' down to the new cap
    expect(effectiveCeiling(r2)).toBe('low'); // autonomy never exceeds current owner authority

    // Re-READ from PG — the persisted row must also be re-clamped, not just the return value.
    const read = await getAutonomyCategoryPolicy(db.adminSql, WS, 'inbox-triage');
    expect(read.graduatedLevel).toBe('low');
    expect(effectiveCeiling(read)).toBe('low');
  });

  it('locked ⇒ effective ceiling none regardless of the stored ceiling', async () => {
    const r = await setAutonomyPolicy(
      db.adminSql,
      WS,
      { category: 'implementation', ceiling: 'high', locked: true, reason: 'lock test' },
      'tester',
    );
    expect(r.locked).toBe(true);
    expect(r.ceiling).toBe('high');
    expect(effectiveCeiling(r)).toBe('never-auto');
  });

  it('rejects an unknown category and an invalid level', async () => {
    await expect(
      setAutonomyPolicy(db.adminSql, WS, { category: 'not-a-category', reason: 'bad category' }, 'tester'),
    ).rejects.toThrow(/unknown category/);
    await expect(
      setAutonomyPolicy(
        db.adminSql,
        WS,
        { category: 'inbox-triage', ceiling: 'ludicrous', reason: 'bad level' },
        'tester',
      ),
    ).rejects.toThrow(/invalid ceiling/);
  });

  it('writes an audit_log row attributable to the actor, with details as a real jsonb object', async () => {
    await setAutonomyPolicy(
      db.adminSql,
      WS,
      { category: 'ideation-intake', ceiling: 'moderate', reason: 'audit check' },
      'tester-actor',
    );
    // Extract jsonb fields server-side (details->>'k', jsonb_typeof) — the
    // client-agnostic check per agent-insights/postgres-js-jsonb-binding. A
    // double-encoded write would surface here as jsonb_typeof='string'.
    const rows = await db.adminSql<
      { actor: string; ceiling: string; reason: string; jtype: string }[]
    >`
      SELECT actor,
             details->>'ceiling' AS ceiling,
             details->>'reason'  AS reason,
             jsonb_typeof(details) AS jtype
        FROM harness_shared.audit_log
       WHERE action = 'autonomy:policy_set' AND subject = 'ideation-intake' AND workspace_id = ${WS}
       ORDER BY ts DESC LIMIT 1`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('tester-actor');
    expect(rows[0]!.jtype).toBe('object');
    expect(rows[0]!.ceiling).toBe('moderate');
    expect(rows[0]!.reason).toBe('audit check');
  });
});

describe('autonomy.policy sync resolver wiring', () => {
  const prev = process.env.PAPERCUSP_WORKSPACE_ID;
  beforeAll(() => {
    // Pin the resolver's activeWorkspaceId() to the seeded workspace.
    process.env.PAPERCUSP_WORKSPACE_ID = 'default';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = prev;
  });

  it('resolveNamedQueryV2("autonomy.policy") returns all 13 categories with effectiveCeiling', async () => {
    const { resolveNamedQueryV2 } = await import('../sync-resolver');
    const rows = (await resolveNamedQueryV2('autonomy.policy', {})) as Array<{
      category: string;
      effectiveCeiling: string;
    }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(AUTONOMY_CATEGORY_IDS.length);
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set(AUTONOMY_CATEGORY_IDS));
    expect(rows.every((r) => typeof r.effectiveCeiling === 'string')).toBe(true);
  });
});
