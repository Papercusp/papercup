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
    const inbox = out.inbox as { recent: unknown[]; entries?: unknown[]; recentTruncated?: unknown; summary?: unknown };
    expect(inbox.recent).toHaveLength(5);
    expect(inbox.summary).toEqual({ total: 3327, returned: 10 });
    expect(inbox.recentTruncated).toBeDefined();
    // EI-18667514339699744: `entries` must survive tier-shaping aliased to the SAME
    // (already-projected/capped) rows as `recent` — a caller reading coord:inbox's
    // key name off a trimmed/standard orient must not see a silently-dropped [].
    expect(inbox.entries).toEqual(inbox.recent);
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

  it('EI-9031: carries the memory `degraded` marker through tier-shaping (a trimmed fleet-member session must still see it)', () => {
    const degradedMemory = {
      query: 'own-log-fork-guard work',
      hits: [],
      degraded: true,
      degradedReason: 'embedding_backend_degraded',
      filteredLowScore: 4,
    };
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeOrient({ ...fixture(), memory: degradedMemory }, tier) as {
        memory: { degraded?: boolean; degradedReason?: string; filteredLowScore?: number };
      };
      expect(out.memory.degraded).toBe(true);
      expect(out.memory.degradedReason).toBe('embedding_backend_degraded');
      expect(out.memory.filteredLowScore).toBe(4);
    }
    // A healthy recall carries no degraded marker after shaping (backward-compatible).
    const healthy = shapeOrient(fixture(), 'trimmed') as { memory: Record<string, unknown> };
    expect('degraded' in healthy.memory).toBe(false);
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

// P-016 (voice-public-release-readiness-2026-07-12): the papercup pane digest is a
// rendered markdown block — cap by chars with the D-004 fetch-pointer; deepWork is
// bounded at source (newest≤3) and must pass through untouched.
describe('P-016 role-fold shaping (paneContext cap / deepWork pass-through)', () => {
  it('caps a fat paneContext by chars with a fetch-pointer; deepWork passes through unchanged', () => {
    const digest = `## Live system status — papercusp\n${'x'.repeat(8_000)}`;
    const deepWork = {
      count: 1,
      oldestAgeMs: 5_000,
      newest: [{ msgId: 'm1', from: 'sentinel-1', summary: 'why is the deploy red?', ageMs: 5_000 }],
    };
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeOrient({ ...fixture(), paneContext: digest, deepWork }, tier) as {
        paneContext: string;
        deepWork: unknown;
      };
      expect(out.paneContext.length).toBeLessThan(digest.length);
      expect(out.paneContext).toContain('… (trimmed');
      expect(out.paneContext.startsWith('## Live system status')).toBe(true);
      expect(out.deepWork).toEqual(deepWork);
    }
  });

  it('a small paneContext passes through byte-identical (no gratuitous truncation)', () => {
    const small = '## Live system status — papercusp\n_no anomalies — system healthy._';
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeOrient({ ...fixture(), paneContext: small }, tier) as { paneContext: string };
      expect(out.paneContext).toBe(small);
    }
  });
});

// EI-19314271768708528: `leaderBrief` had no shaper, so it reached the result-door's
// bounded-payload pass full-fat and was dropped WHOLE — on a monitor wake (the mode that
// exists to deliver it) the leader was left with `me`, its own one-row assignment view,
// which reads exactly like a fleet-wide "1 alive, 0 stalled" verdict. Shaping it is what
// makes tier 2b's ordering promotion in assembleOrientOutput actually land: promoted-but-
// oversized and never-folded are indistinguishable to the reader.
describe('EI-19314271768708528 leaderBrief shaping (monitor-wake fleet visibility)', () => {
  const member = (i: number, over: Record<string, unknown> = {}) => ({
    agentId: `su-member-${i}`,
    label: `su · m${i}`,
    fleetRole: 'member',
    sessionState: 'live',
    verdict: 'monitoring',
    wakeMode: 'auto',
    contextPressure: 'ok',
    load: 1,
    queuedCount: 1,
    workItemIds: [`EI-${1000 + i}`],
    doing: { id: `EI-${1000 + i}`, title: 'x'.repeat(400), status: 'open' },
    stalled: false,
    ...over,
  });

  // The reporting incident: 11 members, one dead, one idle-with-claimable carrying a
  // ~450-char benchSuggestion.reason, one at critical context with an unanswered body.
  const fatBrief = () => ({
    summary: {
      fleet: 'nonp2p-bug-drain-0801',
      members: 11,
      dead: 1,
      stalled: 0,
      idle_with_claimable: 1,
      unanswered_directed: 5,
      unowned_criticals: 18,
      idleWithClaimableAlert: true,
    },
    members: [
      ...Array.from({ length: 8 }, (_, i) => member(i)),
      member(8, { sessionState: 'ended', verdict: 'dead', doing: null, workItemIds: [] }),
      member(9, {
        doing: null,
        workItemIds: [],
        load: 0,
        benchSuggestion: { kind: 'idle-with-claimable', item: null, reason: 'r'.repeat(450) },
      }),
      member(10, {
        contextPressure: 'critical',
        unanswered: { count: 1, oldestAgeMs: 1_918_532, newest: [{ body: 'b'.repeat(900) }] },
      }),
    ],
    unownedCriticals: Array.from({ length: 18 }, (_, i) => ({ id: `EI-${i}`, title: 'y'.repeat(200) })),
  });

  it('keeps summary WHOLE — every aggregate alert a leader acts on survives the cap', () => {
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, tier) as {
        leaderBrief: { summary: Record<string, unknown> };
      };
      expect(out.leaderBrief.summary).toEqual(fatBrief().summary);
    }
  });

  it('shrinks the brief monotonically by tier so the door has no reason to drop it whole', () => {
    const before = JSON.stringify(fatBrief()).length;
    const sized = (tier: 'trimmed' | 'standard') =>
      JSON.stringify((shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, tier) as { leaderBrief: unknown }).leaderBrief).length;
    const trimmed = sized('trimmed');
    const standard = sized('standard');
    // Both tiers shrink; trimmed is strictly the leaner projection (standard keeps the
    // whole roster of a normal-sized fleet on purpose, so it shrinks by less).
    expect(standard).toBeLessThan(before);
    expect(trimmed).toBeLessThan(standard);
    // The bound that actually matters: `trimmed` is the tier the reporting incident ran
    // under (tier=trimmed, forced=true), so it must land small enough to survive the
    // budget alongside me/claimable/inbox rather than being dropped whole.
    expect(trimmed).toBeLessThan(4_000);
  });

  it('ranks actionable members FIRST — a head-slice would hide the dead one behind 8 healthy', () => {
    const out = shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, 'trimmed') as {
      leaderBrief: { members: Array<{ agentId: string }> };
    };
    const kept = out.leaderBrief.members.map((m) => m.agentId);
    // dead (8), pressured/unanswered (10) and idle-with-claimable (9) are the rows a
    // leader must intervene on; a naive .slice(0,6) would have kept members 0-5 only.
    expect(kept).toContain('su-member-8');
    expect(kept).toContain('su-member-10');
    expect(kept).toContain('su-member-9');
  });

  it('leaves the D-004 count + fetch-pointer when the roster is capped', () => {
    const out = shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, 'trimmed') as {
      leaderBrief: { members: unknown[]; membersTruncated?: { total: number; shown: number; more: string } };
    };
    expect(out.leaderBrief.members.length).toBe(6);
    expect(out.leaderBrief.membersTruncated).toMatchObject({ total: 11, shown: 6, more: 'fleet:leader-brief' });
  });

  it('caps the unbounded advisory rosters with a pointer', () => {
    const out = shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, 'trimmed') as {
      leaderBrief: { unownedCriticals: unknown[]; unownedCriticalsTruncated?: { total: number } };
    };
    expect(out.leaderBrief.unownedCriticals.length).toBe(5);
    expect(out.leaderBrief.unownedCriticalsTruncated).toMatchObject({ total: 18 });
  });

  it('drops per-member unanswered message BODIES but keeps the count a leader acts on', () => {
    const out = shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, 'trimmed') as {
      leaderBrief: { members: Array<{ agentId: string; unanswered?: { count: number; newest?: unknown } }> };
    };
    const pressured = out.leaderBrief.members.find((m) => m.agentId === 'su-member-10');
    expect(pressured?.unanswered).toMatchObject({ count: 1, oldestAgeMs: 1_918_532 });
    expect(pressured?.unanswered).not.toHaveProperty('newest');
  });

  it('passes a small brief through without inventing truncation markers', () => {
    const small = { summary: { fleet: 'f', members: 2, dead: 0 }, members: [member(0), member(1)] };
    const out = shapeOrient({ ...fixture(), leaderBrief: small }, 'standard') as {
      leaderBrief: { members: unknown[]; membersTruncated?: unknown };
    };
    expect(out.leaderBrief.members.length).toBe(2);
    expect(out.leaderBrief.membersTruncated).toBeUndefined();
  });
});
