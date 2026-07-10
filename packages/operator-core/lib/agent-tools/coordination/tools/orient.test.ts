import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { composeOrient, orientServedDelta } from './orient';
import type { InnerCall } from '../../_compound-dispatch';

const foldFactsMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock('../../../agent-facts/store', () => ({
  foldFacts: foldFactsMock,
}));

beforeEach(() => {
  foldFactsMock.mockResolvedValue([]);
});

function fakeCall(handlers: Record<string, (args: Record<string, unknown>) => unknown>): {
  call: InnerCall;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call: InnerCall = async (name, args) => {
    calls.push({ name, args: args as Record<string, unknown> });
    const h = handlers[name];
    if (!h) throw new Error(`unexpected sub-call: ${name}`);
    return h(args as Record<string, unknown>);
  };
  return { call, calls };
}

/** The core three + plan-events (the default folds when no `intent` is passed).
 *  `coord:glance` is included so a test that opts a caller INTO a fleet (via a
 *  `coord:whoami` override) without caring about the fleet-health glance itself
 *  doesn't trip the WI-3818 bounded-timeout `console.warn` on an "unexpected
 *  sub-call" — override it locally when a test asserts on glance behavior. */
const CORE = {
  'fleet:assignments': () => ({ ok: true, summary: { agents: 1 }, agents: [{ ownerId: 'me' }] }),
  'work_items:list': () => [{ id: 'WI-1', state: 'todo' }, { id: 'WI-2', state: 'todo' }],
  'coord:inbox': () => ({ summary: { total: 3 }, entries: [{ msg_id: 'm1' }] }),
  'coord:plan-events': () => ({ events: [{ kind: 'item_status_changed', plan: 'p1' }], total: 1, truncated: false }),
  'coord:whoami': () => ({ fleetSlug: null }),
  'coord:glance': () => ({ bees: { running: 0, working: 0 } }),
};

describe('composeOrient (B-CX-1B compound + P-005 bootstrap folds)', () => {
  it('folds assignments + claimable + inbox + plan-events into one result (no intent)', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    const r = await composeOrient({ harness: 'h' }, call, 'me');
    expect(r.ok).toBe(true);
    expect((r.me as { agents: Array<{ ownerId: string }> }).agents[0].ownerId).toBe('me');
    expect(r.claimable).toHaveLength(2);
    expect((r.inbox.summary as { total: number }).total).toBe(3);
    expect(r.inbox.recent).toEqual([{ msg_id: 'm1' }]);
    expect(r.planEvents).toEqual({ total: 1, recent: [{ kind: 'item_status_changed', plan: 'p1' }] });
    // No intent ⇒ no memory recall, no declare.
    expect(r.memory).toBeUndefined();
    expect(r.intentDeclared).toBeUndefined();
    // sequential order (never Promise.all on one ctx) + arg forwarding
    expect(calls.map((c) => c.name)).toEqual([
      'fleet:assignments',
      'work_items:list',
      'coord:inbox',
      'coord:plan-events',
      'coord:whoami',
    ]);
    expect(calls[0].args).toMatchObject({ agent: 'me', harness: 'h' });
    // EI-7841: claimable is self-select context — must ask work_items:list to
    // exclude G2-admission-gated items so "claimable" matches what claim will do.
    expect(calls[1].args).toMatchObject({ harness: 'h', state: 'todo', limit: 20, admissibleOnly: true });
    expect(calls[2].args).toMatchObject({ limit: 10, max_body_chars: 300 });
    expect(calls[3].args).toMatchObject({ limit: 10 });
  });

  it('omits the agent filter when no ownerId resolved (fleet-wide assignments)', async () => {
    const { call, calls } = fakeCall({ ...CORE, 'work_items:list': () => [], 'coord:inbox': () => ({ summary: {}, entries: [] }) });
    await composeOrient({}, call, undefined);
    expect(calls[0].args.agent).toBeUndefined();
  });

  it('normalizes a { data: [...] } list shape into claimable[]', async () => {
    const { call } = fakeCall({ ...CORE, 'work_items:list': () => ({ data: [{ id: 'WI-9' }] }) });
    const r = await composeOrient({}, call, 'me');
    expect(r.claimable).toEqual([{ id: 'WI-9' }]);
  });

  it('folds the injected ownerPresent bit verbatim (P-004), and omits the leg when not resolved', async () => {
    const { call } = fakeCall({ ...CORE });
    const present = { present: true, lastSeenAgoMs: 12_000, activeSessions: 1 };
    const withBit = await composeOrient({}, call, 'me', undefined, present);
    expect(withBit.ownerPresent).toEqual(present);

    const { call: call2 } = fakeCall({ ...CORE });
    const withoutBit = await composeOrient({}, call2, 'me'); // handler didn't resolve it
    expect(withoutBit.ownerPresent).toBeUndefined();

    const { call: call3 } = fakeCall({ ...CORE });
    const failedRead = await composeOrient({}, call3, 'me', undefined, null); // read failed ⇒ null leg
    expect(failedRead.ownerPresent).toBeNull();
  });

  it('honors claimableState / claimableLimit / inboxLimit overrides', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    await composeOrient({ claimableState: 'wip', claimableLimit: 5, inboxLimit: 3 }, call, 'me');
    expect(calls[1].args).toMatchObject({ state: 'wip', limit: 5 });
    expect(calls[2].args).toMatchObject({ limit: 3 });
  });

  it('with `intent`: folds a memory recall + relevant recipes AND declares the intent (full bootstrap in one call)', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'memory:search': () => ({ ok: true, results: [{ id: 'mem1', memory: 'prefers nuqs over useState', score: 0.9 }] }),
      'recipes:search': () => ({ ok: true, query: 'implement P-005', recipes: [{ id: 'fan-out-wi', title: 'Fan-out work items', description: 'd', runCount: 7, toolsUsed: ['work_items:get'], similarity: 0.82 }] }),
      'coord:declare-intent': () => ({ ok: true }),
    });
    const r = await composeOrient(
      { intent: 'implement P-005', planSlug: 'tool-call-batching-wrappers-2026-06-21', planItems: ['P-005'], harness: 'h' },
      call,
      'me',
    );
    expect(r.memory).toEqual({ query: 'implement P-005', hits: [{ id: 'mem1', memory: 'prefers nuqs over useState', score: 0.9 }] });
    expect(r.intentDeclared).toBe(true);
    // memory uses intent as the query + harness_slug; declare carries the lane.
    const mem = calls.find((c) => c.name === 'memory:search')!;
    expect(mem.args).toMatchObject({ query: 'implement P-005', harness_slug: 'h', limit: 5 });
    const decl = calls.find((c) => c.name === 'coord:declare-intent')!;
    expect(decl.args).toMatchObject({ intent: 'implement P-005', current_plan_slug: 'tool-call-batching-wrappers-2026-06-21', items: ['P-005'] });
    // recipes:search uses intent as the query; result folded COMPACT (id/title/runCount/similarity).
    expect(calls.find((c) => c.name === 'recipes:search')!.args).toMatchObject({ query: 'implement P-005', limit: 3 });
    expect(r.recipes).toEqual([{ id: 'fan-out-wi', title: 'Fan-out work items', runCount: 7, similarity: 0.82 }]);
    // order: core three → memory → plan-events → recipes → declare
    expect(calls.map((c) => c.name)).toEqual([
      'fleet:assignments',
      'work_items:list',
      'coord:inbox',
      'memory:search',
      'coord:plan-events',
      'coord:whoami',
      'recipes:search',
      'coord:declare-intent',
    ]);
  });

  it('folds intent-relevant recipes (recipes:search), compact; skipped when includeRecipes:false', async () => {
    const recipeHandler = () => ({
      ok: true,
      recipes: [{ id: 'sweep-stale', title: 'Sweep stale items', description: 'd', runCount: 3, toolsUsed: ['work_items:list'], similarity: 0.7 }],
    });
    // present + relevant → folded
    {
      const { call, calls } = fakeCall({ ...CORE, 'recipes:search': recipeHandler });
      const r = await composeOrient({ intent: 'tidy the backlog' }, call, 'me');
      expect(calls.find((c) => c.name === 'recipes:search')!.args).toMatchObject({ query: 'tidy the backlog', limit: 3 });
      expect(r.recipes).toEqual([{ id: 'sweep-stale', title: 'Sweep stale items', runCount: 3, similarity: 0.7 }]);
    }
    // includeRecipes:false → no recipes:search call, field absent
    {
      const { call, calls } = fakeCall({ ...CORE, 'recipes:search': recipeHandler });
      const r = await composeOrient({ intent: 'tidy the backlog', includeRecipes: false }, call, 'me');
      expect(calls.some((c) => c.name === 'recipes:search')).toBe(false);
      expect(r.recipes).toBeUndefined();
    }
    // no intent/memoryQuery → nothing to search, field absent
    {
      const { call, calls } = fakeCall({ ...CORE, 'recipes:search': recipeHandler });
      const r = await composeOrient({}, call, 'me');
      expect(calls.some((c) => c.name === 'recipes:search')).toBe(false);
      expect(r.recipes).toBeUndefined();
    }
  });

  it('best-effort: a failing recipes:search degrades to null, not a thrown orient', async () => {
    const { call } = fakeCall({
      ...CORE,
      'recipes:search': () => {
        throw new Error('capability: intel:read required');
      },
    });
    const r = await composeOrient({ intent: 'x' }, call, 'me');
    expect(r.ok).toBe(true);
    expect(r.recipes).toBeNull();
    expect(r.claimable).toHaveLength(2);
  });

  it('memoryQuery overrides intent for the recall query', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'memory:search': () => ({ ok: true, results: [] }),
      'coord:declare-intent': () => ({ ok: true }),
    });
    await composeOrient({ intent: 'declare this', memoryQuery: 'search that' }, call, 'me');
    expect(calls.find((c) => c.name === 'memory:search')!.args).toMatchObject({ query: 'search that' });
    expect(calls.find((c) => c.name === 'coord:declare-intent')!.args).toMatchObject({ intent: 'declare this' });
  });

  it('includePlanEvents:false skips the plan-events fold', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    const r = await composeOrient({ includePlanEvents: false }, call, 'me');
    expect(calls.some((c) => c.name === 'coord:plan-events')).toBe(false);
    expect(r.planEvents).toBeUndefined();
  });

  it('D-008 COMPACT: truncates long memory text and caps the plan-events fold', async () => {
    const bigText = 'x'.repeat(5000);
    const manyEvents = Array.from({ length: 100 }, (_, i) => ({ i }));
    const { call } = fakeCall({
      ...CORE,
      'coord:plan-events': () => ({ events: manyEvents, total: 100, truncated: true }),
      'memory:search': () => ({ ok: true, results: [{ id: 'm', memory: bigText, score: 0.5 }] }),
      'coord:declare-intent': () => ({ ok: true }),
    });
    const r = await composeOrient({ intent: 'big' }, call, 'me');
    expect(r.memory!.hits[0].memory!.length).toBe(200); // MEMORY_TEXT_CAP
    expect(r.planEvents!.recent.length).toBe(10); // PLAN_EVENTS_FOLD
    expect(r.planEvents!.total).toBe(100); // true total still reported
    // whole serialized payload stays small despite huge inputs
    expect(JSON.stringify(r).length).toBeLessThan(4000);
  });

  it('best-effort: a failing memory recall or declare degrades to null/false, not a thrown orient', async () => {
    const { call } = fakeCall({
      ...CORE,
      'memory:search': () => {
        throw new Error('memory_timeout');
      },
      'coord:declare-intent': () => {
        throw new Error('capability: coord:write required');
      },
    });
    const r = await composeOrient({ intent: 'x' }, call, 'me');
    expect(r.ok).toBe(true);
    expect(r.memory).toBeNull();
    expect(r.intentDeclared).toBe(false);
    // core orientation still intact
    expect(r.claimable).toHaveLength(2);
  });

  it('folds a fleet catch-up when the caller belongs to a fleet (P-006 auto-catch-up)', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ audience: '@fleet:backend', count: 2, total: 5, rows: [{ msg_id: 'f1' }, { msg_id: 'f2' }] }),
    });
    const r = await composeOrient({}, call, 'me');
    expect(r.fleetCatchUp).toEqual({ fleet: 'backend', total: 5, recent: [{ msg_id: 'f1' }, { msg_id: 'f2' }] });
    // addressed the caller's OWN fleet, bounded by the default fold limit
    expect(calls.find((c) => c.name === 'coord:catch-up')!.args).toMatchObject({ audience: '@fleet:backend', limit: 8 });
  });

  it('skips the fleet catch-up for a non-fleet caller (no catch-up call, field absent)', async () => {
    const { call, calls } = fakeCall({ ...CORE }); // CORE whoami → fleetSlug null
    const r = await composeOrient({}, call, 'me');
    expect(calls.some((c) => c.name === 'coord:catch-up')).toBe(false);
    expect(r.fleetCatchUp).toBeUndefined();
  });

  it('best-effort: a failing fleet catch-up degrades to null, not a thrown orient', async () => {
    const { call } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => {
        throw new Error('capability: coord:read required');
      },
      'coord:glance': () => ({ bees: { running: 0, working: 0 } }),
    });
    const r = await composeOrient({}, call, 'me');
    expect(r.ok).toBe(true);
    expect(r.fleetCatchUp).toBeNull();
    expect(r.claimable).toHaveLength(2);
  });

  // ── fold #1 (compaction-fold-audit-2026-07-06): a compact fleet-health glance ──
  const GLANCE = () => ({
    ok: true,
    bees: { running: 3, working: 2 },
    wake: { default: 'auto', stagedTotal: 1, stagedOwners: 1 },
    governor: { anyPaused: false, paused: [] },
    activity: [{ x: 1 }],
    tips: ['t'],
    display: { title: 'human render' },
  });

  it('folds a COMPACT fleet-health glance for a fleet caller (bees/wake/governor only)', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 0, rows: [] }),
      'coord:glance': GLANCE,
    });
    const r = await composeOrient({}, call, 'me');
    // COMPACT: only the health subset — no activity rows, tips, or display block.
    expect(r.fleetHealth).toEqual({
      bees: { running: 3, working: 2 },
      wake: { default: 'auto', stagedTotal: 1, stagedOwners: 1 },
      governor: { anyPaused: false, paused: [] },
    });
    // called with the lean agent audience + no activity rows (skip the human render).
    expect(calls.find((c) => c.name === 'coord:glance')!.args).toMatchObject({ audience: 'su', activity_limit: 0 });
  });

  it('skips the fleet-health glance off-fleet, and when includeFleetHealth:false', async () => {
    // non-fleet caller → no glance call, field absent
    {
      const { call, calls } = fakeCall({ ...CORE, 'coord:glance': GLANCE });
      const r = await composeOrient({}, call, 'me');
      expect(calls.some((c) => c.name === 'coord:glance')).toBe(false);
      expect(r.fleetHealth).toBeUndefined();
    }
    // in a fleet but includeFleetHealth:false → no glance call
    {
      const { call, calls } = fakeCall({
        ...CORE,
        'coord:whoami': () => ({ fleetSlug: 'backend' }),
        'coord:catch-up': () => ({ total: 0, rows: [] }),
        'coord:glance': GLANCE,
      });
      const r = await composeOrient({ includeFleetHealth: false }, call, 'me');
      expect(calls.some((c) => c.name === 'coord:glance')).toBe(false);
      expect(r.fleetHealth).toBeUndefined();
    }
  });

  it('best-effort: a failing fleet-health glance degrades to null, not a thrown orient', async () => {
    // WI-3818: the glance leg is now wrapped in withBoundedTimeout, which logs a
    // console.warn on a caught failure (visibility into a degraded leg) — expected
    // here since this test deliberately makes coord:glance throw.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { call } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 0, rows: [] }),
      'coord:glance': () => {
        throw new Error('capability: coord:read required');
      },
    });
    const r = await composeOrient({}, call, 'me');
    expect(r.ok).toBe(true);
    expect(r.fleetHealth).toBeNull();
    expect(r.fleetCatchUp).toEqual({ fleet: 'backend', total: 0, recent: [] });
    expect(r.claimable).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // ── fold #2 (compaction-fold-audit-2026-07-06): afterCompaction beefs the inbox ──
  it('afterCompaction folds MORE inbox entries + fuller bodies (an explicit inboxLimit still wins)', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    await composeOrient({ afterCompaction: true }, call, 'me');
    expect(calls.find((c) => c.name === 'coord:inbox')!.args).toMatchObject({ limit: 25, max_body_chars: 800 });

    const { call: c2, calls: k2 } = fakeCall({ ...CORE });
    await composeOrient({ afterCompaction: true, inboxLimit: 7 }, c2, 'me');
    expect(k2.find((c) => c.name === 'coord:inbox')!.args).toMatchObject({ limit: 7, max_body_chars: 800 });
  });

  // ── EI-8300: mode:'monitor' skips the heavy legs entirely (not just capped output) ──
  describe("mode: 'monitor' (EI-8300 lean leader/monitor-loop tick)", () => {
    it('skips claimable/facts/plan-events/fleet-catch-up/recipes entirely, even with intent set', async () => {
      const { call, calls } = fakeCall({
        ...CORE,
        'coord:whoami': () => ({ fleetSlug: 'backend' }), // would trigger catch-up in full mode
        'coord:declare-intent': () => ({ ok: true }),
      });
      const r = await composeOrient({ intent: 'watch the fleet', mode: 'monitor' }, call, 'leader');
      expect(r.ok).toBe(true);
      expect(r.claimable).toEqual([]);
      expect(r.facts).toBeUndefined();
      expect(r.planEvents).toBeUndefined();
      expect(r.fleetCatchUp).toBeUndefined();
      expect(r.fleetHealth).toBeUndefined(); // fold #1 skipped on a monitor tick too
      expect(r.recipes).toBeUndefined();
      expect(r.memory).toBeUndefined(); // no recall even though `intent` was passed
      expect(r.intentDeclared).toBe(true); // declare-intent still fires (cheap, peer-visible)
      // no round-trip at all for the skipped legs — not just an empty/capped result
      const called = new Set(calls.map((c) => c.name));
      expect(called.has('work_items:list')).toBe(false);
      expect(called.has('coord:plan-events')).toBe(false);
      expect(called.has('coord:catch-up')).toBe(false);
      expect(called.has('coord:glance')).toBe(false); // fold #1: no fleet-health glance on a monitor tick
      expect(called.has('coord:whoami')).toBe(false); // fleet block skipped wholesale
      expect(called.has('recipes:search')).toBe(false);
      expect(called.has('memory:search')).toBe(false);
      // the core kept legs still run
      expect(called.has('fleet:assignments')).toBe(true);
      expect(called.has('coord:inbox')).toBe(true);
      expect(called.has('coord:declare-intent')).toBe(true);
    });

    it('still returns fleet:assignments (me) and the inbox read', async () => {
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({ mode: 'monitor' }, call, 'leader');
      expect((r.me as { agents: Array<{ ownerId: string }> }).agents[0].ownerId).toBe('me');
      expect((r.inbox.summary as { total: number }).total).toBe(3);
    });

    it("default (omitted mode / 'full') is byte-identical to today — every heavy leg still runs", async () => {
      const { call, calls } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(r.claimable).toHaveLength(2);
      expect(calls.some((c) => c.name === 'work_items:list')).toBe(true);
    });

    // ── fleet-leader-frictions P-004: monitor inbox scoped to since-last-shown ──
    describe('monitor inbox watermark (fleet-leader-frictions P-004)', () => {
      const WM_TS = '2026-07-10T03:30:00.000Z';

      it('scopes the monitor inbox read to since_ts = the messages_shown watermark', async () => {
        const { call, calls } = fakeCall({
          ...CORE,
          'coord:watermark': () => ({ owner_id: 'leader', self: true, read_through_ts: WM_TS }),
        });
        const r = await composeOrient({ mode: 'monitor' }, call, 'leader');
        expect(r.ok).toBe(true);
        const inboxCall = calls.find((c) => c.name === 'coord:inbox');
        expect(inboxCall?.args).toMatchObject({ since_ts: WM_TS });
      });

      it('no watermark yet (null read_through_ts) ⇒ the unscoped read', async () => {
        const { call, calls } = fakeCall({
          ...CORE,
          'coord:watermark': () => ({ owner_id: 'leader', self: true, read_through_ts: null }),
        });
        await composeOrient({ mode: 'monitor' }, call, 'leader');
        expect(calls.find((c) => c.name === 'coord:inbox')?.args.since_ts).toBeUndefined();
      });

      it('a FAILED watermark read fails open — unscoped inbox, orient still ok', async () => {
        const { call, calls } = fakeCall({
          ...CORE,
          'coord:watermark': () => {
            throw new Error('pg down');
          },
        });
        const r = await composeOrient({ mode: 'monitor' }, call, 'leader');
        expect(r.ok).toBe(true);
        expect(calls.find((c) => c.name === 'coord:inbox')?.args.since_ts).toBeUndefined();
      });

      it('FULL mode never reads the watermark (unscoped inbox as today)', async () => {
        const { call, calls } = fakeCall({ ...CORE });
        await composeOrient({}, call, 'me');
        expect(calls.some((c) => c.name === 'coord:watermark')).toBe(false);
        expect(calls.find((c) => c.name === 'coord:inbox')?.args.since_ts).toBeUndefined();
      });

      it('afterCompaction OVERRIDES the scoping — a compacted agent needs the fuller re-read ("already shown" ≠ "already known")', async () => {
        const { call, calls } = fakeCall({
          ...CORE,
          'coord:watermark': () => ({ read_through_ts: WM_TS }),
        });
        await composeOrient({ mode: 'monitor', afterCompaction: true }, call, 'leader');
        expect(calls.some((c) => c.name === 'coord:watermark')).toBe(false);
        const inboxCall = calls.find((c) => c.name === 'coord:inbox');
        expect(inboxCall?.args.since_ts).toBeUndefined();
        expect(inboxCall?.args).toMatchObject({ limit: 25, max_body_chars: 800 });
      });
    });
  });

  // ── fleet-reliability-verification-2026-07-10 P-007: leaderBrief fold ──
  describe("mode:'monitor' leaderBrief fold (P-007)", () => {
    const LEADER_BRIEF_RESULT = { ok: true, summary: { fleet: 'p2p-git', members: 2 }, members: [] };

    it('a resolvable fleet LEADER on a monitor tick gets fleet:leader-brief folded in', async () => {
      const { call, calls } = fakeCall({
        ...CORE,
        'fleet:leader-brief': () => LEADER_BRIEF_RESULT,
      });
      const r = await composeOrient(
        { mode: 'monitor' },
        call,
        'leader',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: 'p2p-git', fleetRole: 'leader' },
      );
      expect(r.leaderBrief).toEqual(LEADER_BRIEF_RESULT);
      const briefCall = calls.find((c) => c.name === 'fleet:leader-brief');
      expect(briefCall?.args).toMatchObject({ fleet: 'p2p-git' });
    });

    it('a non-leader fleet MEMBER never triggers the fold (no round-trip)', async () => {
      const { call, calls } = fakeCall({ ...CORE });
      const r = await composeOrient(
        { mode: 'monitor' },
        call,
        'member',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: 'p2p-git', fleetRole: 'member' },
      );
      expect(r.leaderBrief).toBeUndefined();
      expect(calls.some((c) => c.name === 'fleet:leader-brief')).toBe(false);
    });

    it('a leader with NO fleet resolvable never triggers the fold', async () => {
      const { call, calls } = fakeCall({ ...CORE });
      const r = await composeOrient(
        { mode: 'monitor' },
        call,
        'leader',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: null, fleetRole: null },
      );
      expect(r.leaderBrief).toBeUndefined();
      expect(calls.some((c) => c.name === 'fleet:leader-brief')).toBe(false);
    });

    it('FULL mode never triggers the fold, even for a resolvable leader', async () => {
      const { call, calls } = fakeCall({ ...CORE, 'fleet:leader-brief': () => LEADER_BRIEF_RESULT });
      const r = await composeOrient(
        {},
        call,
        'leader',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: 'p2p-git', fleetRole: 'leader' },
      );
      expect(r.leaderBrief).toBeUndefined();
      expect(calls.some((c) => c.name === 'fleet:leader-brief')).toBe(false);
    });

    it('a failed leaderBrief fold degrades to null, never breaks orientation', async () => {
      const { call } = fakeCall({
        ...CORE,
        'fleet:leader-brief': () => {
          throw new Error('down');
        },
      });
      const r = await composeOrient(
        { mode: 'monitor' },
        call,
        'leader',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: 'p2p-git', fleetRole: 'leader' },
      );
      expect(r.ok).toBe(true);
      expect(r.leaderBrief).toBeNull();
    });
  });

  // ── P-002 / D-001: queen-loop steering is withheld from a RESPONSIVE caller's recall ──
  const STEERING_RECALL = {
    'memory:search': () => ({
      ok: true,
      results: [
        { id: 'm-steer', memory: 'Owner steering flipped: pauseNewWork=true, maxBees=3. Place no new bees.', score: 0.9 },
        { id: 'm-ok', memory: 'prefers nuqs over useState', score: 0.8 },
      ],
    }),
    'coord:declare-intent': () => ({ ok: true }),
  };

  it('a responsive caller does NOT receive pauseNewWork/maxBees as a binding recall hit', async () => {
    const { call } = fakeCall({ ...CORE, ...STEERING_RECALL });
    const r = await composeOrient({ intent: 'my task' }, call, 'su-leader', 'responsive');
    expect(r.memory!.hits.map((h) => h.id)).toEqual(['m-ok']); // steering hit stripped
    expect(r.memory!.withheld).toBe(1);
  });

  it('an AUTO caller (the queen-bee loop) still receives its own steering recall', async () => {
    const { call } = fakeCall({ ...CORE, ...STEERING_RECALL });
    const r = await composeOrient({ intent: 'place work' }, call, 's-queen', 'auto');
    expect(r.memory!.hits.map((h) => h.id)).toEqual(['m-steer', 'm-ok']);
    expect(r.memory!.withheld).toBeUndefined();
  });

  it('no driveMode passed ⇒ nothing withheld (backward-compatible default)', async () => {
    const { call } = fakeCall({ ...CORE, ...STEERING_RECALL });
    const r = await composeOrient({ intent: 'x' }, call, 'me');
    expect(r.memory!.hits).toHaveLength(2);
    expect(r.memory!.withheld).toBeUndefined();
  });
});

describe('memory-recall relevance floor — P-004 fleet-member-dx (EI-9017)', () => {
  const CORE_FLOOR = {
    'fleet:assignments': () => ({ ok: true, summary: {}, agents: [] }),
    'work_items:list': () => [],
    'coord:inbox': () => ({ summary: { total: 0 }, entries: [] }),
    'coord:plan-events': () => ({ total: 0, recent: [] }),
    'coord:whoami': () => ({ fleetSlug: null }),
    'recipes:search': () => ({ ok: true, recipes: [] }),
    'coord:declare-intent': () => ({ ok: true }),
  };

  it('drops near-zero-score hits (degraded-embedder noise) and surfaces filteredLowScore', async () => {
    const { call } = fakeCall({
      ...CORE_FLOOR,
      'memory:search': () => ({
        ok: true,
        results: [
          { id: 'good', memory: 'a real recall hit', score: 0.42 },
          { id: 'noise1', memory: 'lexical-fallback noise', score: 0.0306 },
          { id: 'noise2', memory: 'more noise', score: 0.016 },
        ],
      }),
    });
    const r = await composeOrient({ intent: 'do the thing' }, call, 'me');
    expect(r.memory?.hits.map((h) => h.id)).toEqual(['good']);
    expect((r.memory as { filteredLowScore?: number }).filteredLowScore).toBe(2);
  });

  it('a hit with NO numeric score passes (fail-open), and no noise ⇒ no filteredLowScore key', async () => {
    const { call } = fakeCall({
      ...CORE_FLOOR,
      'memory:search': () => ({
        ok: true,
        results: [
          { id: 'unscored', memory: 'no score field' },
          { id: 'good', memory: 'scored fine', score: 0.5 },
        ],
      }),
    });
    const r = await composeOrient({ intent: 'do the thing' }, call, 'me');
    expect(r.memory?.hits.map((h) => h.id)).toEqual(['unscored', 'good']);
    expect('filteredLowScore' in (r.memory as object)).toBe(false);
  });
});

// ── EI-9031: orient must PROPAGATE memory:search's degraded signal so an empty
// recall during an embedding-backend outage is NOT read as "nothing relevant
// exists". Before the fix, orient dropped ok/reason/degraded and folded a bare
// `hits: []` — byte-indistinguishable from a genuine empty. ──
describe('memory recall degraded propagation — EI-9031', () => {
  const CORE_DEG = {
    'fleet:assignments': () => ({ ok: true, summary: {}, agents: [] }),
    'work_items:list': () => [],
    'coord:inbox': () => ({ summary: { total: 0 }, entries: [] }),
    'coord:plan-events': () => ({ total: 0, recent: [] }),
    'coord:whoami': () => ({ fleetSlug: null }),
    'recipes:search': () => ({ ok: true, recipes: [] }),
    'coord:declare-intent': () => ({ ok: true }),
  };

  it('stamps degraded + degradedReason when memory:search reports an embed failure (empty is NOT informative)', async () => {
    const { call } = fakeCall({
      ...CORE_DEG,
      // The exact shape the memory:search embed-failure branch returns.
      'memory:search': () => ({ ok: false, reason: 'embed_quota_exhausted', degraded: true, results: [] }),
    });
    const r = await composeOrient({ intent: 'own-log-fork-guard work' }, call, 'me');
    expect(r.memory?.hits).toEqual([]);
    expect((r.memory as { degraded?: boolean }).degraded).toBe(true);
    expect((r.memory as { degradedReason?: string }).degradedReason).toBe('embed_quota_exhausted');
  });

  it('stamps degraded from the ok:true reduced-breadth fallback (silent local-vec empty), preferring degraded_reason', async () => {
    const { call } = fakeCall({
      ...CORE_DEG,
      // OpenAI in cooldown → auto cascade fell back to local vec table → ok:true but empty.
      'memory:search': () => ({ ok: true, degraded: true, degraded_reason: 'embedding_backend_degraded', results: [] }),
    });
    const r = await composeOrient({ intent: 'own-log-fork-guard work' }, call, 'me');
    expect(r.memory?.hits).toEqual([]);
    expect((r.memory as { degraded?: boolean }).degraded).toBe(true);
    expect((r.memory as { degradedReason?: string }).degradedReason).toBe('embedding_backend_degraded');
  });

  it('a HEALTHY recall carries no degraded marker (backward-compatible)', async () => {
    const { call } = fakeCall({
      ...CORE_DEG,
      'memory:search': () => ({ ok: true, results: [{ id: 'm1', memory: 'a real hit', score: 0.7 }] }),
    });
    const r = await composeOrient({ intent: 'x' }, call, 'me');
    expect(r.memory?.hits.map((h) => h.id)).toEqual(['m1']);
    expect('degraded' in (r.memory as object)).toBe(false);
    expect('degradedReason' in (r.memory as object)).toBe(false);
  });
});

// ── P-004 (fleet-deltas-leader-primitives): monitor-mode fleet DELTA over the
// injected server-side read cursor — the caller carries nothing.
describe("mode:'monitor' fleet delta (P-004 server-side cursor)", () => {
  const FLEET = {
    ...CORE,
    'fleet:assignments': () => ({
      ok: true,
      summary: { agents: 3 },
      agents: [
        { agentId: 'su-lead', isSelf: true, verdict: 'speaking', sessionState: 'live', claims: 1 },
        { agentId: 'su-a', verdict: 'speaking', sessionState: 'live', doing: 'WI-1', claims: 2 },
        { agentId: 'su-b', verdict: 'stalled', sessionState: 'live', claims: 1 },
      ],
      orphaned: [],
      stalled: [{ id: 'WI-9' }],
    }),
  };

  it('BASELINE (first read): fleetDelta.baseline=true and `me` keeps the FULL roster', async () => {
    const { call } = fakeCall({ ...FLEET });
    const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
    const r = await composeOrient({ mode: 'monitor' }, call, 'su-lead', undefined, undefined, cursor);
    expect(r.fleetDelta).toEqual({ baseline: true });
    expect((r.me as { agents: unknown[] }).agents).toHaveLength(3);
    // The cursor received THIS read's fingerprint — the next call diffs against it.
    expect(cursor).toHaveBeenCalledWith(
      expect.objectContaining({
        members: expect.objectContaining({ 'su-b': { v: 'stalled', s: 'live', c: 1 } }),
        stalled: 1,
      }),
    );
  });

  it('DELTA: transitions since committed; `me` slims to the self row + agentsElided', async () => {
    const { call } = fakeCall({ ...FLEET });
    const committed = {
      members: {
        'su-lead': { v: 'speaking', s: 'live', c: 1 },
        'su-a': { v: 'speaking', s: 'live', d: 'WI-1', c: 2 },
        'su-b': { v: 'speaking', s: 'live', c: 1 }, // was speaking, now stalled
      },
      orphaned: 0,
      stalled: 0,
    };
    const cursor = vi.fn(async () => ({ committed, baseline: false }));
    const r = await composeOrient({ mode: 'monitor' }, call, 'su-lead', undefined, undefined, cursor);
    expect(r.fleetDelta?.baseline).toBe(false);
    expect(r.fleetDelta?.changes).toEqual([
      {
        change: 'updated',
        type: 'member',
        id: 'su-b',
        from: { v: 'speaking', s: 'live', c: 1 },
        to: { v: 'stalled', s: 'live', c: 1 },
      },
    ]);
    expect(r.fleetDelta?.unchanged).toBe(2);
    expect(r.fleetDelta?.stalled).toEqual({ from: 0, to: 1 });
    const me = r.me as { agents: Array<{ agentId: string }>; agentsElided: number };
    expect(me.agents).toEqual([expect.objectContaining({ agentId: 'su-lead', isSelf: true })]);
    expect(me.agentsElided).toBe(2);
  });

  it('FAIL-OPEN: a throwing cursor keeps the full roster fold and omits fleetDelta', async () => {
    const { call } = fakeCall({ ...FLEET });
    const cursor = vi.fn(async () => { throw new Error('pg down'); });
    const r = await composeOrient({ mode: 'monitor' }, call, 'su-lead', undefined, undefined, cursor);
    expect(r.fleetDelta).toBeUndefined();
    expect((r.me as { agents: unknown[] }).agents).toHaveLength(3);
  });

  it('FAIL-OPEN: an unrecognizable roster shape (e.g. TOON string) never touches the cursor', async () => {
    const { call } = fakeCall({ ...FLEET, 'fleet:assignments': () => 'opaque-toon-string' });
    const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
    const r = await composeOrient({ mode: 'monitor' }, call, 'su-lead', undefined, undefined, cursor);
    expect(cursor).not.toHaveBeenCalled();
    expect(r.fleetDelta).toBeUndefined();
    expect(r.me).toBe('opaque-toon-string');
  });

  it('P-005: FULL mode ALSO consults an injected cursor (the handler, not composeOrient, decides per-mode whether to inject — see the full-mode delta describe block below)', async () => {
    const { call } = fakeCall({ ...FLEET });
    const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
    const r = await composeOrient({}, call, 'su-lead', undefined, undefined, cursor);
    expect(cursor).toHaveBeenCalledTimes(1);
    expect(r.fleetDelta).toEqual({ baseline: true });
  });

  it('no cursor injected (flag off / unresolved identity) ⇒ pre-P-004 monitor behavior, byte-identical', async () => {
    const { call } = fakeCall({ ...FLEET });
    const r = await composeOrient({ mode: 'monitor' }, call, 'su-lead');
    expect(r.fleetDelta).toBeUndefined();
    expect((r.me as { agents: unknown[] }).agents).toHaveLength(3);
  });
});

describe('P-005 full-mode delta (plan-events + fleet catch-up, server-side cursors)', () => {
  const EVENTS_V1 = [{ msg_id: 'e1', kind: 'item_status_changed', detail: 'P-001' }];
  const EVENTS_V2 = [{ msg_id: 'e2', kind: 'item_status_changed', detail: 'P-002' }, { msg_id: 'e1', kind: 'item_status_changed', detail: 'P-001' }];
  const CATCHUP_V1 = [{ msg_id: 'c1', summary: 'hello' }];

  it('plan-events BASELINE: full delivery, cursor receives this batch\'s id fingerprint', async () => {
    const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V1, total: 1 }) });
    const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
    expect(r.planEvents).toEqual({ total: 1, recent: EVENTS_V1 });
    expect(cursor).toHaveBeenCalledWith({ ids: ['e1'] });
  });

  it('plan-events UNCHANGED: same ids as committed ⇒ recent:[] + unchanged:true, total still fresh', async () => {
    const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V1, total: 7 }) });
    const cursor = vi.fn(async () => ({ committed: { ids: ['e1'] }, baseline: false }));
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
    expect(r.planEvents).toEqual({ total: 7, recent: [], unchanged: true });
  });

  it('plan-events CHANGED: different ids than committed ⇒ full delivery, no unchanged marker', async () => {
    const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V2, total: 2 }) });
    const cursor = vi.fn(async () => ({ committed: { ids: ['e1'] }, baseline: false }));
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
    expect(r.planEvents).toEqual({ total: 2, recent: EVENTS_V2 });
  });

  it('plan-events FAIL-OPEN: a throwing cursor still delivers in full (no unchanged, no throw)', async () => {
    const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V1, total: 1 }) });
    const cursor = vi.fn(async () => { throw new Error('pg down'); });
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
    expect(r.planEvents).toEqual({ total: 1, recent: EVENTS_V1 });
  });

  it('plan-events: no cursor injected ⇒ pre-P-005 behavior, byte-identical', async () => {
    const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V1, total: 1 }) });
    const r = await composeOrient({}, call, 'me');
    expect(r.planEvents).toEqual({ total: 1, recent: EVENTS_V1 });
  });

  it('fleet catch-up UNCHANGED: same row ids as committed ⇒ recent:[] + unchanged:true', async () => {
    const { call } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 9, rows: CATCHUP_V1 }),
    });
    const cursor = vi.fn(async () => ({ committed: { ids: ['c1'] }, baseline: false }));
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, undefined, cursor);
    expect(r.fleetCatchUp).toEqual({ fleet: 'backend', total: 9, recent: [], unchanged: true });
  });

  it('fleet catch-up CHANGED: delivers in full and updates the cursor', async () => {
    const { call } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 1, rows: CATCHUP_V1 }),
    });
    const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, undefined, cursor);
    expect(r.fleetCatchUp).toEqual({ fleet: 'backend', total: 1, recent: CATCHUP_V1 });
    expect(cursor).toHaveBeenCalledWith({ ids: ['c1'] });
  });

  it('fleet catch-up FAIL-OPEN: a throwing cursor still delivers in full', async () => {
    const { call } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 1, rows: CATCHUP_V1 }),
    });
    const cursor = vi.fn(async () => { throw new Error('pg down'); });
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, undefined, cursor);
    expect(r.fleetCatchUp).toEqual({ fleet: 'backend', total: 1, recent: CATCHUP_V1 });
  });

  describe('EI-9130 orientServedDelta — generic delta-served breadcrumb', () => {
    it('true when fleetDelta actually served transitions (baseline:false)', async () => {
      const { call } = fakeCall({
        ...CORE,
        'fleet:assignments': () => ({
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: 'me', verdict: 'stalled', sessionState: 'live', claims: 1 }],
          orphaned: [],
          stalled: [],
        }),
      });
      const cursor = vi.fn(async () => ({
        committed: { members: { me: { v: 'speaking', s: 'live', c: 1 } }, orphaned: 0, stalled: 0 },
        baseline: false,
      }));
      const r = await composeOrient({ mode: 'monitor' }, call, 'me', undefined, undefined, cursor);
      expect(orientServedDelta(r)).toBe(true);
    });

    it('true when plan-events resolved unchanged', async () => {
      const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V1, total: 7 }) });
      const cursor = vi.fn(async () => ({ committed: { ids: ['e1'] }, baseline: false }));
      const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
      expect(orientServedDelta(r)).toBe(true);
    });

    it('true when fleet catch-up resolved unchanged', async () => {
      const { call } = fakeCall({
        ...CORE,
        'coord:whoami': () => ({ fleetSlug: 'backend' }),
        'coord:catch-up': () => ({ total: 9, rows: CATCHUP_V1 }),
      });
      const cursor = vi.fn(async () => ({ committed: { ids: ['c1'] }, baseline: false }));
      const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, undefined, cursor);
      expect(orientServedDelta(r)).toBe(true);
    });

    it('false on a baseline (first) read — nothing was actually narrowed', async () => {
      const { call } = fakeCall({ ...CORE });
      const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
      const r = await composeOrient({ mode: 'monitor' }, call, 'me', undefined, undefined, cursor);
      expect(orientServedDelta(r)).toBe(false);
    });

    it('false when no cursor mechanism is engaged at all (flag off / pre-P-004 shape)', async () => {
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(orientServedDelta(r)).toBe(false);
    });

    it('false when plan-events changed (full delivery, no unchanged marker)', async () => {
      const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V2, total: 2 }) });
      const cursor = vi.fn(async () => ({ committed: { ids: ['e1'] }, baseline: false }));
      const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
      expect(orientServedDelta(r)).toBe(false);
    });
  });

  // WI-3818: fleet:assignments (`me`) and coord:glance (`fleetHealth`) fan out to
  // presence/assignments/Tier-1 reads with no internal budget — during the
  // 2026-07-10 host-load storm either could hang orient until the 55s MCP client
  // timeout. Both legs are now bounded (withBoundedTimeout) and degrade instead
  // of hanging; these tests exercise the ACTUAL timeout path (not just a thrown
  // error, already covered above) with fake timers.
  describe('WI-3818 bounded fleet legs — a hung call degrades instead of hanging orient', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('`me` degrades to a minimal empty-roster shape when fleet:assignments never resolves (BOTH modes affected — this is the one fleet-related call monitor mode makes)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'fleet:assignments': () => new Promise(() => {}),
      });
      const resultPromise = composeOrient({ mode: 'monitor' }, call, 'me');
      await vi.advanceTimersByTimeAsync(8_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect(r.me).toEqual({ ok: false, degraded: true, agents: [] });
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('`me` degrading never crashes the full-mode delta fold (fingerprintFleet stays try/catch-safe)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'fleet:assignments': () => new Promise(() => {}),
      });
      const fleetCursor = vi.fn(async () => ({ committed: null, baseline: true }));
      const resultPromise = composeOrient({}, call, 'me', undefined, undefined, fleetCursor);
      await vi.advanceTimersByTimeAsync(8_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect(r.claimable).toHaveLength(2); // the rest of orient still completes normally
      warnSpy.mockRestore();
    });

    it('fleetHealth degrades to null (not a hang) when coord:glance never resolves', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'coord:whoami': () => ({ fleetSlug: 'backend' }),
        'coord:catch-up': () => ({ total: 0, rows: [] }),
        'coord:glance': () => new Promise(() => {}),
      });
      const resultPromise = composeOrient({}, call, 'me');
      await vi.advanceTimersByTimeAsync(8_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect(r.fleetHealth).toBeNull();
      expect(r.claimable).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
