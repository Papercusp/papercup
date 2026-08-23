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
import {
  decideLaneGate,
  planLaneBlockerRef,
  restoreStateAfterUngate,
  selectCanonicalLinkedWorkItem,
  type LinkedWorkItem,
  type PlanLaneSyncStatus,
} from './reconcile-linked-work-items';

const REF = planLaneBlockerRef('desktop-auto-update-operational-2026-07-09', 'P-007');

/** A minimal work-item shape the pure decision reads. */
function wi(
  over: Partial<{ state: string; lastProgressAt: string | null; payload: unknown; assignee: string | null }> = {},
) {
  return { state: 'todo', lastProgressAt: null, payload: {}, assignee: null, ...over };
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

  it('NEVER clobbers genuinely-active work (lastProgressAt set AND a live assignee)', () => {
    const d = decideLaneGate(
      wi({ state: 'todo', lastProgressAt: '2026-07-18T00:00:00Z', assignee: 'su-abc123' }),
      'blocked',
      REF,
    );
    expect(d).toEqual({ op: 'noop', reason: 'in-flight' });
  });

  it('WI-6303: a STALE lastProgressAt with NO current assignee is NOT in-flight — parks it', () => {
    // Root cause: work-items-stale-claims.ts's dead/stalled-holder reaper, fleet-
    // monitors.ts's sweepOrphanedTakenBy, and pg-stores.ts's fleet:cancel claim
    // release all clear taken_by/taken_at on reclaim but historically left
    // last_progress_at stamped from the dead holder — a bare lastProgressAt check
    // then treated an unclaimed, abandoned item as "genuinely active" forever.
    const d = decideLaneGate(
      wi({ state: 'todo', lastProgressAt: '2026-07-17T00:00:00Z', assignee: null }),
      'blocked',
      REF,
    );
    expect(d).toEqual({ op: 'gate', capability: 'live-dependency' });
  });

  it('EI-20405552992224051: a live assignee with NO lastProgressAt YET is in-flight — does NOT park it', () => {
    // The REVERSE of the WI-6303 case directly above: there the stamp was stale and the
    // holder absent; here the holder is present and the stamp merely absent. An agent who
    // has just claimed (or re-claimed) an item has recorded no progress against it yet, so
    // requiring BOTH signals parked live work out of the claim pool from under its holder.
    // A current claimant is sufficient evidence of in-flight work on its own.
    const d = decideLaneGate(
      wi({ state: 'wip', lastProgressAt: null, assignee: 'su-live-holder' }),
      'blocked',
      REF,
    );
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
    expect(d).toEqual({ op: 'ungate', via: 'active-lane-blocker' });
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

  it('repairs a direct needs-human state or legacy owner-action flag that contradicts actionable plan truth', () => {
    expect(decideLaneGate(wi({ state: 'needs-human' }), 'actionable', REF)).toEqual({ op: 'repair-needs-human' });
    expect(
      decideLaneGate(wi({ state: 'open', payload: { needsOwnerAction: true } }), 'actionable', REF),
    ).toEqual({ op: 'repair-needs-human' });
  });

  it('repairs the human portion even when an independent nonhuman blocker must remain parked', () => {
    const human = updateExternalBlockerHistory(
      {},
      { kind: 'human', capability: 'credential', ref: 'credential:prod', summary: 'credential needed' },
      'su-a',
    );
    const both = updateExternalBlockerHistory(
      { externalBlockers: human.blockers },
      { kind: 'runtime', capability: 'live-dependency', ref: 'db:ready', summary: 'database unavailable' },
      'su-b',
    );
    expect(
      decideLaneGate(wi({ state: 'needs-human', payload: { externalBlockers: both.blockers } }), 'actionable', REF),
    ).toEqual({ op: 'repair-needs-human' });
  });

  it('a DIFFERENT plan item\'s lane blocker does not match this item id', () => {
    const otherRef = planLaneBlockerRef('some-other-plan', 'P-999');
    const d = decideLaneGate(wi({ state: 'blocked', payload: parkedPayload(otherRef) }), 'actionable', REF);
    expect(d).toEqual({ op: 'noop', reason: 'no-lane-blocker' });
  });
});

/**
 * WI-37914 — the half-applied un-park. The un-gate leg cleared the blocker and
 * released the claim hold but never restored `state`, so the item sat `blocked`
 * while the plan reported it unblocked. Every fleet claim spec filters
 * `states:['open']`, so the row was structurally invisible to
 * `work_items:claimable` / `scheduler:get_next` and the lane stranded silently —
 * measured live on fleet hud-chat-release-audit (3 members idle, 2026-08-11).
 *
 * The permanence came from the decision above keying un-park on an ACTIVE blocker:
 * once cleared, every later sweep read the row as "not parked by us" and walked
 * past it. These cover the repair path that heals it from the CLEARED history.
 */
describe('decideLaneGate — stranded-park REPAIR [WI-37914]', () => {
  /** A payload whose plan-lane park WE created and WE already cleared — the exact
   *  shape the old un-gate leg left behind. */
  function clearedParkPayload(ref = REF, actor = 'system:plan-item-lane-sync'): unknown {
    const parked = updateExternalBlockerHistory(
      {},
      { kind: 'gate', capability: 'live-dependency', ref, summary: 'parked' },
      'system:plan-item-lane-sync',
    );
    const { blockers } = updateExternalBlockerHistory(
      { externalBlockers: parked.blockers },
      { kind: 'gate', ref, clear: true },
      actor,
    );
    return { externalBlockers: blockers };
  }

  it('heals a `blocked` row whose lane blocker we already cleared — the stranding fix', () => {
    const d = decideLaneGate(wi({ state: 'blocked', payload: clearedParkPayload() }), 'actionable', REF);
    expect(d).toEqual({ op: 'ungate', via: 'stale-park-repair' });
  });

  it('leaves a row alone when ANOTHER blocker is still active (repair never clobbers a real park)', () => {
    const cleared = clearedParkPayload() as { externalBlockers: unknown };
    const { blockers } = updateExternalBlockerHistory(
      cleared,
      { kind: 'runtime', capability: 'credential', ref: 'vault:prod-key', summary: 'needs a credential' },
      'someone-else',
    );
    const d = decideLaneGate(wi({ state: 'blocked', payload: { externalBlockers: blockers } }), 'actionable', REF);
    expect(d).toEqual({ op: 'noop', reason: 'no-lane-blocker' });
  });

  it('does NOT claim a park cleared by someone else — provenance still gates the repair', () => {
    const d = decideLaneGate(
      wi({ state: 'blocked', payload: clearedParkPayload(REF, 'some-other-actor') }),
      'actionable',
      REF,
    );
    expect(d).toEqual({ op: 'noop', reason: 'no-lane-blocker' });
  });

  it('does NOT touch a row that is not `blocked` (a cleared park with a healthy state is settled business)', () => {
    const d = decideLaneGate(wi({ state: 'open', payload: clearedParkPayload() }), 'actionable', REF);
    expect(d).toEqual({ op: 'noop', reason: 'no-lane-blocker' });
  });
});

describe('restoreStateAfterUngate — what an un-park restores TO [WI-37914]', () => {
  function row(over: Partial<Parameters<typeof restoreStateAfterUngate>[0]> = {}) {
    return { state: 'blocked', family: 'issue', payload: {}, assignee: null, ...over } as Parameters<
      typeof restoreStateAfterUngate
    >[0];
  }

  it('falls back to the family claimable default when nothing was stashed', () => {
    // Every item parked BEFORE this fix takes this path — none carries a stash.
    expect(restoreStateAfterUngate(row({ family: 'issue' }))).toBe('open');
    expect(restoreStateAfterUngate(row({ family: 'feature' }))).toBe('todo');
  });

  it('restores the stashed pre-park state rather than flattening it', () => {
    expect(restoreStateAfterUngate(row({ payload: { planLaneParkedFrom: 'failing' } }))).toBe('failing');
  });

  it('keeps a still-held `wip` claim instead of silently reopening it', () => {
    const held = row({ payload: { planLaneParkedFrom: 'wip' }, assignee: 'su-abc123' });
    expect(restoreStateAfterUngate(held)).toBe('wip');
  });

  it('does NOT restore `wip` once the holder is gone — that would recreate an orphaned claim', () => {
    const abandoned = row({ payload: { planLaneParkedFrom: 'wip' }, assignee: null });
    expect(restoreStateAfterUngate(abandoned)).toBe('open');
  });

  it('never restores INTO a gated or settled state — that is the park being lifted', () => {
    for (const stashed of ['blocked', 'needs-human', 'resolved', 'closed']) {
      expect(restoreStateAfterUngate(row({ payload: { planLaneParkedFrom: stashed } }))).toBe('open');
    }
  });
});

describe('planLaneBlockerRef', () => {
  it('is a stable, plan-item-scoped ref', () => {
    expect(planLaneBlockerRef('p', 'P-001')).toBe('plan-lane:p#P-001');
  });
});

function linked(over: { id: string; createdAt: string; state?: string; viaImplementsEdge?: boolean }): LinkedWorkItem {
  return {
    id: over.id,
    createdAt: over.createdAt,
    state: over.state ?? 'open',
    viaImplementsEdge: over.viaImplementsEdge ?? true,
  } as unknown as LinkedWorkItem;
}

describe('selectCanonicalLinkedWorkItem — one mutable row per plan lane [D-046]', () => {
  it('prefers proven implementations, elects the earliest deterministically, and reports every other nonterminal row', () => {
    const stampOnly = linked({
      id: 'WI-0001',
      createdAt: '2026-08-22T00:00:00.000Z',
      viaImplementsEdge: false,
    });
    const later = linked({ id: 'WI-0003', createdAt: '2026-08-22T00:00:02.000Z' });
    const canonical = linked({ id: 'WI-0002', createdAt: '2026-08-22T00:00:01.000Z' });
    const terminal = linked({ id: 'WI-0000', createdAt: '2026-08-21T00:00:00.000Z', state: 'resolved' });

    const selected = selectCanonicalLinkedWorkItem([stampOnly, later, terminal, canonical]);

    expect(selected.canonical?.id).toBe('WI-0002');
    expect(selected.duplicates.map((row) => row.id)).toEqual(['WI-0001', 'WI-0003']);
  });

  it('falls back to stamp-only rows and uses id as the stable createdAt tie-break', () => {
    const selected = selectCanonicalLinkedWorkItem([
      linked({ id: 'WI-b', createdAt: '2026-08-22T00:00:00.000Z', viaImplementsEdge: false }),
      linked({ id: 'WI-a', createdAt: '2026-08-22T00:00:00.000Z', viaImplementsEdge: false }),
    ]);

    expect(selected.canonical?.id).toBe('WI-a');
    expect(selected.duplicates.map((row) => row.id)).toEqual(['WI-b']);
  });
});

// Type-only guard: PlanLaneSyncStatus stays the closed set the sweep classifies to.
const _statuses: PlanLaneSyncStatus[] = ['blocked', 'needs-human', 'actionable'];
void _statuses;
