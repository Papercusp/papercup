/**
 * Unit tests for the Mug's default event-wake subscriptions
 * (start-hive-wake-orchestration-2026-06-09 P-002 / D-001).
 *
 * Persistence (operator-state-pg) is mocked to an in-memory map; the live
 * reaction registry is REAL — so these tests also prove the declarative
 * `when` DataConditions actually match/reject the producer events end-to-end
 * through @papercusp/rules (the P-003 chain minus the dispatcher).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ mugKettleEnabled: true }));
// These tests preserve the legacy enabled-tier policy as a pure compatibility
// fixture. The live runtime is permanently retired; the retirement no-op itself
// is pinned below so the old matching semantics remain independently testable.
vi.mock('./started', () => ({
  mugKettleSystemEnabled: async () => runtime.mugKettleEnabled,
}));

const stateStore = new Map<string, unknown>();
vi.mock('../operator-state-pg', () => ({
  readOperatorState: async (key: string) => stateStore.get(key) ?? null,
  updateOperatorState: async (key: string, empty: unknown, fn: (cur: unknown) => unknown) => {
    const next = fn(stateStore.get(key) ?? empty);
    stateStore.set(key, next);
    return next;
  },
}));

// EI-13608: mutable per-test owner-steering stub — readCreateWakeSuppressPlans
// (called from armDefaultPotWakeSubscriptions when `installSlug` is passed) reads
// through this instead of the real hive_settings-backed store.
let mockCreateWakeSuppressPlans: string[] = [];
vi.mock('../owner-steering', () => ({
  getOwnerSteering: async () => ({ createWakeSuppressPlans: mockCreateWakeSuppressPlans }),
}));

import { matchReactions, _resetReactionsForTests } from '../events/registry';
import type { ToolInvocationEvent } from '../events/types';
import { readPotWakeState, setPotEventSubscriptions } from './wake';
import {
  armDefaultPotWakeSubscriptions,
  blueprintWakeSubscriptions,
  defaultPotEventSubscriptions,
  withDefaultPotWakeSubscriptions,
} from './wake-defaults';

const WS = 'test-ws';

const ev = (tool: string, data: unknown, ok = true): ToolInvocationEvent => ({
  tool,
  args: {},
  result: ok ? { ok: true, data } : { ok: false },
  ctx: {} as ToolInvocationEvent['ctx'],
});

const potWakeMatches = (e: ToolInvocationEvent) =>
  matchReactions(e).filter((a) => a.fire === 'pot:wake');

beforeEach(() => {
  stateStore.clear();
  runtime.mugKettleEnabled = true;
  _resetReactionsForTests();
});

describe('defaultPotEventSubscriptions', () => {
  it('covers exactly the three demand producers (OQ-5: start minimal)', () => {
    const subs = defaultPotEventSubscriptions();
    expect(subs.map((s) => s.on)).toEqual(['plans:start', 'work_items:create', 'coord:escalate']);
    for (const s of subs) expect(s.when).toBeDefined();
  });

  it('omits the plan-suppression clause when no suppress list is passed (byte-identical default)', () => {
    const withNoOpt = defaultPotEventSubscriptions();
    const withEmpty = defaultPotEventSubscriptions({ suppressCreateWakePlans: [] });
    const createSub = withNoOpt.find((s) => s.on === 'work_items:create');
    expect(createSub?.when).not.toHaveProperty('args.plan_item.slug');
    expect(withEmpty.find((s) => s.on === 'work_items:create')?.when).toEqual(createSub?.when);
  });

  it('adds an args.plan_item.slug notIn clause when a suppress list is passed (EI-13608)', () => {
    const subs = defaultPotEventSubscriptions({ suppressCreateWakePlans: ['p2p-public-release-remaining-lanes-2026-07-16'] });
    const createSub = subs.find((s) => s.on === 'work_items:create');
    expect(createSub?.when).toMatchObject({
      'args.plan_item.slug': { notIn: ['p2p-public-release-remaining-lanes-2026-07-16'] },
    });
  });
});

describe('EI-13608 — plan-scoped create-wake suppression (end-to-end match)', () => {
  const armSuppressed = (plans: string[]) =>
    setPotEventSubscriptions(WS, defaultPotEventSubscriptions({ suppressCreateWakePlans: plans }));

  const evWithArgs = (tool: string, args: unknown, data: unknown): ToolInvocationEvent => ({
    tool,
    args: args as Record<string, unknown>,
    result: { ok: true, data },
    ctx: {} as ToolInvocationEvent['ctx'],
  });

  beforeEach(async () => {
    await armSuppressed(['forbidden-plan']);
  });

  it('suppresses the wake for an unassigned create linked to a named forbidden plan', () => {
    const e = evWithArgs(
      'work_items:create',
      { plan_item: { slug: 'forbidden-plan', item: 'P-001' } },
      { ok: true, workItem: { id: 'WI-1' } },
    );
    expect(potWakeMatches(e)).toHaveLength(0);
  });

  it('still wakes for an unassigned create with NO plan_item at all (undefined notIn list ⇒ still fires)', () => {
    const e = evWithArgs('work_items:create', {}, { ok: true, workItem: { id: 'WI-2' } });
    expect(potWakeMatches(e)).toHaveLength(1);
  });

  it('still wakes for an unassigned create linked to a DIFFERENT (non-suppressed) plan', () => {
    const e = evWithArgs(
      'work_items:create',
      { plan_item: { slug: 'some-other-plan', item: 'P-001' } },
      { ok: true, workItem: { id: 'WI-3' } },
    );
    expect(potWakeMatches(e)).toHaveLength(1);
  });

  it('a PRE-ASSIGNED create on the forbidden plan is still skipped by EI-1850 regardless', () => {
    const e = evWithArgs(
      'work_items:create',
      { plan_item: { slug: 'forbidden-plan', item: 'P-001' } },
      { ok: true, workItem: { id: 'WI-4', assignee: 'cup-1' } },
    );
    expect(potWakeMatches(e)).toHaveLength(0);
  });
});

describe('withDefaultPotWakeSubscriptions (EI-10525 — always-armed demand-wake invariant)', () => {
  it('unions all three defaults onto an EMPTY declared set (a time-only re-declaration)', () => {
    expect(withDefaultPotWakeSubscriptions([]).map((s) => s.on)).toEqual([
      'plans:start',
      'work_items:create',
      'coord:escalate',
    ]);
  });
  it("keeps the Mug's declared subs verbatim (first) and adds only the uncovered defaults", () => {
    const declared = [{ on: 'coord:escalate', when: { 'result.data.ok': true }, note: 'mine' }];
    const merged = withDefaultPotWakeSubscriptions(declared);
    expect(merged[0]).toEqual(declared[0]); // hers, verbatim + first — covers the coord:escalate default
    expect(merged.map((s) => s.on)).toEqual(['coord:escalate', 'plans:start', 'work_items:create']);
  });
  it('honors a non-empty explicit defaults set (blueprint-declared wakes)', () => {
    expect(withDefaultPotWakeSubscriptions([], [{ on: 'release:green' }]).map((s) => s.on)).toEqual([
      'release:green',
    ]);
  });
});

describe('armDefaultPotWakeSubscriptions', () => {

  it('does not arm refused wake rules after the Mug/Kettle/Cup tier retires (P-068)', async () => {
    runtime.mugKettleEnabled = false;

    const result = await armDefaultPotWakeSubscriptions(WS, { mode: 'replace' });

    expect(result).toEqual({ rules: 0, added: 0 });
    expect((await readPotWakeState(WS)).subscriptions).toEqual([]);
    expect(potWakeMatches(ev('work_items:create', { ok: true, workItem: { id: 'WI-retired' } }))).toHaveLength(0);
  });

  it("'replace' persists the defaults and projects three live rules", async () => {
    const { rules, added } = await armDefaultPotWakeSubscriptions(WS, { mode: 'replace' });
    expect(rules).toBe(3);
    expect(added).toBe(3);
    expect((await readPotWakeState(WS)).subscriptions).toHaveLength(3);
  });

  it("'ensure' keeps the Mug's tuned subscriptions verbatim and adds only the uncovered defaults", async () => {
    // The Mug tuned plans:start (her own when) and added a custom topic.
    await setPotEventSubscriptions(WS, [
      { on: 'plans:start', when: { 'result.data.slug': 'only-this-plan' }, note: 'mug-tuned' },
      { on: 'gym:judge', note: 'mug-added' },
    ]);
    const { added } = await armDefaultPotWakeSubscriptions(WS, { mode: 'ensure' });
    expect(added).toBe(2); // work_items:create + coord:escalate; plans:start stays hers

    const subs = (await readPotWakeState(WS)).subscriptions;
    expect(subs).toHaveLength(4);
    const plansSub = subs.find((s) => s.on === 'plans:start');
    expect(plansSub?.note).toBe('mug-tuned');
    expect(plansSub?.when).toEqual({ 'result.data.slug': 'only-this-plan' });
    expect(subs.some((s) => s.on === 'gym:judge')).toBe(true);
  });

  it("'ensure' on an empty state arms all three (the Start self-heal path)", async () => {
    const { added, rules } = await armDefaultPotWakeSubscriptions(WS, { mode: 'ensure' });
    expect(added).toBe(3);
    expect(rules).toBe(3);
  });
});

describe('armDefaultPotWakeSubscriptions + installSlug (EI-13608 owner-steering wiring)', () => {
  afterEach(() => {
    mockCreateWakeSuppressPlans = [];
  });

  it('folds owner-steering createWakeSuppressPlans into the built-in work_items:create default', async () => {
    mockCreateWakeSuppressPlans = ['forbidden-plan'];
    await armDefaultPotWakeSubscriptions(WS, { mode: 'replace', installSlug: 'papercusp' });
    const createSub = (await readPotWakeState(WS)).subscriptions.find((s) => s.on === 'work_items:create');
    expect(createSub?.when).toMatchObject({ 'args.plan_item.slug': { notIn: ['forbidden-plan'] } });
  });

  it('omitting installSlug never looks up owner-steering (no suppression, unchanged behavior)', async () => {
    mockCreateWakeSuppressPlans = ['forbidden-plan']; // would apply if (wrongly) consulted
    const { rules } = await armDefaultPotWakeSubscriptions(WS, { mode: 'replace' });
    expect(rules).toBe(3);
    const createSub = (await readPotWakeState(WS)).subscriptions.find((s) => s.on === 'work_items:create');
    expect(createSub?.when).not.toHaveProperty('args.plan_item.slug');
  });
});

describe('blueprintWakeSubscriptions (P-013 — blueprint-declared wakes override the defaults)', () => {
  it('returns undefined when the blueprint declares no wake (→ caller uses the built-in three)', () => {
    expect(blueprintWakeSubscriptions(undefined)).toBeUndefined();
    expect(blueprintWakeSubscriptions({})).toBeUndefined();
    expect(blueprintWakeSubscriptions({ subscriptions: [] })).toBeUndefined();
  });

  it('maps declared { on, note } subscriptions verbatim', () => {
    expect(
      blueprintWakeSubscriptions({ subscriptions: [{ on: 'release:green', note: 'ship wake' }, { on: 'plans:start' }] }),
    ).toEqual([{ on: 'release:green', note: 'ship wake' }, { on: 'plans:start' }]);
  });

  it("'replace' with blueprint subscriptions arms THOSE, not the built-in three", async () => {
    const subs = blueprintWakeSubscriptions({ subscriptions: [{ on: 'release:green', note: 'ship' }] });
    const { rules, added } = await armDefaultPotWakeSubscriptions(WS, { mode: 'replace', subscriptions: subs });
    expect(rules).toBe(1);
    expect(added).toBe(1);
    expect((await readPotWakeState(WS)).subscriptions.map((s) => s.on)).toEqual(['release:green']);
  });

  it("'replace' with no blueprint subscriptions falls back to the built-in three (coding pot unchanged)", async () => {
    const { rules } = await armDefaultPotWakeSubscriptions(WS, { mode: 'replace', subscriptions: undefined });
    expect(rules).toBe(3);
    expect((await readPotWakeState(WS)).subscriptions.map((s) => s.on)).toEqual([
      'plans:start',
      'work_items:create',
      'coord:escalate',
    ]);
  });
});

describe('the armed defaults match the producer events (P-003 core, pre-dispatch)', () => {
  beforeEach(async () => {
    await armDefaultPotWakeSubscriptions(WS, { mode: 'replace' });
  });

  it('plans:start wakes ONLY on a real transition', () => {
    expect(potWakeMatches(ev('plans:start', { slug: 'p', transitioned: true }))).toHaveLength(1);
    expect(potWakeMatches(ev('plans:start', { slug: 'p', transitioned: false }))).toHaveLength(0);
  });

  it('work_items:create wakes on an UNPLACED (unassigned) create but NOT a pre-assigned one (EI-1850)', () => {
    // Unassigned (no assignee field, or explicit null) → needs the Mug to place it → wake.
    expect(potWakeMatches(ev('work_items:create', { ok: true, workItem: { id: 'WI-1' } }))).toHaveLength(1);
    expect(potWakeMatches(ev('work_items:create', { ok: true, workItem: { id: 'WI-1', assignee: null } }))).toHaveLength(1);
    // Pre-placed / self-assigned (assignee set, e.g. work_items:create {assign_to} from a warm
    // loop) → already owned → must NOT wake the Mug every cycle (the EI-1850 fix).
    expect(potWakeMatches(ev('work_items:create', { ok: true, workItem: { id: 'WI-2', assignee: 'cup-7' } }))).toHaveLength(0);
    // In-band failure stays silent.
    expect(potWakeMatches(ev('work_items:create', { ok: false, error: 'dup' }))).toHaveLength(0);
  });

  it('coord:escalate wakes on a successful open', () => {
    expect(potWakeMatches(ev('coord:escalate', { ok: true, msg_id: 'm' }))).toHaveLength(1);
  });

  it('an unsubscribed tool never wakes the Mug', () => {
    expect(potWakeMatches(ev('coord:send', { ok: true }))).toHaveLength(0);
  });

  it('the wake rule carries provenance args (reason + source:event)', () => {
    const [m] = potWakeMatches(ev('plans:start', { transitioned: true }));
    expect(m.args.source).toBe('event');
    expect(String(m.args.reason)).toContain('plans:start');
  });
});
