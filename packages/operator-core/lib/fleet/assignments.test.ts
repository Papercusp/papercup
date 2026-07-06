/**
 * assignments.test.ts — the pure by-agent grouping + smell selectors over
 * fleet_assignment rows (state-not-chat-fleet-state-2026-06-05, P-002).
 *
 * The load-bearing invariant under test is CLAIM-PRIMARY (D-002): a claim whose
 * holder has no presence row must still produce an agent group (orphan), not be
 * silently dropped the way a presence-primary join would.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveActivity,
  downgradeEndedHolders,
  groupByAgent,
  orphanedClaims,
  reclaimableClaims,
  stalledClaims,
  upgradeRecordedLiveHolders,
  type FleetAssignmentRow,
} from './assignments';
import { classifyItemActivity, isReclaimable, type ItemActivity } from '../item-activity';

const base: FleetAssignmentRow = {
  source: 'presence',
  workspaceId: '*',
  agentId: 'su-a',
  agentLabel: 'su · a',
  agentName: null,
  harnessSlug: null,
  planSlug: null,
  itemId: null,
  workItemId: null,
  itemKind: null,
  detail: '',
  status: null,
  claimAcquiredTs: null,
  claimExpiresTs: null,
  claimActive: null,
  livenessMode: null,
  lastActivityTs: null,
  holderPresent: true,
  holderAlive: true,
  holderHeartbeatAt: '2026-06-05T12:00:00.000Z',
  holderIntent: null,
  holderPlanSlug: null,
  orphaned: false,
  stalled: null,
  lastProgressAt: null,
  declaredPlanMatches: null,
  assigneeRank: null,
  rankWriter: null,
};

const presence = (over: Partial<FleetAssignmentRow>): FleetAssignmentRow => ({
  ...base,
  ...over,
});

const planClaim = (over: Partial<FleetAssignmentRow>): FleetAssignmentRow => ({
  ...base,
  source: 'plan_item_claim',
  planSlug: 'plan-x',
  itemId: 'P-001',
  harnessSlug: 'all',
  claimActive: true,
  ...over,
});

describe('groupByAgent — claim-primary (D-002)', () => {
  it('a claim with NO presence row still yields an agent group (the orphan survives)', () => {
    const groups = groupByAgent([
      planClaim({
        agentId: 'su-dead',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        orphaned: true,
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agentId).toBe('su-dead');
    expect(groups[0].present).toBe(false);
    expect(groups[0].alive).toBe(false);
    expect(groups[0].orphaned).toBe(true);
    expect(groups[0].claims).toHaveLength(1);
  });

  it('merges a presence row and its claims into one group', () => {
    const groups = groupByAgent([
      presence({ detail: 'building x', planSlug: 'plan-x' }),
      planClaim({ agentId: 'su-a', detail: 'P-001 work' }),
      planClaim({
        agentId: 'su-a',
        source: 'work_item_claim',
        itemId: null,
        workItemId: 'WI-7',
        itemKind: 'task',
        planSlug: null,
      }),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.present).toBe(true);
    expect(g.intent).toBe('building x');
    expect(g.declaredPlanSlug).toBe('plan-x');
    expect(g.claims).toHaveLength(2);
    expect(g.claims.map((c) => c.type).sort()).toEqual(['plan-item', 'work-item']);
  });

  it('name-keyed assignment rows merge into the owner group that claims that name', () => {
    const groups = groupByAgent([
      planClaim({ agentId: 'su-a', agentName: 'builder-1' }),
      {
        ...base,
        source: 'plan_item_assignment',
        agentId: 'builder-1',
        agentName: 'builder-1',
        planSlug: 'plan-x',
        itemId: 'P-002',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        claimActive: true,
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agentId).toBe('su-a');
    expect(groups[0].name).toBe('builder-1');
    expect(groups[0].claims).toHaveLength(2);
  });

  it('an assignment whose name no claim links stays a standalone name-keyed group', () => {
    const groups = groupByAgent([
      {
        ...base,
        source: 'plan_item_assignment',
        agentId: 'builder-9',
        agentName: 'builder-9',
        planSlug: 'plan-y',
        itemId: 'P-003',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        claimActive: true,
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agentId).toBe('builder-9');
    expect(groups[0].present).toBe(false);
  });

  it('flags declaredUnclaimed when the declared plan is backed by no claim (the D-002 smell)', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-smell', planSlug: 'plan-z' }),
      presence({ agentId: 'su-ok', planSlug: 'plan-x' }),
      planClaim({ agentId: 'su-ok' }),
    ]);
    const smell = groups.find((g) => g.agentId === 'su-smell');
    const ok = groups.find((g) => g.agentId === 'su-ok');
    expect(smell?.declaredUnclaimed).toBe(true);
    expect(ok?.declaredUnclaimed).toBe(false);
  });

  it('sorts live agents first, then orphan-holders', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-stale', holderAlive: false, holderHeartbeatAt: '2026-06-05T01:00:00.000Z' }),
      planClaim({
        agentId: 'su-orphan',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        orphaned: true,
      }),
      presence({ agentId: 'su-live' }),
    ]);
    expect(groups.map((g) => g.agentId)).toEqual(['su-live', 'su-orphan', 'su-stale']);
  });
});

// The work-item-claim row factory carrying a per-assignee rank (local-hive P-021).
const workClaim = (over: Partial<FleetAssignmentRow>): FleetAssignmentRow => ({
  ...base,
  source: 'work_item_claim',
  agentId: 'su-bee',
  itemId: null,
  workItemId: 'WI-?',
  itemKind: 'feature',
  detail: 'a work-item',
  status: 'todo',
  claimActive: true,
  ...over,
});

describe('groupByAgent — the per-bee ordered work-list (local-hive P-021)', () => {
  it('derives doing (head-of-line) + queued (rank order) + load from work-item claims', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-bee', detail: 'working' }),
      workClaim({ workItemId: 'WI-3', detail: 'third', assigneeRank: 2, rankWriter: 'cup' }),
      workClaim({ workItemId: 'WI-1', detail: 'first', assigneeRank: 0, rankWriter: 'mug' }),
      workClaim({ workItemId: 'WI-2', detail: 'second', assigneeRank: 1, rankWriter: 'cup' }),
    ]);
    const g = groups.find((x) => x.agentId === 'su-bee')!;
    expect(g.load).toBe(3);
    expect(g.queued.map((q) => q.id)).toEqual(['WI-1', 'WI-2', 'WI-3']); // rank ASC
    expect(g.doing?.id).toBe('WI-1'); // head-of-line = lowest rank
    expect(g.doing?.rankWriter).toBe('mug'); // the Queen-overlaid head
  });

  it('sorts unranked work-items to the tail (NULLs last), stable by id', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-bee' }),
      workClaim({ workItemId: 'WI-b', assigneeRank: null }),
      workClaim({ workItemId: 'WI-a', assigneeRank: null }),
      workClaim({ workItemId: 'WI-ranked', assigneeRank: 0 }),
    ]);
    const g = groups.find((x) => x.agentId === 'su-bee')!;
    expect(g.queued.map((q) => q.id)).toEqual(['WI-ranked', 'WI-a', 'WI-b']);
    expect(g.doing?.id).toBe('WI-ranked');
  });

  it('an agent with no work-items has doing=null, queued=[], load=0', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-idle' }),
      planClaim({ agentId: 'su-idle' }), // a plan-item lease is NOT a work-item
    ]);
    const g = groups.find((x) => x.agentId === 'su-idle')!;
    expect(g.doing).toBeNull();
    expect(g.queued).toEqual([]);
    expect(g.load).toBe(0);
  });
});

describe('orphanedClaims', () => {
  it('keeps active orphaned claims, drops lapsed and held ones', () => {
    const rows = [
      planClaim({ agentId: 'su-1', orphaned: true, claimActive: true }),
      planClaim({ agentId: 'su-2', orphaned: true, claimActive: false }), // lapsed
      planClaim({ agentId: 'su-3', orphaned: false, claimActive: true }), // healthy
    ];
    expect(orphanedClaims(rows).map((r) => r.agentId)).toEqual(['su-1']);
  });
});

// ── agent-activity-liveness-truth P-005: the single derived truth ───────────────
// (reuses the `workClaim` row builder defined above for the P-021 work-list tests)

describe('deriveActivity — the view-row projection of the truth (P-005, D-002)', () => {
  it('free when unclaimed', () => {
    expect(
      deriveActivity({ agentId: null, orphaned: false, stalled: null, lastProgressAt: null, holderAlive: false }),
    ).toBe('free');
  });
  it('dead when the holder is gone (orphaned), regardless of progress', () => {
    expect(
      deriveActivity({
        agentId: 'bee-1',
        orphaned: true,
        stalled: false,
        lastProgressAt: '2026-06-22T00:00:00Z',
        holderAlive: false,
      }),
    ).toBe('dead');
  });
  it('stalled when alive but not progressing (the second half of the incident)', () => {
    expect(
      deriveActivity({ agentId: 'bee-1', orphaned: false, stalled: true, lastProgressAt: null, holderAlive: true }),
    ).toBe('stalled');
  });
  it('progressing ONLY when alive AND has real progress — the one "actively worked" state', () => {
    expect(
      deriveActivity({
        agentId: 'bee-1',
        orphaned: false,
        stalled: false,
        lastProgressAt: '2026-06-22T00:00:00Z',
        holderAlive: true,
      }),
    ).toBe('progressing');
  });
  it('alive (grace) when freshly claimed by a live holder with no progress yet', () => {
    expect(
      deriveActivity({ agentId: 'bee-1', orphaned: false, stalled: false, lastProgressAt: null, holderAlive: true }),
    ).toBe('alive');
  });
  it('reserved when claimed but holder liveness is not affirmatively alive', () => {
    expect(
      deriveActivity({ agentId: 'bee-1', orphaned: false, stalled: false, lastProgressAt: null, holderAlive: false }),
    ).toBe('reserved');
  });

  // The load-bearing cross-check: the SQL view's stalled/orphaned booleans, once
  // projected by deriveActivity, must AGREE with the pure canonical classifier on
  // the same inputs — so the SQL reconciler and the TS readers can never drift.
  it('agrees with classifyItemActivity on representative claim states', () => {
    const NOW = 1_800_000_000_000;
    const fresh = NOW - 60_000; // within window
    const old = NOW - 30 * 60_000; // past the 10-min window
    type Case = { holderAlive: boolean; lastProgressAt: number | null; takenAt: number };
    const cases: Case[] = [
      { holderAlive: true, lastProgressAt: fresh, takenAt: old }, // progressing
      { holderAlive: true, lastProgressAt: null, takenAt: fresh }, // alive (grace)
      { holderAlive: true, lastProgressAt: old, takenAt: old }, // stalled
      { holderAlive: false, lastProgressAt: fresh, takenAt: fresh }, // dead (view) / reserved? → see note
    ];
    for (const c of cases) {
      const classifier = classifyItemActivity(
        { takenBy: 'bee-1', takenAt: c.takenAt, lastProgressAt: c.lastProgressAt, holderAlive: c.holderAlive },
        { now: NOW },
      );
      // Project the view booleans the way migration 358 computes them for a
      // work_item_claim leg (holder_alive=false ⇒ orphaned; alive+stale ⇒ stalled).
      const stalled = c.holderAlive && NOW - (c.lastProgressAt ?? c.takenAt) > 600_000;
      const orphaned = !c.holderAlive;
      const projected = deriveActivity({
        agentId: 'bee-1',
        orphaned,
        stalled,
        lastProgressAt: c.lastProgressAt == null ? null : new Date(c.lastProgressAt).toISOString(),
        holderAlive: c.holderAlive,
      });
      // Both sides agree on the single most important property: is it reclaimable
      // (dead/stalled) vs actively worked? The view collapses unknown-holder to
      // dead while the classifier may say reserved within grace, so we assert the
      // safety-critical equivalence (reclaimable ⇔ reclaimable), not label identity.
      expect(isReclaimable(projected)).toBe(
        isReclaimable(classifier as ItemActivity) || (orphaned && classifier === 'reserved'),
      );
    }
  });
});

describe('stalledClaims / reclaimableClaims (P-002/P-005)', () => {
  it('stalledClaims keeps active stalled rows only', () => {
    const rows = [
      workClaim({ agentId: 'bee-1', stalled: true }),
      workClaim({ agentId: 'bee-2', stalled: false }),
      workClaim({ agentId: 'bee-3', stalled: true, claimActive: false }), // lapsed
    ];
    expect(stalledClaims(rows).map((r) => r.agentId)).toEqual(['bee-1']);
  });
  it('reclaimableClaims is the union of dead (orphaned) and stalled', () => {
    const rows = [
      workClaim({ agentId: 'dead', orphaned: true, stalled: false }),
      workClaim({ agentId: 'stuck', orphaned: false, stalled: true }),
      workClaim({ agentId: 'healthy', orphaned: false, stalled: false }),
    ];
    expect(
      reclaimableClaims(rows)
        .map((r) => r.agentId)
        .sort(),
    ).toEqual(['dead', 'stuck']);
  });
});

describe('groupByAgent — surfaces stalled like orphaned (P-005)', () => {
  it('a live holder sitting on a non-progressing work-item reads as stalled, not covered', () => {
    const groups = groupByAgent([
      workClaim({ agentId: 'bee-stuck', stalled: true, holderPresent: true, holderAlive: true }),
    ]);
    const g = groups.find((x) => x.agentId === 'bee-stuck')!;
    expect(g.stalled).toBe(true);
    expect(g.orphaned).toBe(false);
    expect(g.doing?.activity).toBe('stalled'); // the head-of-line is NOT progressing
  });
});

// WI-1408 (fleet-registration-persists): a member launched with `--fleet <slug>`
// must show up GROUPED under that fleet here — the read side of the fix. The
// presence row's fleet_slug/fleet_role columns are a projection of the durable
// membership fact (fleet_membership_events, WI-1345) that bootstrap-su/-role/
// operator-spawn stamp at boot (appendFleetMembershipIfAbsent, WI-1893 — see
// bootstrap-su-fleet-stamp.test.ts for that write-side wiring). This pins
// that a `listFleetAssignments` row carrying fleetSlug/fleetRole survives
// `groupByAgent` into the roster's per-agent fleet label — never silently
// dropped or left null the way the reported bug produced.
describe('groupByAgent — named-fleet membership label (WI-1408 / P-005)', () => {
  it("a --fleet-launched member's presence row groups it under the fleet (non-null fleetSlug/fleetRole)", () => {
    const groups = groupByAgent([presence({ agentId: 'su-member-1', fleetSlug: 'atlas-fleet', fleetRole: 'member' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].fleetSlug).toBe('atlas-fleet');
    expect(groups[0].fleetRole).toBe('member');
  });

  it('a work-item claim joined to a fleeted holder still surfaces the fleet label via the holder-join fallback', () => {
    const groups = groupByAgent([
      workClaim({
        agentId: 'su-member-2',
        workItemId: 'WI-9',
        holderPresent: true,
        holderAlive: true,
        fleetSlug: 'atlas-fleet',
        fleetRole: 'member',
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].fleetSlug).toBe('atlas-fleet');
    expect(groups[0].fleetRole).toBe('member');
  });

  it('an agent with no fleet membership groups with a null fleetSlug (unchanged, non-regressive default)', () => {
    const groups = groupByAgent([presence({ agentId: 'su-unfleeted' })]);
    expect(groups[0].fleetSlug).toBeNull();
    expect(groups[0].fleetRole).toBeNull();
  });
});

describe('downgradeEndedHolders — heartbeat-vs-authoritative liveness drift (EI-6374)', () => {
  it('an ENDED holder whose warm heartbeat reads `alive`/`progressing` is downgraded to `dead`', () => {
    // The exact bug: fleet_assignment showed the bee alive (warm heartbeat) while
    // coord:send {wake:required} reported the session `ended` and not wakeable.
    const rows = [
      presence({ agentId: 'su-ended', holderAlive: true }),
      workClaim({
        agentId: 'su-ended',
        workItemId: 'WI-1438',
        holderPresent: true,
        holderAlive: true,
        lastProgressAt: '2026-07-02T12:00:00.000Z', // → 'progressing' before the fix
        orphaned: false,
      }),
    ];
    // Pre-fix: the claim reads as actively worked.
    expect(deriveActivity(rows[1])).toBe('progressing');

    const fixed = downgradeEndedHolders(rows, new Set(['su-ended']));
    const claim = fixed.find((r) => r.source === 'work_item_claim')!;
    const pres = fixed.find((r) => r.source === 'presence')!;
    // The claim is now a dead/orphaned (reclaimable) leg — no longer false coverage.
    expect(claim.holderAlive).toBe(false);
    expect(claim.orphaned).toBe(true);
    expect(deriveActivity(claim)).toBe('dead');
    expect(isReclaimable(deriveActivity(claim))).toBe(true);
    // The presence backbone row also drops liveness (but is never marked orphaned —
    // it holds no claim), so the agent no longer counts as alive.
    expect(pres.holderAlive).toBe(false);
    expect(pres.orphaned).toBe(false);
    expect(groupByAgent(fixed)[0].alive).toBe(false);
  });

  it('leaves a LIVE holder (not in the ended set) untouched', () => {
    const rows = [
      workClaim({
        agentId: 'su-live',
        workItemId: 'WI-2',
        holderAlive: true,
        lastProgressAt: '2026-07-02T12:00:00.000Z',
      }),
    ];
    const out = downgradeEndedHolders(rows, new Set(['su-ended']));
    expect(out[0]).toBe(rows[0]); // identity preserved — pure no-op for non-ended holders
    expect(deriveActivity(out[0])).toBe('progressing');
  });

  it('is a no-op when the ended set is empty (returns the same array)', () => {
    const rows = [workClaim({ agentId: 'su-x', workItemId: 'WI-3', holderAlive: true })];
    expect(downgradeEndedHolders(rows, new Set())).toBe(rows);
  });

  it('does not revive an already-dead/stale holder or touch an inactive claim', () => {
    // holderAlive=false already ⇒ the gate skips it (we only DOWNGRADE a live-reading
    // holder); a lapsed claim (claimActive=false) is never freshly orphaned.
    const dead = workClaim({
      agentId: 'su-ended',
      workItemId: 'WI-4',
      holderAlive: false,
      orphaned: false,
      claimActive: false,
    });
    const out = downgradeEndedHolders([dead], new Set(['su-ended']));
    expect(out[0]).toBe(dead); // untouched — holderAlive was already false
    expect(out[0].orphaned).toBe(false);
  });
});

describe('upgradeRecordedLiveHolders — recorded-live bootstrap liveness drift (EI-8106)', () => {
  it('a recorded-live holder whose presence/wakeability has not registered is not orphaned', () => {
    const rows = [
      workClaim({
        agentId: 's-bootstrap',
        workItemId: 'WI-8106',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        orphaned: true,
      }),
    ];

    expect(deriveActivity(rows[0])).toBe('dead');
    expect(orphanedClaims(rows)).toHaveLength(1);

    const fixed = upgradeRecordedLiveHolders(rows, new Set(['s-bootstrap']));
    expect(fixed[0]).not.toBe(rows[0]);
    expect(fixed[0].holderPresent).toBe(true);
    expect(fixed[0].holderAlive).toBe(true);
    expect(fixed[0].orphaned).toBe(false);
    expect(deriveActivity(fixed[0])).toBe('alive');
    expect(orphanedClaims(fixed)).toHaveLength(0);
    expect(groupByAgent(fixed)[0].alive).toBe(true);
  });

  it('is a no-op when the recorded-live set is empty', () => {
    const rows = [workClaim({ agentId: 's-bootstrap', workItemId: 'WI-8107', orphaned: true })];
    expect(upgradeRecordedLiveHolders(rows, new Set())).toBe(rows);
  });
});
