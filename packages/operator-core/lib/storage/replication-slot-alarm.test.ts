import { describe, it, expect, vi } from 'vitest';
import {
  detectSlotBreaches,
  formatSlotBreachToast,
  runReplicationSlotAlarmOnce,
  inactiveCeilingBytes,
  activeCeilingBytes,
  type SlotRow,
  type SlotBreach,
} from './replication-slot-alarm';

const GIB = 1024 ** 3;

function slot(name: string, gb: number, extra: Partial<SlotRow> = {}): SlotRow {
  return {
    slotName: name,
    slotType: 'logical',
    active: false,
    retainedWalBytes: Math.round(gb * GIB),
    walStatus: 'reserved',
    ...extra,
  };
}

describe('ceilings', () => {
  it('default to 2 GiB (inactive, tight) and 10 GiB (active, looser)', () => {
    expect(inactiveCeilingBytes()).toBe(2 * GIB);
    expect(activeCeilingBytes()).toBe(10 * GIB);
  });
});

describe('detectSlotBreaches', () => {
  it('returns [] for the normal 0-slot steady state — the no-false-positive guarantee', () => {
    expect(detectSlotBreaches([])).toEqual([]);
  });

  it('does NOT flag an inactive slot retaining a little WAL (a freshly-dropped/small slot)', () => {
    expect(detectSlotBreaches([slot('s1', 1, { active: false })])).toEqual([]);
  });

  it('flags an INACTIVE slot pinning WAL over the tight ceiling (the disk-fill SPOF)', () => {
    const b = detectSlotBreaches([slot('dead_sub', 5, { active: false })]);
    expect(b.map((x) => [x.slotName, x.reason])).toEqual([['dead_sub', 'inactive-retaining']]);
    expect(b[0].ceilingBytes).toBe(2 * GIB);
  });

  it('tolerates an ACTIVE slot lagging under the looser ceiling, flags it past it', () => {
    expect(detectSlotBreaches([slot('live_sub', 8, { active: true })])).toEqual([]);
    const b = detectSlotBreaches([slot('live_sub', 12, { active: true })]);
    expect(b.map((x) => x.reason)).toEqual(['active-lagging']);
    expect(b[0].ceilingBytes).toBe(10 * GIB);
  });

  it('flags wal_status lost/unreserved as wal-at-risk regardless of activity or retained size', () => {
    const b = detectSlotBreaches([
      slot('lost_one', 0, { active: true, walStatus: 'lost' }),
      slot('unreserved_one', 0, { active: false, walStatus: 'unreserved' }),
    ]);
    expect(b.map((x) => x.reason)).toEqual(['wal-at-risk', 'wal-at-risk']);
  });
});

describe('formatSlotBreachToast', () => {
  it('emits a warning toast naming each slot + its retained WAL', () => {
    const breaches: SlotBreach[] = [
      {
        slotName: 'dead_sub',
        slotType: 'logical',
        active: false,
        retainedWalBytes: 5 * GIB,
        walStatus: 'reserved',
        reason: 'inactive-retaining',
        ceilingBytes: 2 * GIB,
      },
    ];
    const t = formatSlotBreachToast(breaches);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('1 slot(s)');
    expect(t.description).toContain('dead_sub');
    expect(t.description).toContain('5.0 GB');
  });

  it('escalates to error level when any slot is wal-at-risk', () => {
    const t = formatSlotBreachToast([
      {
        slotName: 'lost_one',
        slotType: 'logical',
        active: true,
        retainedWalBytes: 0,
        walStatus: 'lost',
        reason: 'wal-at-risk',
        ceilingBytes: 0,
      },
    ]);
    expect(t.level).toBe('error');
  });
});

describe('runReplicationSlotAlarmOnce', () => {
  it('emits exactly one toast when a slot breaches, and returns the breaches', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runReplicationSlotAlarmOnce({
      fetchSlots: async () => [slot('dead_sub', 5, { active: false }), slot('ok', 1, { active: false })],
      emitToast,
    });
    expect(res.checked).toBe(2);
    expect(res.breaches.map((b) => b.slotName)).toEqual(['dead_sub']);
    expect(emitToast).toHaveBeenCalledTimes(1);
  });

  it('emits NO toast when every slot is safe (incl. the empty cluster)', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runReplicationSlotAlarmOnce({ fetchSlots: async () => [], emitToast });
    expect(res.breaches).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('never throws — a failing slot scan returns an empty result (and logs non-fatally)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runReplicationSlotAlarmOnce({
      fetchSlots: async () => {
        throw new Error('pg down');
      },
    });
    expect(res).toEqual({ checked: 0, breaches: [] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
