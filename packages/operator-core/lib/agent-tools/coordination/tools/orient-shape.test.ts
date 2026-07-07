/**
 * orient-shape.test.ts — coord:orient payload-tier shapers
 * (context-trimming-tiers-2026-07-01 P-012).
 *
 * The incident contract: no silent caps (every truncation leaves a count + a
 * fetch-pointer), claimable rows project to placement essentials (the
 * duplicated summary / null-spelled / payload-fat row shape measured ~1
 * token/char), and the TOON `me` string is cut at its per-plan coverage tail.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/orient-shape.test.ts
 */
import { describe, expect, it } from 'vitest';
import { shapeOrient } from './orient-shape';

const row = (i: number) => ({
  id: `WI-${1000 + i}`,
  kind: 'feature',
  family: 'feature',
  harness: 'papercusp',
  title: `Task ${i} — ${'t'.repeat(200)}`,
  summary: `Task ${i} — duplicated summary ${'s'.repeat(200)}`,
  state: 'todo',
  assignee: 's-1782949238028-795dede8',
  takenAt: '2026-07-01 19:40:56.380194-04',
  lastProgressAt: null,
  assignedBy: null,
  severity: null,
  parent: null,
  payload: { plan_item: { item_id: 'P-010', plan_slug: 'some-plan', harness_slug: 'papercusp' }, other: 'x'.repeat(500) },
  rank: null,
});

function fixture(n = 20) {
  return {
    self: 'su-abc',
    ok: true,
    me: `format: toon\nok: true\nself:\n  ownerId: su-abc\nsummary:\n  claims: 0\ncoverage[37]:\n${'  - plan: p\n    item: P-001\n'.repeat(60)}`,
    claimable: Array.from({ length: n }, (_, i) => row(i)),
    inbox: {
      summary: { total: 3327, returned: 10 },
      recent: Array.from({ length: 10 }, (_, i) => ({ ts: `t${i}`, kind: 'message', from: 'su-x', summary: 'm'.repeat(400), body: 'b'.repeat(800) })),
    },
    memory: { query: 'q', hits: Array.from({ length: 5 }, (_, i) => ({ id: i, memory: 'x'.repeat(900), score: 0.5 })) },
    planEvents: {
      total: 40,
      recent: Array.from({ length: 10 }, (_, i) => ({
        kind: 'plan_event',
        event: 'now_updated',
        plan_slug: 'token-plan',
        detail: `P-${String(i).padStart(3, '0')}`,
        after: `full plan now body ${i} ${'a'.repeat(900)}`,
      })),
    },
    fleetCatchUp: {
      fleet: 'fleet-a',
      total: 10,
      recent: Array.from({ length: 10 }, (_, i) => ({ kind: 'message', from: 'su-x', body: `fleet message ${i} ${'f'.repeat(900)}` })),
    },
    // Standing facts: mostly noisy workspace-scope, with the load-bearing owner +
    // harness facts buried in the middle (they must survive the count cap).
    facts: [
      ...Array.from({ length: 10 }, (_, i) => ({ scope: 'workspace', ref: null, body: `ws ${i} ${'w'.repeat(400)}`, src: null })),
      { scope: 'owner', ref: 'su-abc', body: `OWNER-WALL ${'o'.repeat(400)}`, src: 'WI-1' },
      { scope: 'harness', ref: 'papercusp', body: `HARNESS-FACT ${'h'.repeat(400)}`, src: 'WI-2' },
      ...Array.from({ length: 8 }, (_, i) => ({ scope: 'workspace', ref: null, body: `ws b${i}`, src: null })),
    ],
    intentDeclared: true,
  };
}

describe('shapeOrient trimmed', () => {
  const out = shapeOrient(fixture(), 'trimmed') as Record<string, never> & Record<string, unknown>;

  it('projects claimable rows to placement essentials with a loud cap', () => {
    const rows = out.claimable as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(8);
    const r = rows[0];
    // kept: the placement signal
    expect(r.id).toBe('WI-1000');
    expect(r.state).toBe('todo');
    expect(r.plan_item).toEqual({ item_id: 'P-010', plan_slug: 'some-plan', harness_slug: 'papercusp' });
    // dropped: the token sinks
    expect(r.summary).toBeUndefined();
    expect(r.payload).toBeUndefined();
    expect(r.takenAt).toBeUndefined();
    expect((r.title as string).length).toBeLessThanOrEqual(90);
    // no silent cap
    expect(out.claimableTruncated).toMatchObject({ total: 20, shown: 8 });
  });

  it('cuts the TOON me at the coverage tail with a fetch-pointer', () => {
    const me = out.me as string;
    expect(me).toContain('ownerId: su-abc');
    expect(me).not.toContain('coverage[37]');
    expect(me).toContain('fleet:assignments');
  });

  it('caps inbox/memory/planEvents with pointers; keeps identity + summary fields', () => {
    const inbox = out.inbox as { recent: unknown[]; recentTruncated?: unknown; summary?: unknown };
    expect(inbox.recent).toHaveLength(5);
    expect(inbox.summary).toEqual({ total: 3327, returned: 10 });
    expect(inbox.recentTruncated).toBeDefined();
    const memory = out.memory as { hits: Array<{ memory: string }>; hitsTruncated?: unknown };
    expect(memory.hits).toHaveLength(3);
    expect(memory.hits[0].memory.length).toBeLessThanOrEqual(220);
    const events = out.planEvents as { recent: Array<{ after: string; plan_slug: string }>; recentTruncated?: unknown };
    expect(events.recent).toHaveLength(5);
    expect(events.recent[0].plan_slug).toBe('token-plan');
    expect(events.recent[0].after.length).toBeLessThanOrEqual(220);
    expect(events.recentTruncated).toBeDefined();
    const catchUp = out.fleetCatchUp as { recent: Array<{ body: string }>; recentTruncated?: unknown };
    expect(catchUp.recent).toHaveLength(5);
    expect(catchUp.recent[0].body.length).toBeLessThanOrEqual(220);
    expect(catchUp.recentTruncated).toBeDefined();
    expect(out.self).toBe('su-abc');
    expect(out.intentDeclared).toBe(true);
    expect(out.payloadTier).toBe('trimmed');
  });

  it('caps long plan-event prose even when the event count is not truncated', () => {
    const out = shapeOrient(
      { planEvents: { total: 1, recent: [{ event: 'item_added', after: 'x'.repeat(900), detail: 'y'.repeat(900) }] } },
      'trimmed',
    ) as { planEvents: { recent: Array<{ after: string; detail: string }>; recentTruncated?: unknown } };
    expect(out.planEvents.recent).toHaveLength(1);
    expect(out.planEvents.recent[0].after.length).toBeLessThanOrEqual(220);
    expect(out.planEvents.recent[0].detail.length).toBeLessThanOrEqual(220);
    expect(out.planEvents.recentTruncated).toBeUndefined();
  });

  it('caps standing facts with a pointer, keeping owner + harness scope first (WI-2859)', () => {
    const facts = out.facts as Array<{ scope: string; body: string }>;
    expect(facts).toHaveLength(8);
    // The owner-wall + harness facts were buried at input positions 10/11 but must
    // survive the count cap (they outrank noisy workspace-scope facts).
    const scopes = facts.map((f) => f.scope);
    expect(scopes).toContain('owner');
    expect(scopes).toContain('harness');
    expect(facts[0].scope).toBe('owner'); // owner ranks first
    // bodies capped
    for (const f of facts) expect(f.body.length).toBeLessThanOrEqual(200);
    // no silent cap
    expect(out.factsTruncated).toMatchObject({ total: 20, shown: 8, more: 'facts:list' });
  });

  it('shrinks the payload by an order of magnitude on the incident-shaped fixture', () => {
    const before = JSON.stringify(fixture()).length;
    const after = JSON.stringify(out).length;
    expect(after).toBeLessThan(before / 5);
  });
});

describe('shapeOrient standard', () => {
  it('is a looser projection of the same shape', () => {
    const out = shapeOrient(fixture(), 'standard') as Record<string, unknown>;
    expect((out.claimable as unknown[]).length).toBe(15);
    expect(out.payloadTier).toBe('standard');
  });

  it('passes through small results without truncation markers', () => {
    const small = { ok: true, me: 'short', claimable: [row(1)], inbox: { summary: {}, recent: [] } };
    const out = shapeOrient(small, 'trimmed') as Record<string, unknown>;
    expect(out.claimableTruncated).toBeUndefined();
    expect((out.claimable as unknown[]).length).toBe(1);
  });

  it('tolerates junk shapes', () => {
    expect(shapeOrient(null, 'trimmed')).toBeNull();
    expect(shapeOrient('str', 'trimmed')).toBe('str');
    expect(shapeOrient({ me: 42, claimable: 'not-array' }, 'trimmed')).toMatchObject({ me: 42 });
  });
});

describe('shapeOrient — compaction folds (compaction-fold-audit-2026-07-06)', () => {
  it('fold #2: a post-compaction payload (recovery present) relaxes the inbox re-cap', () => {
    const base = fixture(); // 10 inbox entries, summaries 400 chars
    // baseline: NO recovery ⇒ the standard trimmed cap (5 entries, 140-char summaries) applies
    const capped = shapeOrient(base, 'trimmed') as { inbox: { recent: Array<{ summary: string }>; recentTruncated?: unknown } };
    expect(capped.inbox.recent).toHaveLength(5);
    expect(capped.inbox.recentTruncated).toBeDefined();
    expect(capped.inbox.recent[0].summary.length).toBeLessThanOrEqual(140);
    // recovery present (⇒ afterCompaction) ⇒ all 10 entries survive with fuller bodies, no truncation
    const recovered = shapeOrient({ ...base, recovery: { selfRecall: 'x' } }, 'trimmed') as {
      inbox: { recent: Array<{ summary: string }>; recentTruncated?: unknown };
    };
    expect(recovered.inbox.recent).toHaveLength(10);
    expect(recovered.inbox.recentTruncated).toBeUndefined();
    expect(recovered.inbox.recent[0].summary.length).toBe(400); // 400 < relaxed 700-char cap ⇒ untruncated
  });

  it('fold #1: passes a compact fleetHealth through unchanged (not re-shaped away)', () => {
    const fleetHealth = {
      bees: { running: 3, working: 2 },
      wake: { default: 'auto', stagedTotal: 1, stagedOwners: 1 },
      governor: { anyPaused: false, paused: [] },
    };
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeOrient({ ...fixture(), fleetHealth }, tier) as { fleetHealth: unknown };
      expect(out.fleetHealth).toEqual(fleetHealth);
    }
  });
});
