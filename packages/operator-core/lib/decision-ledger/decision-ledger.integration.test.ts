/**
 * decision-ledger.integration.test.ts — the IO leg of the Queen decision ledger
 * (queen-autonomy-policy-2026-06-13 B-13 / P-111 + P-113) against a real migrated
 * Postgres: migrations 260 (action layer) + 265 (disposition columns) land, a
 * disposition row written via recordDecisionDisposition round-trips through
 * readDecisionLedger with every axis intact, the layer/category/disposition
 * filters select correctly, and summarizeDecisionLedger rolls up the counts. The
 * pure builders are emit.test.ts + disposition.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { AutonomyDecision } from '../autonomy/decider';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// The ledger is flag-gated; the kill-switch is ON by default — force it on so the
// test never depends on the flag backend being wired.
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => true }));

import { recordDecisionDisposition } from './disposition';
import { readDecisionLedger, summarizeDecisionLedger } from './read';

const WS = 'default';

function decision(over: Partial<AutonomyDecision> = {}): AutonomyDecision {
  return {
    posture: 'gated',
    category: 'plan-governance',
    action: 'plans:add-item',
    riskTier: 'moderate',
    authority: 'system',
    reversibility: 'reversible',
    effectiveCeiling: 'never-auto',
    protected: false,
    armed: false,
    wouldAutoIfArmed: false,
    reasons: ['policy-not-armed'],
    ...over,
  };
}

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;

  // Two disposition rows (P-111) + one action row (P-110) raw, to exercise filters.
  await recordDecisionDisposition({
    workspaceId: WS,
    harnessSlug: 'papercup',
    decision: decision({ category: 'plan-governance', action: 'plans:add-item' }),
    disposition: 'route-to-research',
    why: 'plan needs more research',
    links: { itemRef: 'plan:x#P-1', researchTaskId: 'WI-9' },
  });
  await recordDecisionDisposition({
    workspaceId: WS,
    harnessSlug: 'papercup',
    decision: decision({ category: 'inbox-triage', action: 'inbox:triage' }),
    disposition: 'defer',
    revisitAt: '2026-08-01T00:00:00.000Z',
    why: 'revisit after the release',
  });
  await db.adminSql`
    INSERT INTO harness_shared.decision_ledger
      (workspace_id, harness_slug, layer, action, category, tier, posture, outcome)
    VALUES (${WS}, 'papercup', 'action', 'bee:spawn', 'agent-lifecycle', 'medium', 'auto', 'ok')`;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('decision ledger — disposition round-trip (migrations 260 + 265)', () => {
  it('recordDecisionDisposition lands a row and readDecisionLedger returns it with every axis', async () => {
    const rows = await readDecisionLedger(WS, { disposition: 'route-to-research' });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.layer).toBe('disposition');
    expect(r.disposition).toBe('route-to-research');
    expect(r.category).toBe('plan-governance');
    expect(r.action).toBe('plans:add-item');
    expect(r.posture).toBe('gated'); // gated decision, non-act disposition
    expect(r.riskTier).toBe('moderate');
    expect(r.reversibility).toBe('reversible');
    expect(r.authority).toBe('system');
    expect(r.why).toBe('plan needs more research');
    expect(r.links).toMatchObject({ itemRef: 'plan:x#P-1', researchTaskId: 'WI-9' });
    expect(r.metadata).toMatchObject({ wouldAutoIfArmed: false, armed: false, effectiveCeiling: 'never-auto' });
    expect(typeof r.id).toBe('number');
  });

  it('carries revisit_at for a defer disposition', async () => {
    const rows = await readDecisionLedger(WS, { disposition: 'defer' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revisitAt).toBe('2026-08-01T00:00:00.000Z');
    expect(rows[0]!.why).toBe('revisit after the release');
  });

  it('filters by layer (disposition vs action)', async () => {
    expect(await readDecisionLedger(WS, { layer: 'disposition' })).toHaveLength(2);
    const action = await readDecisionLedger(WS, { layer: 'action' });
    expect(action).toHaveLength(1);
    expect(action[0]!.action).toBe('bee:spawn');
    expect(action[0]!.disposition).toBeNull();
  });

  it('filters by category', async () => {
    const rows = await readDecisionLedger(WS, { category: 'plan-governance' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.disposition).toBe('route-to-research');
  });

  it('returns newest first across both layers', async () => {
    const rows = await readDecisionLedger(WS);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const ts = rows.map((r) => r.ts);
    expect([...ts]).toEqual([...ts].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
  });

  it('summarizeDecisionLedger rolls up counts by layer / posture / disposition', async () => {
    const s = await summarizeDecisionLedger(WS);
    expect(s.total).toBeGreaterThanOrEqual(3);
    expect(s.byLayer.disposition).toBe(2);
    expect(s.byLayer.action).toBe(1);
    expect(s.byDisposition['route-to-research']).toBe(1);
    expect(s.byDisposition.defer).toBe(1);
    expect(s.byPosture.gated).toBeGreaterThanOrEqual(2);
    expect(s.byPosture.auto).toBeGreaterThanOrEqual(1);
    expect(s.latestTs).not.toBeNull();
  });

  it('scopes by workspace — a different workspace sees nothing', async () => {
    expect(await readDecisionLedger('other-ws')).toHaveLength(0);
  });
});

// B-16 ↔ B-13 ↔ B-15 undo seam (migration 269): the read surface LEFT-correlates
// an ARMED autonomy_tripwire to its decision via `autonomy_tripwires.decision_id =
// decision_ledger.id`, exposing `tripwireId` so the settings one-click UNDO (P-031)
// renders exactly when an undo is possible. Isolated in its own workspace so the
// shared 'default' counts above stay exact. Empty-until-armed by construction.
describe('decision ledger — tripwire undo seam (B-16, migration 269)', () => {
  const TW = 'tw-ws';
  let armedLedgerId: number;
  let revertedLedgerId: number;
  let bareLedgerId: number;

  beforeAll(async () => {
    const insLedger = async (action: string): Promise<number> => {
      const [r] = await db.adminSql<{ id: number | string }[]>`
        INSERT INTO harness_shared.decision_ledger
          (workspace_id, harness_slug, layer, action, category, tier, posture, outcome)
        VALUES (${TW}, 'papercup', 'action', ${action}, 'agent-lifecycle', 'medium', 'auto', 'ok')
        RETURNING id`;
      return Number(r!.id);
    };
    armedLedgerId = await insLedger('bee:spawn');
    revertedLedgerId = await insLedger('work_items:set_priority');
    bareLedgerId = await insLedger('flags:set');

    const arm = async (id: string, decisionId: number, status: string) => {
      await db.adminSql`
        INSERT INTO harness_shared.autonomy_tripwires
          (id, workspace_id, category, revert_handle, window_until, decision_id, status)
        VALUES (${id}, ${TW}, 'agent-lifecycle',
                ${JSON.stringify({ kind: 'work-item-state' })}::text::jsonb,
                now() + ${'1 hour'}::interval, ${String(decisionId)}, ${status})`;
    };
    await arm('tw-armed-1', armedLedgerId, 'armed');
    await arm('tw-reverted-1', revertedLedgerId, 'reverted');
  }, 180_000);

  it('exposes tripwireId for an ARMED tripwire correlated by decision_id', async () => {
    const rows = await readDecisionLedger(TW);
    const armed = rows.find((r) => r.id === armedLedgerId);
    expect(armed?.tripwireId).toBe('tw-armed-1');
  });

  it('is null when the correlated tripwire is no longer armed (reverted)', async () => {
    const rows = await readDecisionLedger(TW);
    const reverted = rows.find((r) => r.id === revertedLedgerId);
    expect(reverted?.tripwireId).toBeNull();
  });

  it('is null for a decision with no correlated tripwire (empty-until-armed)', async () => {
    const rows = await readDecisionLedger(TW);
    const bare = rows.find((r) => r.id === bareLedgerId);
    expect(bare?.tripwireId).toBeNull();
  });
});
