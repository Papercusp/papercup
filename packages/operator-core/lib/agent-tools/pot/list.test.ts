/**
 * pot:list payload shaping (hud-open-destinations-and-true-counts-2026-07-27
 * P-006).
 *
 * The defect this pins is a SIZE one, so the test measures size. On 2026-07-27
 * the owner asked Papercup "whats the status of our pots?" and got no pot list.
 * `tool_invocations` showed `pot:list` returning ok TWICE at 19,400 bytes each
 * (inlined, `output_ref` null), and `operator_turns` seq 16456 — the assistant
 * turn that should have carried the answer — persisted with EMPTY text.
 *
 * ~85% of those bytes were the same four wake `subscriptions` repeated once per
 * pot, with long human-readable `note` strings. That repetition is not a
 * coincidence to be tolerated: `buildWakeView` fills every pot's subscriptions
 * from `readPotWakeState(workspaceId)`, which takes no pot argument, so the
 * array is identical across a response BY CONSTRUCTION. Hoisting it is
 * therefore lossless.
 */
import { describe, it, expect } from 'vitest';
import { shapePotList } from './list';
import type { PotDescriptor } from './_resolve';

/** The four default subscriptions every pot carries, at their real length —
 *  using a toy string here would make the size assertion meaningless. */
const SUBSCRIPTIONS = [
  {
    on: 'pot:set-steering',
    note: 'Owner changed steering — this is my unblock signal; re-read pauseNewWork + eligiblePlans immediately',
  },
  {
    on: 'plans:start',
    note: 'default demand wake: a plan was started (start-pot-wake P-002)',
    when: { 'result.data.transitioned': true },
  },
  {
    on: 'work_items:create',
    note: 'default demand wake: an UNPLACED (unassigned) work item was created (start-pot-wake P-002; a pre-assigned create skips — EI-1850; a named cup-forbidden plan skips — EI-13608)',
    when: { 'result.data.ok': true, 'result.data.workItem.assignee': { exists: false } },
  },
  {
    on: 'coord:escalate',
    note: 'default demand wake: an escalation was raised (start-pot-wake P-002)',
    when: { 'result.data.ok': true },
  },
] as unknown as PotDescriptor['wake']['subscriptions'];

function pot(slug: string): PotDescriptor {
  return {
    slug,
    path: `/hives/${slug}`,
    kind: 'hive',
    pubkey: 'dt7o6ioLVBSnppkg+H7WO+NLLKK1EUcXHQVR45BMNyA=',
    deployment: { target: 'local' },
    deployed: false,
    wake: {
      active: false,
      nextFireAt: null,
      lastFiredAt: null,
      subscriptions: SUBSCRIPTIONS,
      lastWakeAt: '2026-07-27T13:00:04.062Z',
    },
  } as unknown as PotDescriptor;
}

/** The real workspace size when the defect was reported. */
const HIVES = Array.from({ length: 17 }, (_, i) => pot(`hive-${i}`));
const COUNTS = new Map<string, number>([['hive-0', 2]]);

describe('shapePotList (P-006)', () => {
  it('emits the shared wake subscriptions ONCE, not per pot', () => {
    const out = shapePotList(HIVES, COUNTS);
    expect(out.wakeSubscriptions).toHaveLength(4);
    for (const h of out.hives) {
      expect(h.wake).not.toHaveProperty('subscriptions');
    }
  });

  it('cuts the 17-pot payload by well over half', () => {
    const before = JSON.stringify({
      ok: true,
      count: HIVES.length,
      hives: HIVES.map((h) => ({ ...h, liveAgents: COUNTS.get(h.slug) ?? 0 })),
    }).length;
    const after = JSON.stringify(shapePotList(HIVES, COUNTS)).length;

    // The observed live payload was 19,400 bytes; this fixture reproduces that
    // order of magnitude, and the hoist has to be a large win, not a rounding
    // one — a marginal saving would not have been worth changing the contract.
    expect(before).toBeGreaterThan(15_000);
    expect(after).toBeLessThan(before / 2);
  });

  it('keeps every per-pot signal — this is a de-duplication, not a truncation', () => {
    const out = shapePotList(HIVES, COUNTS);
    expect(out.count).toBe(17);
    const first = out.hives[0];
    expect(first.slug).toBe('hive-0');
    expect(first.liveAgents).toBe(2);
    // The wake fields that genuinely VARY per pot all survive.
    expect(first.wake).toEqual({
      active: false,
      nextFireAt: null,
      lastFiredAt: null,
      lastWakeAt: '2026-07-27T13:00:04.062Z',
    });
    expect(out.hives.map((h) => h.slug)).toEqual(HIVES.map((h) => h.slug));
  });

  it('an empty workspace yields no subscriptions rather than throwing', () => {
    const out = shapePotList([], new Map());
    expect(out).toMatchObject({ ok: true, count: 0, wakeSubscriptions: [], hives: [] });
  });
});
