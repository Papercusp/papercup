/**
 * decider.integration.test.ts — the IO leg of the Queen autonomy decider
 * (queen-autonomy-policy-2026-06-13 B-12 / P-070) against a real migrated
 * Postgres.
 *
 * The pure gate is unit-tested with injected fakes (decider.test.ts) and the
 * cross-module invariants are pinned in recursion-safety-invariants.test.ts. THIS
 * suite proves the LIVE wiring that fakes can't: `defaultDeciderDeps`'s dynamic
 * imports (`./policy-store` + `@papercusp/flags[/server]`) actually resolve, and
 * `resolveAutonomyDecision` reads the REAL `autonomy_policy` store + the arming
 * flag end-to-end — "point the decider AT autonomy_policy" (P-070), for real. A
 * broken import path here passes tsc + the unit suite + tools-md-sync but would
 * only surface when the Queen first calls `autonomy:decide`; this is what catches it.
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

import { resolveAutonomyDecision, defaultDeciderDeps } from './decider';
import { setAutonomyPolicy } from './policy-store';
import { effectiveCeiling } from './policy';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('defaultDeciderDeps — the dynamic imports resolve against real PG (B-12 live wiring)', () => {
  it('getPolicy reads a real seeded policy row (the ./policy-store dynamic import works)', async () => {
    const deps = defaultDeciderDeps(db.adminSql, 'default');
    const p = await deps.getPolicy('inbox-triage');
    expect(p.category).toBe('inbox-triage');
    expect(effectiveCeiling(p)).toBe('never-auto'); // D-007 shipped default
  });

  it('isArmed resolves to a boolean without throwing (the @papercusp/flags[/server] imports work + fail-dark)', async () => {
    const deps = defaultDeciderDeps(db.adminSql, 'default');
    const armed = await deps.isArmed();
    expect(typeof armed).toBe('boolean');
  });

  it('isFullAutonomy resolves to a boolean without throwing (the grant-flag import works + fail-dark)', async () => {
    const deps = defaultDeciderDeps(db.adminSql, 'default');
    const granted = await deps.isFullAutonomy();
    expect(typeof granted).toBe('boolean');
  });
});

describe('resolveAutonomyDecision — end-to-end against the real autonomy_policy store', () => {
  it('default (all categories never-auto) ⇒ gated, with the live store as the source', async () => {
    const decision = await resolveAutonomyDecision(
      { action: 'memory:remember', riskTier: 'trivial', reversibility: 'reversible' },
      // Force armed AND pin the owner full-autonomy grant OFF so the SUBSTANTIVE gate is
      // exercised on the REAL ceiling — not short-circuited by the unarmed flag, nor lifted
      // wholesale by the grant (MUG_FULL_AUTONOMY). We deliberately don't lean on either
      // flag's ambient default here; the grant's own gate-lifting behaviour is covered in
      // decider.test.ts (both directions). Proves never-auto from the live store still gates.
      { ...defaultDeciderDeps(db.adminSql, 'default'), isArmed: async () => true, isFullAutonomy: async () => false },
    );
    expect(decision.category).toBe('knowledge-curation'); // memory:* → knowledge-curation
    expect(decision.effectiveCeiling).toBe('never-auto');
    expect(decision.posture).toBe('gated');
    expect(decision.reasons).toContain('ceiling-never-auto');
  });

  it('an owner-lowered + unlocked ceiling in the store ⇒ auto within the cap, end-to-end', async () => {
    const WS = 'ws-decider-armed';
    // The owner lowers the knowledge-curation ceiling and graduation earns up to it
    // (the real store write B-03 owns; the decider must READ it back through the gate).
    await setAutonomyPolicy(
      db.adminSql,
      WS,
      { category: 'knowledge-curation', ceiling: 'moderate', graduatedLevel: 'moderate', reason: 'decider int-test' },
      'tester',
    );
    // Pin the grant OFF too: this test exercises the risk/ceiling/irreversible gates, which the
    // owner full-autonomy grant would lift wholesale to `auto` (see decideAutonomy) — so the gate
    // is only meaningful with the grant inactive (mirrors decider.test.ts's gating cases).
    const deps = { ...defaultDeciderDeps(db.adminSql, WS), isArmed: async () => true, isFullAutonomy: async () => false };

    const lowRisk = await resolveAutonomyDecision(
      { action: 'memory:remember', riskTier: 'low', reversibility: 'reversible' },
      deps,
    );
    expect(lowRisk.effectiveCeiling).toBe('moderate');
    expect(lowRisk.posture).toBe('auto'); // low ≤ moderate, reversible, system

    // …but a risk above the cap still gates (the D-004 comparison reads the real ceiling).
    const highRisk = await resolveAutonomyDecision(
      { action: 'memory:remember', riskTier: 'high', reversibility: 'reversible' },
      deps,
    );
    expect(highRisk.posture).toBe('gated');
    expect(highRisk.reasons).toContain('risk-above-ceiling');

    // …and an irreversible action gates regardless of the ceiling (the B-02 hard floor).
    const irreversible = await resolveAutonomyDecision(
      { action: 'memory:remember', riskTier: 'low', reversibility: 'irreversible' },
      deps,
    );
    expect(irreversible.posture).toBe('gated');
    expect(irreversible.reasons).toContain('irreversible-action');
  });

  it('unarmed ⇒ gated even with a lowered ceiling — the arming gate holds', async () => {
    const WS = 'ws-decider-unarmed';
    await setAutonomyPolicy(
      db.adminSql,
      WS,
      { category: 'knowledge-curation', ceiling: 'moderate', graduatedLevel: 'moderate', reason: 'unarmed int-test' },
      'tester',
    );
    // Pin the UNARMED state explicitly (and the grant OFF) to exercise the arming-gate-holds
    // invariant deterministically — mirrors the sibling tests that force `isArmed: true`. We no
    // longer lean on the MUG_AUTONOMY_ARMED ambient default (it now defaults ON per the alpha
    // flags-default-on flip; with all-never-auto ceilings that stays behavior-neutral, but a
    // gating test must not depend on it). With autonomy NOT armed, even a lowered+unlocked ceiling
    // must still gate. That the live arming/grant flag wiring resolves is covered above.
    const decision = await resolveAutonomyDecision(
      { action: 'memory:remember', riskTier: 'low', reversibility: 'reversible' },
      { ...defaultDeciderDeps(db.adminSql, WS), isArmed: async () => false, isFullAutonomy: async () => false },
    );
    expect(decision.armed).toBe(false);
    expect(decision.posture).toBe('gated');
  });
});
