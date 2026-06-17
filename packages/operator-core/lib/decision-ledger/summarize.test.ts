/**
 * summarize.test.ts — the PURE rollup leg of summarizeDecisionLedger (read.ts
 * ~197-227). The integration suite (decision-ledger.integration.test.ts) asserts
 * byLayer / byPosture / byDisposition against real PG, but NEVER byCategory nor
 * the `?? 'unknown'` null-key bucket nor the `if (r.disposition)` exclusion guard.
 *
 * summarizeDecisionLedger calls readDecisionLedger INTRA-module, so mocking the
 * `./read` export can't intercept it — instead we stub `getOrgPg().sql` to return
 * controlled DB-shaped rows (the integration-test idiom), exercising the real
 * read→map→rollup path over a fixture we control:
 *   (a) byCategory counts each distinct category,
 *   (b) a category:null row buckets into byCategory.unknown (the ~214 fallback),
 *   (c) a row with no disposition is EXCLUDED from byDisposition (~223 guard) yet
 *       still counts in total,
 *   (d) empty input → the `empty` object with latestTs:null,
 *   (e) latestTs === rows[0].ts (rows are ts DESC).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  // A tagged-template `sql` that ignores the query and returns the staged rows.
  const sql = () => Promise.resolve(h.rows);
  return { ...actual, getOrgPg: () => ({ sql }) };
});

import { summarizeDecisionLedger } from './read';

/** One DB-shaped (snake_case) decision_ledger row; readDecisionLedger maps it. */
function dbRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    ts: '2026-06-12T00:00:00.000Z',
    layer: 'disposition',
    harness_slug: 'papercup',
    action: 'plans:add-item',
    capability: null,
    tier: null,
    category: 'plan-governance',
    risk_tier: 'moderate',
    reversibility: 'reversible',
    authority: 'system',
    posture: 'gated',
    outcome: 'ok',
    outcome_code: null,
    disposition: 'act',
    revisit_at: null,
    revert_handle: null,
    tripwire_id: null,
    why: null,
    links: null,
    actor_role: null,
    actor_spawn_id: null,
    actor_principal: null,
    transport: null,
    duration_ms: null,
    metadata: null,
    ...over,
  };
}

beforeEach(() => {
  h.rows = [];
});

describe('summarizeDecisionLedger — pure rollup', () => {
  it('(a) byCategory counts each distinct category', async () => {
    h.rows = [
      dbRow({ id: 1, category: 'plan-governance' }),
      dbRow({ id: 2, category: 'plan-governance' }),
      dbRow({ id: 3, category: 'inbox-triage' }),
    ];
    const s = await summarizeDecisionLedger('ws');
    expect(s.byCategory).toEqual({ 'plan-governance': 2, 'inbox-triage': 1 });
    expect(s.total).toBe(3);
  });

  it("(b) a category:null row buckets into byCategory.unknown (the ?? 'unknown' fallback)", async () => {
    h.rows = [
      dbRow({ id: 1, category: null }),
      dbRow({ id: 2, category: 'inbox-triage' }),
      dbRow({ id: 3, category: null }),
    ];
    const s = await summarizeDecisionLedger('ws');
    expect(s.byCategory.unknown).toBe(2);
    expect(s.byCategory['inbox-triage']).toBe(1);
    // never a literal `null` key — the fallback collapses both null rows:
    expect(s.byCategory).not.toHaveProperty('null');
  });

  it('(c) a row with no disposition is excluded from byDisposition but still counts in total', async () => {
    h.rows = [
      dbRow({ id: 1, layer: 'disposition', disposition: 'act' }),
      // an action-layer row carries no disposition (the ~223 `if (r.disposition)` guard):
      dbRow({ id: 2, layer: 'action', disposition: null, posture: 'auto', category: 'agent-lifecycle' }),
    ];
    const s = await summarizeDecisionLedger('ws');
    expect(s.total).toBe(2);
    expect(s.byDisposition).toEqual({ act: 1 });
    // the dispositionless row IS counted everywhere else:
    expect(s.byLayer).toEqual({ disposition: 1, action: 1 });
    expect(s.byPosture).toEqual({ gated: 1, auto: 1 });
  });

  it('(d) empty input → the `empty` object with latestTs:null', async () => {
    h.rows = [];
    const s = await summarizeDecisionLedger('ws');
    expect(s).toEqual({
      total: 0,
      byLayer: {},
      byPosture: {},
      byCategory: {},
      byDisposition: {},
      latestTs: null,
    });
  });

  it('(e) latestTs === rows[0].ts (rows are ts DESC)', async () => {
    h.rows = [
      dbRow({ id: 1, ts: '2026-06-14T10:00:00.000Z' }), // newest first
      dbRow({ id: 2, ts: '2026-06-13T10:00:00.000Z' }),
      dbRow({ id: 3, ts: '2026-06-12T10:00:00.000Z' }),
    ];
    const s = await summarizeDecisionLedger('ws');
    expect(s.latestTs).toBe('2026-06-14T10:00:00.000Z');
  });

  it('empty workspaceId short-circuits to empty WITHOUT reading', async () => {
    h.rows = [dbRow()]; // present, but the early return means it never reads
    const s = await summarizeDecisionLedger('');
    expect(s.latestTs).toBeNull();
    expect(s.total).toBe(0);
  });
});
