/**
 * Unit tests for the Mug's default event-wake subscriptions
 * (start-hive-wake-orchestration-2026-06-09 P-002 / D-001).
 *
 * Persistence (operator-state-pg) is mocked to an in-memory map; the live
 * reaction registry is REAL — so these tests also prove the declarative
 * `when` DataConditions actually match/reject the producer events end-to-end
 * through @papercusp/rules (the P-003 chain minus the dispatcher).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const stateStore = new Map<string, unknown>();
vi.mock('../operator-state-pg', () => ({
  readOperatorState: async (key: string) => stateStore.get(key) ?? null,
  updateOperatorState: async (key: string, empty: unknown, fn: (cur: unknown) => unknown) => {
    const next = fn(stateStore.get(key) ?? empty);
    stateStore.set(key, next);
    return next;
  },
}));

import { matchReactions, _resetReactionsForTests } from '../events/registry';
import type { ToolInvocationEvent } from '../events/types';
import { readPotWakeState, setPotEventSubscriptions } from './wake';
import {
  armDefaultPotWakeSubscriptions,
  blueprintWakeSubscriptions,
  defaultPotEventSubscriptions,
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
  _resetReactionsForTests();
});

describe('defaultPotEventSubscriptions', () => {
  it('covers exactly the three demand producers (OQ-5: start minimal)', () => {
    const subs = defaultPotEventSubscriptions();
    expect(subs.map((s) => s.on)).toEqual(['plans:start', 'work_items:create', 'coord:escalate']);
    for (const s of subs) expect(s.when).toBeDefined();
  });
});

describe('armDefaultPotWakeSubscriptions', () => {
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
