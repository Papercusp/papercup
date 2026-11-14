import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CensusDeviceView } from './disk-consumer-census';
import { RETENTION_POLICY, type RetentionClass } from './retention-policy';
import {
  comparableCensusWindowDays,
  detectUnenforcedClassGrowth,
  formatUnenforcedClassGrowthToast,
  headroomFloorBytes,
  isUnenforcedClass,
  UNENFORCED_CLASS_HORIZON_DAYS,
} from './unenforced-class-growth';

type Consumer = NonNullable<CensusDeviceView['consumers']>[number];

const FLOORS = { rootBytes: 250e9, dataBytes: 1e12, coldFreePct: 0.2 };

const row = (consumer: string, growth24hBytes: number | undefined, kind = 'dir'): Consumer =>
  ({ consumer, kind, depth: 1, bytes: 200e9, baselineBytes: 195e9, growth24hBytes }) as Consumer;

/** Root volume 50e9 above its floor; the keep-store grows 5e9 over exactly one day. */
const device = (over: Partial<CensusDeviceView> = {}): CensusDeviceView => ({
  device: '/', complete: true, stale: false, sizeBytes: 2e12, availBytes: 300e9,
  sampledAt: '2026-11-14T12:00:00Z', baselineAt: '2026-11-13T12:00:00Z',
  baselineSizeBytes: 2e12, baselineAvailBytes: 310e9,
  consumers: [row('/srv/keepstore', 5e9)], ...over,
});

const hyperbee = RETENTION_POLICY.find((c) => c.id === 'hyperbee-store')!;
const policy: RetentionClass[] = [
  { ...hyperbee, id: 'test-keep-store', title: 'Test keep store', roots: ['/srv/keepstore'] },
  {
    ...hyperbee, id: 'test-enforced-store', title: 'Test enforced store', roots: ['/srv/enforced'],
    enforcers: [{ kind: 'standing-reclaim' }],
  },
];
const detect = (devices: CensusDeviceView[], horizonDays?: number) =>
  detectUnenforcedClassGrowth(devices, { floors: FLOORS, policy, home: '/home/test', horizonDays });

describe('detectUnenforcedClassGrowth', () => {
  it('warns when a class with no enforcer would take the volume below its floor inside the horizon', () => {
    expect(detect([device()])).toEqual([{
      device: '/', classId: 'test-keep-store', title: 'Test keep store', keepKind: 'keep',
      keepReason: hyperbee.keep.kind === 'keep' ? hyperbee.keep.reason : null,
      bytes: 200e9, growthBytesPerDay: 5e9, availableBytes: 300e9, floorBytes: 250e9, daysToFloor: 10,
      consumers: ['/srv/keepstore'], lowerBound: false,
    }]);
  });

  it('stays silent for a class that has an enforcer, however fast it grows', () => {
    expect(detect([device({ consumers: [row('/srv/enforced', 40e9)] })])).toEqual([]);
  });

  it('uses a strict horizon: exactly 30 days to the floor is not a warning, just under is', () => {
    expect(UNENFORCED_CLASS_HORIZON_DAYS).toBe(30);
    const at = device({ availBytes: 310e9, consumers: [row('/srv/keepstore', 2e9)] });
    expect(detect([at])).toEqual([]);
    const inside = device({ availBytes: 310e9, consumers: [row('/srv/keepstore', 2.1e9)] });
    expect(detect([inside]).map((w) => w.classId)).toEqual(['test-keep-store']);
    expect(detect([at], 31).map((w) => w.daysToFloor)).toEqual([30]);
  });

  it('counts only the outermost census row, never a nested child or the direct-files row', () => {
    const [w] = detect([device({ consumers: [
      row('/srv/keepstore/db', 5e9), row('/srv/keepstore/*', 1e9, 'files'), row('/srv/keepstore', 5e9),
    ] })]);
    expect(w!.consumers).toEqual(['/srv/keepstore']);
    expect(w!.growthBytesPerDay).toBe(5e9);
    expect(w!.bytes).toBe(200e9);
  });

  it('normalizes growth by the real length of the baseline window', () => {
    const [w] = detect([device({ baselineAt: '2026-11-13T18:00:00Z' })]);
    expect(w!.growthBytesPerDay).toBeCloseTo(5e9 / 0.75, 3);
    expect(w!.daysToFloor).toBeCloseTo(7.5, 9);
  });

  it('reports zero days when the volume is already below its floor', () => {
    expect(detect([device({ availBytes: 240e9 })])[0]!.daysToFloor).toBe(0);
  });

  it('treats a stale, missing, incomplete or incomparable census as UNKNOWN and raises nothing', () => {
    const unknown: Array<Partial<CensusDeviceView>> = [
      { stale: true }, { missing: true }, { complete: false }, { availBytes: undefined },
      { baselineAt: null }, { baselineAt: '2026-11-12T12:00:00Z' }, { baselineSizeBytes: 1e12 },
    ];
    for (const change of unknown) {
      expect(comparableCensusWindowDays(device(change))).toBeNull();
      expect(detect([device(change)])).toEqual([]);
    }
    expect(comparableCensusWindowDays(device())).toBe(1);
  });

  it('raises nothing when the class is shrinking or its growth is unmeasured', () => {
    expect(detect([device({ consumers: [row('/srv/keepstore', -1e9)] })])).toEqual([]);
    expect(detect([device({ consumers: [row('/srv/keepstore', undefined)] })])).toEqual([]);
    expect(detect([device({ consumers: [] })])).toEqual([]);
  });

  it('marks the result as a lower bound when the census row list was capped', () => {
    expect(detect([device({ truncatedByLimit: true })])[0]!.lowerBound).toBe(true);
  });

  it('projects to completely full on a device that has no declared floor', () => {
    expect(detect([device({ device: '/mnt/other' })])).toEqual([]);
    const [w] = detect([device({ device: '/mnt/other', availBytes: 100e9 })]);
    expect(w!.floorBytes).toBe(0);
    expect(w!.daysToFloor).toBe(20);
  });

  it('orders warnings by the nearest floor first', () => {
    const out = detect([device(), device({ device: '/mnt/data', availBytes: 1e12 + 10e9 })]);
    expect(out.map((w) => [w.device, w.daysToFloor])).toEqual([['/mnt/data', 2], ['/', 10]]);
  });

  it('covers the real policy: the Hyperbee store is protected, unenforced, and mapped from its census row', () => {
    expect(hyperbee.keep.kind).toBe('keep');
    expect(isUnenforcedClass(hyperbee)).toBe(true);
    const store = `${homedir()}/.papercusp-workspaces/some-workspace/.papercusp/some-harness/hyperbee`;
    const out = detectUnenforcedClassGrowth([device({ consumers: [row(store, 5e9)] })], { floors: FLOORS });
    expect(out.map((w) => [w.classId, w.daysToFloor])).toEqual([['hyperbee-store', 10]]);
  });
});

describe('headroomFloorBytes', () => {
  it('resolves the root, data and cold-tier floors and returns null elsewhere', () => {
    expect(headroomFloorBytes({ device: '/' }, FLOORS)).toBe(250e9);
    expect(headroomFloorBytes({ device: '/mnt/data' }, FLOORS)).toBe(1e12);
    expect(headroomFloorBytes({ device: '/mnt/cold-a', sizeBytes: 2e12 }, FLOORS)).toBe(0.2 * 2e12);
    expect(headroomFloorBytes({ device: '/mnt/cold-a' }, FLOORS)).toBeNull();
    expect(headroomFloorBytes({ device: '/mnt/coldish', sizeBytes: 2e12 }, FLOORS)).toBeNull();
  });
});

describe('formatUnenforcedClassGrowthToast', () => {
  it('names the class, the device, the projection and the keep reason, and says deletion is not the fix', () => {
    const toast = formatUnenforcedClassGrowthToast(detect([device()]));
    expect(toast.level).toBe('warning');
    expect(toast.message).toContain('1 class(es) with no retention enforcer');
    expect(toast.description).toContain('• test-keep-store on /:');
    expect(toast.description).toContain('floor in 10.0d');
    expect(toast.description).toContain('Kept because: ');
    expect(toast.description).toContain('deleting files is not the fix');
    expect(toast.description).not.toContain('lower bound');
    expect(formatUnenforcedClassGrowthToast(detect([device({ truncatedByLimit: true })])).description)
      .toContain('lower bound');
  });
});
