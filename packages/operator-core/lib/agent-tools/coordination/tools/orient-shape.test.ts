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
    planEvents: { total: 40, recent: Array.from({ length: 10 }, (_, i) => ({ kind: 'e', i })) },
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
    expect((out.planEvents as { recent: unknown[] }).recent).toHaveLength(5);
    expect(out.self).toBe('su-abc');
    expect(out.intentDeclared).toBe(true);
    expect(out.payloadTier).toBe('trimmed');
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
