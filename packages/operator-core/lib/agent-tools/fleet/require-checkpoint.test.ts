/**
 * fleet:require-checkpoint — P-012 pure-fold tests.
 *
 * Everything asserted here is a rule the tool exists to enforce: a leader must never
 * read "safe" and then destroy unsaved work, and must never be sent to respawn a
 * healthy member. The pure functions carry both rules, so they are tested directly.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDelivery,
  deliveryEvidence,
  foldItemVerdict,
  summarizeRequireCheckpoint,
  type CheckpointItemOutcome,
} from './require-checkpoint';
import type { DirectiveActuation, DirectiveEffectVerdict } from '../coordination/directive-effect';

const MEMBER = 'su-member-1';

function actuation(verdict: DirectiveEffectVerdict, itemId = 'WI-1', observedAtMs: number | null = null): DirectiveActuation {
  return {
    spec: { kind: 'checkpoint', itemId },
    verdict,
    observedAtMs,
    evidence: `synthetic ${verdict} evidence`,
  };
}

describe('classifyDelivery — woken:0 is NOT death', () => {
  const base = { woken: 0, staged: 0, idle: [], dormantScheduled: [], degraded: false, member: MEMBER };

  it('woken>0 ⇒ woken', () => {
    expect(classifyDelivery({ ...base, woken: 1 })).toBe('woken');
  });

  it('staged outranks woken — a manual-wake-mode member did NOT get it', () => {
    expect(classifyDelivery({ ...base, woken: 1, staged: 1 })).toBe('staged');
  });

  it('woken:0 with the member NOT idle ⇒ running, never not-running', () => {
    // The core rule: a member actively taking a turn is not asleep on its wake key.
    expect(classifyDelivery(base)).toBe('running');
  });

  it('woken:0 and the member IS idle ⇒ not-running', () => {
    expect(classifyDelivery({ ...base, idle: [MEMBER] })).toBe('not-running');
  });

  it('woken:0 and dormant-with-a-scheduled-fire ⇒ dormant-scheduled, not dead', () => {
    expect(
      classifyDelivery({
        ...base,
        dormantScheduled: [{ ownerId: MEMBER, nextFireAt: '2026-08-01T23:59:00.000Z', parked: false }],
      }),
    ).toBe('dormant-scheduled');
  });

  it('a degraded probe ⇒ indeterminate — never not-running', () => {
    // A false "not running" sends a leader to respawn a healthy member.
    expect(classifyDelivery({ ...base, degraded: true, idle: [MEMBER] })).toBe('indeterminate');
  });

  it('another agent being idle does not implicate this member', () => {
    expect(classifyDelivery({ ...base, idle: ['su-someone-else'] })).toBe('running');
  });
});

describe('deliveryEvidence', () => {
  it('names the member and the mechanism for every outcome', () => {
    for (const outcome of ['woken', 'running', 'dormant-scheduled', 'staged', 'not-running', 'indeterminate'] as const) {
      const line = deliveryEvidence(outcome, MEMBER);
      expect(line.length).toBeGreaterThan(0);
      expect(line).toContain(MEMBER);
    }
  });

  it('distinguishes a parked (in-flight) loop turn from a future fire', () => {
    const parked = deliveryEvidence('dormant-scheduled', MEMBER, { ownerId: MEMBER, nextFireAt: null, parked: true });
    expect(parked).toMatch(/IN FLIGHT/i);
    const future = deliveryEvidence('dormant-scheduled', MEMBER, {
      ownerId: MEMBER,
      nextFireAt: '2026-08-01T23:59:00.000Z',
      parked: false,
    });
    expect(future).toContain('2026-08-01T23:59:00.000Z');
  });

  it('says a staged directive was NOT delivered', () => {
    expect(deliveryEvidence('staged', MEMBER)).toMatch(/STAGED, not delivered/);
  });
});

describe('foldItemVerdict', () => {
  it('satisfied ⇒ landed', () => {
    const out = foldItemVerdict(actuation('satisfied', 'WI-1', 1_000), 'woken', MEMBER);
    expect(out.verdict).toBe('landed');
    expect(out.checkpointAt).toBe(new Date(1_000).toISOString());
  });

  it('a LANDED checkpoint outranks a not-running delivery verdict', () => {
    // A member can write the checkpoint and exit a moment later. The state is
    // durable — which is the only question asked — so this must not read undeliverable.
    expect(foldItemVerdict(actuation('satisfied', 'WI-1', 1_000), 'not-running', MEMBER).verdict).toBe('landed');
  });

  it('pre-existing is NOT compliance — it stays unsafe', () => {
    const out = foldItemVerdict(actuation('pre-existing', 'WI-1', 500), 'woken', MEMBER);
    expect(out.verdict).toBe('pending');
  });

  it('not-yet + running ⇒ pending', () => {
    expect(foldItemVerdict(actuation('not-yet'), 'running', MEMBER).verdict).toBe('pending');
  });

  it('not-yet + not-running ⇒ undeliverable', () => {
    expect(foldItemVerdict(actuation('not-yet'), 'not-running', MEMBER).verdict).toBe('undeliverable');
  });

  it('not-yet + staged ⇒ staged', () => {
    expect(foldItemVerdict(actuation('not-yet'), 'staged', MEMBER).verdict).toBe('staged');
  });

  it('not-yet + indeterminate ⇒ unprovable', () => {
    expect(foldItemVerdict(actuation('not-yet'), 'indeterminate', MEMBER).verdict).toBe('unprovable');
  });

  it('an unknown ledger verdict is unprovable regardless of delivery, and keeps its evidence', () => {
    const a = actuation('unknown');
    const out = foldItemVerdict(a, 'woken', MEMBER);
    expect(out.verdict).toBe('unprovable');
    expect(out.evidence).toBe(a.evidence);
  });
});

describe('summarizeRequireCheckpoint', () => {
  const outcome = (verdict: CheckpointItemOutcome['verdict'], itemId: string): CheckpointItemOutcome => ({
    itemId,
    verdict,
    evidence: 'x',
    checkpointAt: null,
  });

  it('no claims ⇒ safe, but SAYS session carry was not checked', () => {
    const s = summarizeRequireCheckpoint([]);
    expect(s.itemStateSafe).toBe(true);
    expect(s.nextAction).toBeNull();
    expect(s.summary).toMatch(/loop:checkpoint/);
  });

  it('all landed / already-fresh ⇒ safe with no nextAction', () => {
    const s = summarizeRequireCheckpoint([outcome('landed', 'WI-1'), outcome('already-fresh', 'WI-2')]);
    expect(s.itemStateSafe).toBe(true);
    expect(s.nextAction).toBeNull();
  });

  it('safe summary still scopes its claim to work-item state', () => {
    expect(summarizeRequireCheckpoint([outcome('landed', 'WI-1')]).summary).toMatch(/loop:checkpoint/);
  });

  it('ONE unproven item makes the whole answer unsafe — it is an AND over proofs', () => {
    const s = summarizeRequireCheckpoint([
      outcome('landed', 'WI-1'),
      outcome('landed', 'WI-2'),
      outcome('pending', 'WI-3'),
    ]);
    expect(s.itemStateSafe).toBe(false);
    expect(s.nextAction).toContain('WI-3');
  });

  it('undeliverable is the loudest nextAction and says DO NOT stand down', () => {
    const s = summarizeRequireCheckpoint([outcome('pending', 'WI-1'), outcome('undeliverable', 'WI-2')]);
    expect(s.itemStateSafe).toBe(false);
    expect(s.nextAction).toMatch(/DO NOT/);
    expect(s.nextAction).toContain('WI-2');
  });

  it('staged outranks pending in nextAction — a staged directive will never act', () => {
    const s = summarizeRequireCheckpoint([outcome('pending', 'WI-1'), outcome('staged', 'WI-2')]);
    expect(s.nextAction).toMatch(/STAGED/);
    expect(s.nextAction).toContain('WI-2');
  });

  it('pending points at waitSec', () => {
    expect(summarizeRequireCheckpoint([outcome('pending', 'WI-1')]).nextAction).toMatch(/waitSec/);
  });

  it('unprovable is treated as UNSAFE, not as permission', () => {
    const s = summarizeRequireCheckpoint([outcome('unprovable', 'WI-1')]);
    expect(s.itemStateSafe).toBe(false);
    expect(s.nextAction).toMatch(/UNSAFE/);
  });

  it('every unsafe verdict yields a non-null nextAction', () => {
    for (const v of ['pending', 'staged', 'undeliverable', 'unprovable'] as const) {
      const s = summarizeRequireCheckpoint([outcome(v, 'WI-9')]);
      expect(s.itemStateSafe).toBe(false);
      expect(s.nextAction, `verdict ${v} must name a lever`).toBeTruthy();
    }
  });
});
