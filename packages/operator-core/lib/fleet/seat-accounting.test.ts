/**
 * seat-accounting (P-005 launch-from-seats) — the PURE half: ref parsing, slot
 * normalization, availability math, and the launch-resolution gate (the P-006
 * "N+1th spawn is refused" enforcement). No PG.
 */
import { describe, expect, it } from 'vitest';
import {
  computeSeatAvailability,
  parseAgentSlotRef,
  resolveSeatLaunch,
  seatLaunchOpts,
  slotFromAllotment,
  type SeatAvailability,
  type SeatSlot,
} from './seat-accounting';
import type { ResourceAllotment } from '../p2p/resource-allotments';

const slot = (over: Partial<SeatSlot> = {}): SeatSlot => ({
  ref: 'opus:xhigh:AUTO',
  model: 'opus',
  effort: 'xhigh',
  account: 'AUTO',
  quantity: 5,
  ...over,
});

const avail = (over: Partial<SeatAvailability> = {}): SeatAvailability => ({
  ...slot(),
  consumed: 0,
  available: 5,
  ...over,
});

const allotment = (over: Partial<ResourceAllotment> = {}): ResourceAllotment => ({
  workspaceId: 'ws-1',
  fleetSlug: 'alpha',
  resourceKind: 'agent_slot',
  resourceRef: 'opus:xhigh:AUTO',
  sharePct: 0,
  quantity: 5,
  axis: { model: 'opus', effort: 'xhigh', account: 'AUTO' },
  status: 'active',
  createdByGithubUserId: null,
  createdAt: '2026-07-03T00:00:00.000Z',
  updatedAt: '2026-07-03T00:00:00.000Z',
  ...over,
});

describe('parseAgentSlotRef', () => {
  it('parses the canonical template and round-trips whitespace', () => {
    expect(parseAgentSlotRef('opus:xhigh:AUTO')).toEqual({ model: 'opus', effort: 'xhigh', account: 'AUTO' });
    expect(parseAgentSlotRef(' opus:high:pool-2 ')).toEqual({ model: 'opus', effort: 'high', account: 'pool-2' });
  });

  it('rejects malformed refs outright (no partial parse)', () => {
    expect(parseAgentSlotRef(null)).toBeNull();
    expect(parseAgentSlotRef('')).toBeNull();
    expect(parseAgentSlotRef('opus:xhigh')).toBeNull(); // 2 parts
    expect(parseAgentSlotRef('opus:xhigh:AUTO:extra')).toBeNull(); // 4 parts
    expect(parseAgentSlotRef('opus:warp9:AUTO')).toBeNull(); // bad effort
    expect(parseAgentSlotRef(':xhigh:AUTO')).toBeNull(); // empty model
    expect(parseAgentSlotRef('opus:xhigh:')).toBeNull(); // empty account
  });
});

describe('slotFromAllotment', () => {
  it('prefers the structured axis trio', () => {
    expect(slotFromAllotment(allotment())).toEqual(slot());
  });

  it('falls back to parsing the ref when the axis is not a valid trio', () => {
    expect(slotFromAllotment(allotment({ axis: {} }))).toEqual(slot());
    expect(slotFromAllotment(allotment({ axis: { model: 'x' } }))).toEqual(slot());
  });

  it('returns null for non-slot kinds, missing quantity, and unparseable rows', () => {
    expect(slotFromAllotment(allotment({ resourceKind: 'account', quantity: null }))).toBeNull();
    expect(slotFromAllotment(allotment({ quantity: null }))).toBeNull();
    expect(slotFromAllotment(allotment({ quantity: 0 }))).toBeNull();
    expect(slotFromAllotment(allotment({ axis: {}, resourceRef: 'not-a-template' }))).toBeNull();
  });
});

describe('computeSeatAvailability', () => {
  it('folds consumed counts by ref, clamping at zero', () => {
    const out = computeSeatAvailability(
      [slot(), slot({ ref: 'sonnet:low:pool-2', model: 'sonnet', effort: 'low', account: 'pool-2', quantity: 2 })],
      new Map([
        ['opus:xhigh:AUTO', 3],
        ['sonnet:low:pool-2', 99], // over-consumed (stale ledger) never goes negative
      ]),
    );
    expect(out[0]).toMatchObject({ consumed: 3, available: 2 });
    expect(out[1]).toMatchObject({ consumed: 99, available: 0 });
  });

  it('treats an absent ref as zero consumed', () => {
    expect(computeSeatAvailability([slot()], new Map())[0]).toMatchObject({ consumed: 0, available: 5 });
  });
});

describe('seatLaunchOpts', () => {
  it("derives the psu model spec + maps AUTO (any case) to the gateway's auto routing", () => {
    expect(seatLaunchOpts(slot())).toEqual({ model: 'opus:xhigh', account: 'auto' });
    expect(seatLaunchOpts(slot({ account: 'auto' }))).toEqual({ model: 'opus:xhigh', account: 'auto' });
  });

  it('passes a pool id pin through verbatim', () => {
    expect(seatLaunchOpts(slot({ account: 'pool-aviynw4' }))).toEqual({ model: 'opus:xhigh', account: 'pool-aviynw4' });
  });
});

describe('resolveSeatLaunch — the enforcement gate', () => {
  it('refuses when the fleet has no delegation at all', () => {
    const r = resolveSeatLaunch({ availability: [], count: 1 });
    expect(r).toMatchObject({ ok: false, refusal: { code: 'seats_unavailable' } });
  });

  it('defaults to the single delegated template', () => {
    const r = resolveSeatLaunch({ availability: [avail()], count: 5 });
    expect(r).toMatchObject({ ok: true, launch: { model: 'opus:xhigh', account: 'auto' } });
  });

  it('requires an explicit seat when several templates are delegated', () => {
    const two = [avail(), avail({ ref: 'sonnet:low:pool-2', model: 'sonnet', effort: 'low', account: 'pool-2' })];
    expect(resolveSeatLaunch({ availability: two, count: 1 })).toMatchObject({
      ok: false,
      refusal: { code: 'seat_ref_ambiguous' },
    });
    expect(resolveSeatLaunch({ availability: two, count: 1, seatRef: 'sonnet:low:pool-2' })).toMatchObject({
      ok: true,
      launch: { model: 'sonnet:low', account: 'pool-2' },
    });
  });

  it('refuses an unknown seat ref, naming the delegated templates', () => {
    const r = resolveSeatLaunch({ availability: [avail()], count: 1, seatRef: 'haiku:low:AUTO' });
    expect(r).toMatchObject({ ok: false, refusal: { code: 'seat_ref_unknown' } });
    if (!r.ok) expect(r.refusal.detail).toContain('opus:xhigh:AUTO');
  });

  it('enforces the count cap: N of N ok, the N+1th refused (P-006)', () => {
    const a = [avail({ consumed: 2, available: 3 })];
    expect(resolveSeatLaunch({ availability: a, count: 3 })).toMatchObject({ ok: true });
    const over = resolveSeatLaunch({ availability: a, count: 4 });
    expect(over).toMatchObject({ ok: false, refusal: { code: 'seats_exhausted' } });
    if (!over.ok) expect(over.refusal.detail).toContain('3 of 5');
  });
});
