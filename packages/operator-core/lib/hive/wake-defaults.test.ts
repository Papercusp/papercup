/**
 * Unit tests for the Queen's default event-wake subscriptions
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
import { readHiveWakeState, setHiveEventSubscriptions } from './wake';
import { armDefaultHiveWakeSubscriptions, defaultHiveEventSubscriptions } from './wake-defaults';

const WS = 'test-ws';

const ev = (tool: string, data: unknown, ok = true): ToolInvocationEvent => ({
  tool,
  args: {},
  result: ok ? { ok: true, data } : { ok: false },
  ctx: {},
});

const hiveWakeMatches = (e: ToolInvocationEvent) =>
  matchReactions(e).filter((a) => a.fire === 'hive:wake');

beforeEach(() => {
  stateStore.clear();
  _resetReactionsForTests();
});

describe('defaultHiveEventSubscriptions', () => {
  it('covers exactly the three demand producers (OQ-5: start minimal)', () => {
    const subs = defaultHiveEventSubscriptions();
    expect(subs.map((s) => s.on)).toEqual(['plans:start', 'work_items:create', 'coord:escalate']);
    for (const s of subs) expect(s.when).toBeDefined();
  });
});

describe('armDefaultHiveWakeSubscriptions', () => {
  it("'replace' persists the defaults and projects three live rules", async () => {
    const { rules, added } = await armDefaultHiveWakeSubscriptions(WS, { mode: 'replace' });
    expect(rules).toBe(3);
    expect(added).toBe(3);
    expect((await readHiveWakeState(WS)).subscriptions).toHaveLength(3);
  });

  it("'ensure' keeps the Queen's tuned subscriptions verbatim and adds only the uncovered defaults", async () => {
    // The Queen tuned plans:start (her own when) and added a custom topic.
    await setHiveEventSubscriptions(WS, [
      { on: 'plans:start', when: { 'result.data.slug': 'only-this-plan' }, note: 'queen-tuned' },
      { on: 'gym:judge', note: 'queen-added' },
    ]);
    const { added } = await armDefaultHiveWakeSubscriptions(WS, { mode: 'ensure' });
    expect(added).toBe(2); // work_items:create + coord:escalate; plans:start stays hers

    const subs = (await readHiveWakeState(WS)).subscriptions;
    expect(subs).toHaveLength(4);
    const plansSub = subs.find((s) => s.on === 'plans:start');
    expect(plansSub?.note).toBe('queen-tuned');
    expect(plansSub?.when).toEqual({ 'result.data.slug': 'only-this-plan' });
    expect(subs.some((s) => s.on === 'gym:judge')).toBe(true);
  });

  it("'ensure' on an empty state arms all three (the Start self-heal path)", async () => {
    const { added, rules } = await armDefaultHiveWakeSubscriptions(WS, { mode: 'ensure' });
    expect(added).toBe(3);
    expect(rules).toBe(3);
  });
});

describe('the armed defaults match the producer events (P-003 core, pre-dispatch)', () => {
  beforeEach(async () => {
    await armDefaultHiveWakeSubscriptions(WS, { mode: 'replace' });
  });

  it('plans:start wakes ONLY on a real transition', () => {
    expect(hiveWakeMatches(ev('plans:start', { slug: 'p', transitioned: true }))).toHaveLength(1);
    expect(hiveWakeMatches(ev('plans:start', { slug: 'p', transitioned: false }))).toHaveLength(0);
  });

  it('work_items:create wakes only on ok:true (in-band failure stays silent)', () => {
    expect(hiveWakeMatches(ev('work_items:create', { ok: true, workItem: { id: 'WI-1' } }))).toHaveLength(1);
    expect(hiveWakeMatches(ev('work_items:create', { ok: false, error: 'dup' }))).toHaveLength(0);
  });

  it('coord:escalate wakes on a successful open', () => {
    expect(hiveWakeMatches(ev('coord:escalate', { ok: true, msg_id: 'm' }))).toHaveLength(1);
  });

  it('an unsubscribed tool never wakes the Queen', () => {
    expect(hiveWakeMatches(ev('coord:send', { ok: true }))).toHaveLength(0);
  });

  it('the wake rule carries provenance args (reason + source:event)', () => {
    const [m] = hiveWakeMatches(ev('plans:start', { transitioned: true }));
    expect(m.args.source).toBe('event');
    expect(String(m.args.reason)).toContain('plans:start');
  });
});
