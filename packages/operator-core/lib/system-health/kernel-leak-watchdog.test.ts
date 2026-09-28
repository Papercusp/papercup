import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => { throw new Error('no PG in unit tests'); },
}));
vi.mock('../agent-tools/coordination/escalations', () => ({ openEscalation: vi.fn() }));

import {
  DYING_DESCENDANTS_FLOOR,
  KERNEL_LEAK_SAMPLE_INTERVAL_MS,
  KERNEL_LEAK_WARMUP_MS,
  buildKernelMemorySample,
  evaluateKernelLeak,
  formatKernelLeakEscalation,
  parseDyingDescendants,
  runKernelLeakCheckOnce,
  slopePerDay,
  slopeWindow,
  type KernelMemorySample,
} from './kernel-leak-watchdog';

const GIB = 1024 ** 3;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MEM_TOTAL = 251 * GIB;
const BOOT_AT = Date.parse('2026-09-27T02:07:37Z');

/** A series of samples every 10 min from `startMs` to `endMs`, growing linearly per day. */
function series(opts: {
  startMs: number;
  endMs: number;
  sUnreclaimStart: number;
  sUnreclaimPerDay: number;
  dyingStart?: number | null;
  dyingPerDay?: number;
  bootId?: string;
}): KernelMemorySample[] {
  const out: KernelMemorySample[] = [];
  for (let t = opts.startMs; t <= opts.endMs; t += KERNEL_LEAK_SAMPLE_INTERVAL_MS) {
    const days = (t - opts.startMs) / DAY;
    out.push({
      bootId: opts.bootId ?? 'boot-a',
      host: 'tower',
      sampledAtMs: t,
      bootedAtMs: BOOT_AT,
      memTotalBytes: MEM_TOTAL,
      sUnreclaimBytes: Math.round(opts.sUnreclaimStart + opts.sUnreclaimPerDay * days),
      slabBytes: Math.round(opts.sUnreclaimStart * 4 + opts.sUnreclaimPerDay * days),
      dyingDescendants:
        opts.dyingStart === null ? null : Math.round((opts.dyingStart ?? 300) + (opts.dyingPerDay ?? 0) * days),
    });
  }
  return out;
}

const last = <T>(xs: T[]): T => xs[xs.length - 1];

describe('parsing', () => {
  const meminfo = [
    'MemTotal:       263747704 kB',
    'Slab:           19405652 kB',
    'SReclaimable:   14640804 kB',
    'SUnreclaim:      4764848 kB',
  ].join('\n');

  it('builds a sample from the real /proc shapes', () => {
    const s = buildKernelMemorySample({
      meminfo,
      cgroupStat: 'nr_descendants 433\nnr_dying_descendants 278\n',
      bootId: 'd3e57b27-e60c-40f8-a6f1-a9e82e715925\n',
      uptime: '12129.38 1066899.13\n',
      host: 'tower',
      nowMs: BOOT_AT + 12_129_380,
    });
    expect(s).toEqual({
      bootId: 'd3e57b27-e60c-40f8-a6f1-a9e82e715925',
      host: 'tower',
      sampledAtMs: BOOT_AT + 12_129_380,
      bootedAtMs: BOOT_AT,
      memTotalBytes: 263747704 * 1024,
      sUnreclaimBytes: 4764848 * 1024,
      slabBytes: 19405652 * 1024,
      dyingDescendants: 278,
    });
  });

  it('does not confuse SUnreclaim with SReclaimable, or nr_descendants with nr_dying_descendants', () => {
    const s = buildKernelMemorySample({
      meminfo, cgroupStat: 'nr_descendants 433\nnr_dying_descendants 278', bootId: 'b', uptime: '10 1', host: 'h', nowMs: 1e12,
    });
    expect(s?.sUnreclaimBytes).toBe(4764848 * 1024);
    expect(s?.dyingDescendants).toBe(278);
  });

  it('drops a half-read sample instead of storing a poisoned point', () => {
    const base = { cgroupStat: null, bootId: 'b', uptime: '10 1', host: 'h', nowMs: 1e12 };
    expect(buildKernelMemorySample({ ...base, meminfo: 'MemTotal: 1 kB\nSlab: 1 kB' })).toBeNull();
    expect(buildKernelMemorySample({ ...base, meminfo, uptime: 'garbage' })).toBeNull();
    expect(buildKernelMemorySample({ ...base, meminfo, bootId: '  ' })).toBeNull();
  });

  it('reports an absent cgroup.stat as null, never as zero dying cgroups', () => {
    expect(parseDyingDescendants(null)).toBeNull();
    expect(parseDyingDescendants('nr_descendants 4\n')).toBeNull();
    expect(parseDyingDescendants('nr_dying_descendants 0\n')).toBe(0);
  });
});

describe('slopePerDay', () => {
  it('fits a straight line exactly', () => {
    const pts = [0, 1, 2, 3].map((h) => ({ tMs: h * HOUR, v: 100 + h * 10 }));
    expect(slopePerDay(pts)).toBeCloseTo(240, 6);
  });

  it('is null when time does not vary', () => {
    expect(slopePerDay([{ tMs: 5, v: 1 }])).toBeNull();
    expect(slopePerDay([{ tMs: 5, v: 1 }, { tMs: 5, v: 9 }])).toBeNull();
  });
});

describe('evaluateKernelLeak', () => {
  const warm = BOOT_AT + KERNEL_LEAK_WARMUP_MS;

  it('CALIBRATION: the measured 6.17 leak rate (~2.6 GB/day) alarms once 12 h of post-warm-up data exist', () => {
    const s = series({ startMs: warm, endMs: warm + 13 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 2.6e9 });
    const alerts = evaluateKernelLeak(s, last(s));
    expect(alerts.map((a) => a.signal)).toEqual(['sunreclaim-growth']);
    expect(alerts[0].slopePerDay! / 1e9).toBeCloseTo(2.6, 1);
  });

  it('does not alarm on a flat series (the expected 7.0 baseline)', () => {
    const s = series({ startMs: warm, endMs: warm + 20 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0 });
    expect(evaluateKernelLeak(s, last(s))).toEqual([]);
  });

  it('does not alarm on a leak-rate climb with only 11 h of data — the slope needs a 12 h span', () => {
    const s = series({ startMs: warm, endMs: warm + 11 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 3e9 });
    expect(evaluateKernelLeak(s, last(s))).toEqual([]);
  });

  it('ignores the post-boot warm-up climb entirely', () => {
    // A steep climb during the first 6 h, then flat: the warm-up must not count.
    const early = series({ startMs: BOOT_AT, endMs: warm - 1, sUnreclaimStart: 1 * GIB, sUnreclaimPerDay: 12 * GIB });
    const flat = series({ startMs: warm, endMs: warm + 14 * HOUR, sUnreclaimStart: 4 * GIB, sUnreclaimPerDay: 0 });
    const all = [...early, ...flat];
    expect(slopeWindow(all, last(all)).every((x) => x.sampledAtMs >= warm)).toBe(true);
    expect(evaluateKernelLeak(all, last(all))).toEqual([]);
  });

  it('never fits a slope across a reboot', () => {
    const prior = series({ startMs: warm, endMs: warm + 14 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 3e9, bootId: 'old' });
    const now = series({ startMs: warm + 14 * HOUR + 1, endMs: warm + 15 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0, bootId: 'new' });
    const all = [...prior, ...now];
    expect(slopeWindow(all, last(all)).every((x) => x.bootId === 'new')).toBe(true);
    expect(evaluateKernelLeak(all, last(all))).toEqual([]);
  });

  it('alarms on absolute SUnreclaim at 10% of RAM with no history at all (the pre-reboot 29.9 GiB state)', () => {
    const s = series({ startMs: BOOT_AT + HOUR, endMs: BOOT_AT + HOUR, sUnreclaimStart: 29.9 * GIB, sUnreclaimPerDay: 0 });
    expect(evaluateKernelLeak(s, s[0]).map((a) => a.signal)).toEqual(['sunreclaim-absolute']);
  });

  it('alarms on dying cgroups only when BOTH above the floor and still climbing', () => {
    const climbing = series({
      startMs: warm, endMs: warm + 13 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0,
      dyingStart: DYING_DESCENDANTS_FLOOR, dyingPerDay: 900,
    });
    expect(evaluateKernelLeak(climbing, last(climbing)).map((a) => a.signal)).toEqual(['dying-growth']);

    const highButFlat = series({
      startMs: warm, endMs: warm + 13 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0, dyingStart: 1900, dyingPerDay: 0,
    });
    expect(evaluateKernelLeak(highButFlat, last(highButFlat))).toEqual([]);

    const climbingButLow = series({
      startMs: warm, endMs: warm + 13 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0, dyingStart: 100, dyingPerDay: 900,
    });
    expect(evaluateKernelLeak(climbingButLow, last(climbingButLow))).toEqual([]);
  });

  it('never alarms on dying cgroups when cgroup.stat is unreadable', () => {
    const s = series({
      startMs: warm, endMs: warm + 13 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0, dyingStart: null,
    });
    expect(evaluateKernelLeak(s, last(s))).toEqual([]);
  });
});

describe('formatKernelLeakEscalation', () => {
  it('names the numbers, the size-not-name triage, and the known instance', () => {
    const s = series({ startMs: BOOT_AT + 7 * HOUR, endMs: BOOT_AT + 20 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 3 * GIB });
    const [alert] = evaluateKernelLeak(s, last(s));
    const { summary, body } = formatKernelLeakEscalation(alert);
    expect(summary).toContain('growing 3.0 GiB/day');
    expect(body).toContain("boot_id = 'boot-a'");
    expect(body).toContain('/proc/slabinfo');
    expect(body).toContain('re-randomise per boot');
    expect(body).toContain('P-001');
  });
});

describe('runKernelLeakCheckOnce', () => {
  it('skips cleanly when no sample is readable (non-Linux, missing /proc)', async () => {
    const store = vi.fn();
    const r = await runKernelLeakCheckOnce({ readSample: async () => null, store });
    expect(r).toEqual({ skipped: true, sample: null, alerts: [] });
    expect(store).not.toHaveBeenCalled();
  });

  it('stores the sample, then escalates each breached signal', async () => {
    const s = series({ startMs: BOOT_AT + 7 * HOUR, endMs: BOOT_AT + 20 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 3e9 });
    const current = last(s);
    const store = vi.fn(async () => {});
    const escalate = vi.fn(async () => {});
    const r = await runKernelLeakCheckOnce({
      readSample: async () => current,
      store,
      prune: async () => {},
      loadSeries: async () => s.slice(0, -1),
      escalate,
    });
    expect(store).toHaveBeenCalledWith(current);
    expect(r.alerts.map((a) => a.signal)).toEqual(['sunreclaim-growth']);
    expect(escalate).toHaveBeenCalledTimes(1);
  });

  it('never throws: a failed store / load / escalate is logged and the tick finishes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const current = series({ startMs: BOOT_AT + HOUR, endMs: BOOT_AT + HOUR, sUnreclaimStart: 30 * GIB, sUnreclaimPerDay: 0 })[0];
    const r = await runKernelLeakCheckOnce({
      readSample: async () => current,
      store: async () => { throw new Error('pg down'); },
      prune: async () => {},
      loadSeries: async () => { throw new Error('pg down'); },
      escalate: async () => { throw new Error('escalation store down'); },
    });
    // The absolute signal still fires without history.
    expect(r.alerts.map((a) => a.signal)).toEqual(['sunreclaim-absolute']);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});
