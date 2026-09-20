/**
 * set_priority.test.ts — the work_items:set_priority HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). The store (getWorkItemPriority /
 * setWorkItemPriority / bumpWorkItemPriority) and the P-114 arm tripwire
 * (planWorkItemArm / commitWorkItemArm) are mocked. Pins, per item:
 *   • read mode (no directive) → getWorkItemPriority, NO arming, NO write;
 *   • set mode ({ priority }) → setWorkItemPriority, mode:'set', arm COMMITTED when it lands;
 *   • clear ({ priority:null }) → action:'clear';
 *   • bump ({ position }) → bumpWorkItemPriority, mode:'bump';
 *   • not-found → { ok:false, workItem, error } (fails only itself);
 *   • a steering-lease proposal (set.proposed) → proposed:true, arm NOT committed;
 *   • items:[…] → per-item results keyed by workItem, per-item harness honoured;
 *   • the single call is n=1 of the bulk envelope (read results[0]).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/set_priority.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({
  getWorkItemPriority: vi.fn(),
  setWorkItemPriority: vi.fn(),
  bumpWorkItemPriority: vi.fn(),
  explainIssueClaimFloors: vi.fn(),
}));
vi.mock('./arm-reversible-work-item', () => ({
  planWorkItemArm: vi.fn(),
  commitWorkItemArm: vi.fn(),
}));

import { getWorkItemPriority, setWorkItemPriority, bumpWorkItemPriority, explainIssueClaimFloors } from '../../work-items';
import { planWorkItemArm, commitWorkItemArm } from './arm-reversible-work-item';

const getM = vi.mocked(getWorkItemPriority);
const setM = vi.mocked(setWorkItemPriority);
const bumpM = vi.mocked(bumpWorkItemPriority);
const floorsM = vi.mocked(explainIssueClaimFloors);
const planArmM = vi.mocked(planWorkItemArm);
const commitArmM = vi.mocked(commitWorkItemArm);

const tool = (await import('./set_priority')).default;

type Out = { data: any };
const run = (args: unknown) => tool.handler(args as never, { uiClientId: 'opspawn-queen-1' } as never) as Promise<Out>;
const env = async (args: unknown) => ((await run(args)).data);
const one = async (args: unknown) => (await env(args)).results[0];

beforeEach(() => {
  vi.clearAllMocks();
  planArmM.mockResolvedValue({ armed: true } as never); // a non-null plan ⇒ arming is wired
  commitArmM.mockResolvedValue(undefined as never); // returns a promise (handler does .catch on it)
});

describe('work_items:set_priority handler (bulk keyed-array)', () => {
  it('read mode (just { workItem }) reports priority, no arming, no write', async () => {
    getM.mockResolvedValue({ id: 'F-1', priority: 3, applicable: true } as never);
    const r = await one({ workItem: 'F-1' });
    expect(r).toMatchObject({ ok: true, workItem: 'F-1', mode: 'read', priority: 3, applicable: true });
    expect(planArmM).not.toHaveBeenCalled();
    expect(setM).not.toHaveBeenCalled();
    expect(bumpM).not.toHaveBeenCalled();
  });

  it('set mode ({ priority }) writes, commits the arm, mode:set/action:set', async () => {
    setM.mockResolvedValue({ id: 'F-1', priority: 5, applicable: true } as never);
    const out = await env({ workItem: 'F-1', priority: 5 });
    expect(out).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    // WI-1376: a committed write reports written:true (the truthful persist signal).
    expect(out.results[0]).toMatchObject({ ok: true, workItem: 'F-1', mode: 'set', priority: 5, action: 'set', written: true });
    expect(setM).toHaveBeenCalledWith('F-1', 5, { harness: undefined });
    expect(commitArmM).toHaveBeenCalledTimes(1);
  });

  it('clear ({ priority:null }) reports action:clear', async () => {
    setM.mockResolvedValue({ id: 'F-1', priority: null, applicable: true } as never);
    const r = await one({ workItem: 'F-1', priority: null });
    expect(r).toMatchObject({ ok: true, mode: 'set', action: 'clear' });
    expect(setM).toHaveBeenCalledWith('F-1', null, { harness: undefined });
  });

  it('bump ({ position }) calls bump, mode:bump/action:top', async () => {
    bumpM.mockResolvedValue({ id: 'F-1', priority: 0, applicable: true } as never);
    const r = await one({ workItem: 'F-1', position: 'top' });
    expect(r).toMatchObject({ ok: true, workItem: 'F-1', mode: 'bump', action: 'top', priority: 0 });
    expect(bumpM).toHaveBeenCalledWith('F-1', 'top', { harness: undefined });
    expect(commitArmM).toHaveBeenCalledTimes(1);
  });

  it('not-found fails only that item (batch survives)', async () => {
    setM.mockResolvedValue(null as never);
    const out = await env({ workItem: 'F-404', priority: 1 });
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran the item and
    // reported its own failure at results[0].
    expect(out.ok).toBe(false);
    expect(out.counts).toEqual({ ok: 0, failed: 1, written: 0, proposed: 0 });
    expect(out.results[0]).toMatchObject({ ok: false, workItem: 'F-404' });
    expect(String(out.results[0].error)).toMatch(/F-404.*not found/i);
    expect(commitArmM).not.toHaveBeenCalled();
  });

  it('a steering-lease proposal does NOT commit the arm and surfaces proposed/steeringHolder', async () => {
    setM.mockResolvedValue({ id: 'F-1', priority: 2, applicable: true, proposed: true, steeringHolder: 'queen-A' } as never);
    const r = await one({ workItem: 'F-1', priority: 2 });
    // WI-1376: a proposal returns ok:true BUT written:false — the feature_order was NOT
    // committed (this Swarm isn't the steering-lease holder). Callers must gate on written.
    expect(r).toMatchObject({ ok: true, mode: 'set', proposed: true, steeringHolder: 'queen-A', written: false });
    expect(commitArmM).not.toHaveBeenCalled();
  });

  it('WI-1376: an inapplicable (issue-family, scheduler-issues OFF) set returns ok:true, written:false', async () => {
    // setWorkItemPriority returns { applicable:false } with no proposed — no feature_order
    // was written, yet ok:true. The written flag is the only signal that distinguishes this
    // silent no-op from a real write (the report's core defect).
    setM.mockResolvedValue({ id: 'WI-9', priority: null, applicable: false } as never);
    const r = await one({ workItem: 'WI-9', priority: 3 });
    expect(r).toMatchObject({ ok: true, mode: 'set', applicable: false, written: false });
    // an uncommitted write must not commit the auto-revert arm.
    expect(commitArmM).not.toHaveBeenCalled();
  });

  it('items:[…] mixes modes, keys by workItem, honours per-item harness; one bad item fails alone', async () => {
    getM.mockResolvedValue({ id: 'F-R', priority: 9, applicable: true } as never);
    setM.mockImplementation(async (id: string) => (id === 'F-X' ? (null as never) : ({ id, priority: 1, applicable: true } as never)));
    bumpM.mockResolvedValue({ id: 'F-B', priority: 0, applicable: true } as never);
    const out = await env({
      harness: 'def',
      items: [
        { workItem: 'F-R' }, // read
        { workItem: 'F-S', priority: 1, harness: 'web' }, // set, per-item harness
        { workItem: 'F-X', priority: 2 }, // set → not found
        { workItem: 'F-B', position: 'top' }, // bump
      ],
    });
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged — see the per-item results below,
    // where F-R/F-S/F-B all still succeed and only F-X fails.
    expect(out.ok).toBe(false);
    // WI-1376 rollup: F-S (set) + F-B (bump) both persisted (written:true) → written:2;
    // F-R is a read (no write attempt), F-X not-found → failed:1; no proposals.
    expect(out.counts).toEqual({ ok: 3, failed: 1, written: 2, proposed: 0 });
    expect(out.results.map((r: { workItem: string; ok: boolean; mode?: string }) => [r.workItem, r.ok, r.mode])).toEqual([
      ['F-R', true, 'read'],
      ['F-S', true, 'set'],
      ['F-X', false, undefined],
      ['F-B', true, 'bump'],
    ]);
    // per-item harness 'web' for F-S, batch default 'def' for the rest
    expect(setM).toHaveBeenCalledWith('F-S', 1, { harness: 'web' });
    expect(bumpM).toHaveBeenCalledWith('F-B', 'top', { harness: 'def' });
    expect(getM).toHaveBeenCalledWith('F-R', { harness: 'def' });
  });

  it('a thrown engine error becomes that item\'s { ok:false, workItem, error } via keyOf', async () => {
    setM.mockRejectedValue(new Error('pg down'));
    const out = await env({ workItem: 'F-1', priority: 1 });
    expect(out.results[0]).toEqual({ ok: false, workItem: 'F-1', error: 'pg down' });
  });

  it('WI-1376 bulk rollup: a non-lease-holder run looks clean on counts.ok but counts.proposed exposes the miss', async () => {
    // The exact report scenario: a bulk re-prioritization of feature-family items by
    // a Swarm that does NOT hold the steering lease. Every item returns ok:true (a
    // proposal), so counts.ok === total and a caller gating on counts.ok is fooled —
    // but counts.written:0 / counts.proposed:3 makes the silent no-op loud.
    setM.mockImplementation(async (id: string) => ({ id, priority: 1, applicable: true, proposed: true, steeringHolder: 'queen-home' } as never));
    const out = await env({
      harness: 'papercusp',
      items: [
        { workItem: 'WI-1' },
        { workItem: 'WI-2' },
        { workItem: 'WI-3' },
      ].map((x) => ({ ...x, priority: 1 })),
    });
    expect(out.counts).toEqual({ ok: 3, failed: 0, written: 0, proposed: 3 });
    expect(out.results.every((r: { written?: boolean; proposed?: boolean }) => r.written === false && r.proposed === true)).toBe(true);
    // No proposal committed the auto-revert arm (nothing was written to revert).
    expect(commitArmM).not.toHaveBeenCalled();
  });

  // EI-19919820196426791: a backlog-priority write that actually lands (written:true)
  // used to report a plain ok:true even when the item sits in a lane the claim path
  // structurally never serves (observation lane / owner action) — reordering the
  // backlog does nothing there, and nothing flagged the conflict.
  describe('structural claimability warning (EI-19919820196426791)', () => {
    it('set mode: a committed write on an observation-lane item surfaces claimabilityWarning', async () => {
      setM.mockResolvedValue({ id: 'EI-1', harness: 'papercusp', priority: 5, applicable: true } as never);
      floorsM.mockResolvedValue([
        { id: 'EI-1', admissible: false, refusedBy: 'observation-lane', detail: 'payload.lane = "observation" — a captured NOTE, never work-queue material (D-005)' },
      ] as never);
      const r = await one({ workItem: 'EI-1', priority: 5 });
      expect(floorsM).toHaveBeenCalledWith('papercusp', ['EI-1']);
      expect(r).toMatchObject({ ok: true, written: true });
      expect(r.claimabilityWarning).toMatch(/structurally UNCLAIMABLE/);
      expect(r.claimabilityWarning).toMatch(/observation/);
    });

    it('bump mode: a committed bump on an owner-action item surfaces claimabilityWarning', async () => {
      bumpM.mockResolvedValue({ id: 'WI-1', harness: 'papercusp', priority: 0, applicable: true } as never);
      floorsM.mockResolvedValue([
        { id: 'WI-1', admissible: false, refusedBy: 'needs-owner-action', detail: 'payload.needsOwnerAction = true — a credential requires the owner' },
      ] as never);
      const r = await one({ workItem: 'WI-1', position: 'top' });
      expect(floorsM).toHaveBeenCalledWith('papercusp', ['WI-1']);
      expect(r.claimabilityWarning).toMatch(/owner|credential/i);
    });

    // EI-19932455002723461 (MEASURED 2026-08-09): the original check covered only 2 of the
    // ~12 real claim floors — a priority set on an item excluded by any OTHER structural
    // floor (claim-hold: 61 open items on papercusp; federation-detector: 98;
    // cross-machine-rig: 6; …) silently reported success with no warning at all, reproducing
    // the "Mug's priority lever is silently ineffective" symptom for the majority of the
    // items it actually affects on this harness.
    it.each([
      ['claim-hold', 'payload._claimHold = true — deliberately held (WI-2797).'],
      ['federation-detector', 'an auto-filed replication-liveness detector, gated to the p2p fleet (WI-2633)'],
      ['cross-machine-rig', 'needs a ≥2-machine rig this caller does not have (WI-2796)'],
      ['plan-lane-reserved', 'reserved to its own plan lane while that plan is active (WI-2118/WI-3667)'],
      ['loop-noise', 'an AUTO-loop-iteration bookkeeping marker, not work (EI-8802)'],
      ['already-completed', 'already carries a terminal completion record (EI-8972)'],
      ['external-blocker', 'payload.externalBlockers contains an active typed capability dependency'],
      ['not-claimable-status', 'status is terminal or otherwise not in the claimable set'],
    ])('set mode: a committed write on a %s item ALSO surfaces claimabilityWarning', async (refusedBy, detail) => {
      setM.mockResolvedValue({ id: 'EI-2', harness: 'papercusp', priority: -100, applicable: true } as never);
      floorsM.mockResolvedValue([{ id: 'EI-2', admissible: false, refusedBy, detail }] as never);
      const r = await one({ workItem: 'EI-2', priority: -100 });
      expect(r).toMatchObject({ ok: true, written: true });
      expect(r.claimabilityWarning).toMatch(/structurally UNCLAIMABLE/);
      expect(r.claimabilityWarning).toContain(detail);
    });

    // 'already-taken' is deliberately EXCLUDED: it's a TRANSIENT state (the current holder
    // may release it any time), not a standing structural exclusion — priority steering IS
    // effective the moment it's released, so warning here would be a false alarm on the
    // single most common non-admissible state.
    it('set mode: an already-taken item does NOT surface a claimability warning (transient, not structural)', async () => {
      setM.mockResolvedValue({ id: 'EI-3', harness: 'papercusp', priority: -100, applicable: true } as never);
      floorsM.mockResolvedValue([
        { id: 'EI-3', admissible: false, refusedBy: 'already-taken', detail: 'already claimed by another agent', heldBy: 'su-abc' },
      ] as never);
      const r = await one({ workItem: 'EI-3', priority: -100 });
      expect(r.claimabilityWarning).toBeUndefined();
    });

    it('clearing (priority:null) never checks claim floors — nothing to warn about', async () => {
      setM.mockResolvedValue({ id: 'EI-1', harness: 'papercusp', priority: null, applicable: true } as never);
      const r = await one({ workItem: 'EI-1', priority: null });
      expect(floorsM).not.toHaveBeenCalled();
      expect(r.claimabilityWarning).toBeUndefined();
    });

    it('an otherwise-admissible item adds no warning', async () => {
      setM.mockResolvedValue({ id: 'EI-3', harness: 'papercusp', priority: 1, applicable: true } as never);
      floorsM.mockResolvedValue([{ id: 'EI-3', admissible: true, refusedBy: null, detail: null }] as never);
      const r = await one({ workItem: 'EI-3', priority: 1 });
      expect(r.claimabilityWarning).toBeUndefined();
    });

    it('an uncommitted write (proposed / inapplicable) never checks claim floors', async () => {
      setM.mockResolvedValue({ id: 'EI-1', harness: 'papercusp', priority: 2, applicable: true, proposed: true, steeringHolder: 'queen-A' } as never);
      const r = await one({ workItem: 'EI-1', priority: 2 });
      expect(r.written).toBe(false);
      expect(floorsM).not.toHaveBeenCalled();
      expect(r.claimabilityWarning).toBeUndefined();
    });

    it('a floor lookup failure never fails the underlying priority write', async () => {
      setM.mockResolvedValue({ id: 'EI-4', harness: 'papercusp', priority: 7, applicable: true } as never);
      floorsM.mockRejectedValue(new Error('db down'));
      const r = await one({ workItem: 'EI-4', priority: 7 });
      expect(r).toMatchObject({ ok: true, workItem: 'EI-4', written: true });
      expect(r.claimabilityWarning).toBeUndefined();
    });
  });
});
