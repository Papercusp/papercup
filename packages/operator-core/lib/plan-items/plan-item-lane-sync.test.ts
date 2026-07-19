/**
 * plan-item-lane-sync.test.ts — EI-14699 regression.
 *
 * The reverse-mirror gap: a plan item flipped to `blocked`/`needs-human` left its
 * linked work-item at `state:'todo'`, so scheduler:get_next / the
 * `work-item:claimable` pool kept serving it while the post-claim
 * plan-item-lane-guard released it — a perpetual claim/release ping-pong. The
 * terminal reconciler (reconcile-linked-work-items.ts, EI-14693) heals done/dropped
 * lanes; this covers its gated (blocked/needs-human) sibling.
 *
 * `decideLaneGate` is the PURE decision the sync applies to ONE linked work-item —
 * unit-tested here without the PG/lock path (the same "inject the invariant, test
 * it apart from I/O" shape as agent-tools/plans/set-status.ts's releaseTerminalGrips
 * / releaseTodoClaim). It uses the REAL external-blocker reader (external-blockers.ts)
 * so the provenance match (`plan-lane:<plan>#<item>` blocker present ⇒ WE parked it)
 * is proven, not assumed.
 */
import { describe, expect, it } from 'vitest';
import { updateExternalBlockerHistory } from '../external-blockers';
import { decideLaneGate, planLaneBlockerRef, type PlanLaneSyncStatus } from './reconcile-linked-work-items';

const REF = planLaneBlockerRef('desktop-auto-update-operational-2026-07-09', 'P-007');

/** A minimal work-item shape the pure decision reads. */
function wi(over: Partial<{ state: string; lastProgressAt: string | null; payload: unknown }> = {}) {
  return { state: 'todo', lastProgressAt: null, payload: {}, ...over };
}

/** A payload already carrying THIS sync's active `plan-lane:` blocker (i.e. WE parked it). */
function parkedPayload(ref = REF): unknown {
  const { blockers } = updateExternalBlockerHistory(
    {},
    { kind: 'gate', capability: 'live-dependency', ref, summary: 'parked' },
    'system:plan-item-lane-sync',
  );
  return { externalBlockers: blockers };
}

describe('decideLaneGate — GATE (plan lane blocked/needs-human) [EI-14699]', () => {
  it('parks an UNCLAIMED todo work-item whose plan lane just went blocked — the ping-pong fix', () => {
    // Before EI-14699 nothing synced this: the item stayed claimable and cycled.
    const d = decideLaneGate(wi({ state: 'todo', payload: {} }), 'blocked', REF);
    expect(d).toEqual({ op: 'gate', capability: 'live-dependency' });
  });

  it('parks an issue-family `open` work-item too', () => {
    expect(decideLaneGate(wi({ state: 'open' }), 'blocked', REF)).toEqual({
      op: 'gate',
      capability: 'live-dependency',
    });
  });

  it('a needs-human lane parks with the product-decision capability', () => {
    expect(decideLaneGate(wi({ state: 'todo' }), 'needs-human', REF)).toEqual({
      op: 'gate',
      capability: 'product-decision',
    });
  });

  it('NEVER clobbers genuinely-active work (lastProgressAt set)', () => {
    const d = decideLaneGate(wi({ state: 'todo', lastProgressAt: '2026-07-18T00:00:00Z' }), 'blocked', REF);
    expect(d).toEqual({ op: 'noop', reason: 'in-flight' });
  });

  it('is IDEMPOTENT — a re-gate of an already lane-parked item is a no-op (no repeated writes)', () => {
    const d = decideLaneGate(wi({ state: 'blocked', payload: parkedPayload() }), 'blocked', REF);
    expect(d).toEqual({ op: 'noop', reason: 'already-gated' });
  });

  it('never touches a settled (terminal) work-item', () => {
    // The canonical cross-family settled work-item states (SETTLED_WORK_ITEM_STATES).
    // `done`/`dropped` are PLAN-ITEM statuses, not work-item states — a work-item
    // settles at passed/deprecated (feature) or resolved/closed (issue).
    for (const state of ['passed', 'resolved', 'closed', 'deprecated']) {
      expect(decideLaneGate(wi({ state }), 'blocked', REF)).toEqual({ op: 'noop', reason: 'terminal' });
    }
  });
});

describe('decideLaneGate — UN-GATE (plan lane actionable again) [EI-14699]', () => {
  it('restores a work-item THIS sync parked (its plan-lane blocker is present)', () => {
    const d = decideLaneGate(wi({ state: 'blocked', payload: parkedPayload() }), 'actionable', REF);
    expect(d).toEqual({ op: 'ungate' });
  });

  it('does NOT un-park an item blocked for some OTHER reason (no plan-lane blocker → left alone)', () => {
    // A work-item blocked by an unrelated external blocker must never be un-parked
    // just because its plan lane is actionable — provenance protects it.
    const { blockers } = updateExternalBlockerHistory(
      {},
      { kind: 'runtime', capability: 'credential', ref: 'vault:prod-key', summary: 'needs a credential' },
      'someone-else',
    );
    const d = decideLaneGate(wi({ state: 'blocked', payload: { externalBlockers: blockers } }), 'actionable', REF);
    expect(d).toEqual({ op: 'noop', reason: 'no-lane-blocker' });
  });

  it('an actionable lane with no lane blocker present is a clean no-op', () => {
    expect(decideLaneGate(wi({ state: 'todo', payload: {} }), 'actionable', REF)).toEqual({
      op: 'noop',
      reason: 'no-lane-blocker',
    });
  });

  it('a DIFFERENT plan item\'s lane blocker does not match this item id', () => {
    const otherRef = planLaneBlockerRef('some-other-plan', 'P-999');
    const d = decideLaneGate(wi({ state: 'blocked', payload: parkedPayload(otherRef) }), 'actionable', REF);
    expect(d).toEqual({ op: 'noop', reason: 'no-lane-blocker' });
  });
});

describe('planLaneBlockerRef', () => {
  it('is a stable, plan-item-scoped ref', () => {
    expect(planLaneBlockerRef('p', 'P-001')).toBe('plan-lane:p#P-001');
  });
});

// Type-only guard: PlanLaneSyncStatus stays the closed set the sweep classifies to.
const _statuses: PlanLaneSyncStatus[] = ['blocked', 'needs-human', 'actionable'];
void _statuses;
