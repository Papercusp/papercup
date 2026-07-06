import { beforeEach, describe, it, expect, vi } from 'vitest';
import { composeOrient } from './orient';
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

/** The core three + plan-events (the default folds when no `intent` is passed). */
const CORE = {
  'fleet:assignments': () => ({ ok: true, summary: { agents: 1 }, agents: [{ ownerId: 'me' }] }),
  'work_items:list': () => [{ id: 'WI-1', state: 'todo' }, { id: 'WI-2', state: 'todo' }],
  'coord:inbox': () => ({ summary: { total: 3 }, entries: [{ msg_id: 'm1' }] }),
  'coord:plan-events': () => ({ events: [{ kind: 'item_status_changed', plan: 'p1' }], total: 1, truncated: false }),
  'coord:whoami': () => ({ fleetSlug: null }),
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
    });
    const r = await composeOrient({}, call, 'me');
    expect(r.ok).toBe(true);
    expect(r.fleetCatchUp).toBeNull();
    expect(r.claimable).toHaveLength(2);
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
