import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import {
  detectLowSpace,
  detectCriticalWriteHeadroom,
  criticalWriteHeadroomBytes,
  formatDiskAlarmToast,
  runDiskSpaceAlarmOnce,
  diskPolicyFromEnv,
  watchedPaths,
  DEFAULT_DISK_POLICY,
  type DiskSnapshot,
  type DiskAlarmPolicy,
} from './disk-space-alarm';

const GIB = 1024 ** 3;

function snap(p: Partial<DiskSnapshot> = {}): DiskSnapshot {
  // A healthy default: 500 GB total, 250 GB free (50%), inodes 50% free.
  const totalBytes = 500 * GIB;
  const freeBytes = 250 * GIB;
  const totalInodes = 1_000_000;
  const freeInodes = 500_000;
  return {
    path: '/ws',
    totalBytes,
    freeBytes,
    freePct: freeBytes / totalBytes,
    totalInodes,
    freeInodes,
    freeInodesPct: freeInodes / totalInodes,
    ...p,
  };
}

describe('detectLowSpace', () => {
  it('returns nothing when every filesystem is healthy', () => {
    expect(detectLowSpace([snap(), snap({ path: '/tmp' })])).toEqual([]);
  });

  it('flags low-bytes when below the absolute byte floor (even at a fine percentage)', () => {
    // Huge disk: 4 GB free of 10 TB = 0.04% — below the 5 GB floor though %-ish ok-looking only at the floor.
    const b = detectLowSpace([snap({ totalBytes: 10000 * GIB, freeBytes: 4 * GIB, freePct: 4 / 10000 })]);
    expect(b).toHaveLength(1);
    expect(b[0].kinds).toContain('low-bytes');
  });

  it('flags low-bytes when below the % floor', () => {
    const b = detectLowSpace([snap({ totalBytes: 500 * GIB, freeBytes: 40 * GIB, freePct: 0.08 })]); // 8% < 10%
    expect(b[0].kinds).toEqual(['low-bytes']);
  });

  it('flags low-inodes when inode headroom is below the floor', () => {
    const b = detectLowSpace([snap({ totalInodes: 1_000_000, freeInodes: 30_000, freeInodesPct: 0.03 })]); // 3% < 5%
    expect(b).toHaveLength(1);
    expect(b[0].kinds).toEqual(['low-inodes']);
  });

  it('reports BOTH kinds when bytes and inodes are both low', () => {
    const b = detectLowSpace([
      snap({ freeBytes: 1 * GIB, freePct: 1 / 500, freeInodes: 10_000, freeInodesPct: 0.01 }),
    ]);
    expect(b[0].kinds.sort()).toEqual(['low-bytes', 'low-inodes']);
  });

  it('skips the inode check on filesystems that do not report inodes (totalInodes === 0)', () => {
    // btrfs-style: no inode accounting. A 0% inode figure must NOT alarm.
    expect(detectLowSpace([snap({ totalInodes: 0, freeInodes: 0, freeInodesPct: 0 })])).toEqual([]);
  });

  it('honors a custom policy', () => {
    const strict: DiskAlarmPolicy = {
      freePctMin: 0.6,
      freeBytesMin: 0,
      freeInodesPctMin: 0,
      criticalFreePctMin: 0,
      criticalFreeBytesMin: 0,
    };
    expect(detectLowSpace([snap()], strict)[0].kinds).toEqual(['low-bytes']); // 50% < 60%
  });
});

// EI-20090527288494606: the warning tier is a UI toast nobody consumes. Severity is
// what decides whether a human is actually reached, so it needs its own guards.
describe('detectLowSpace severity tiering', () => {
  it('marks a merely-low filesystem as warning, NOT critical', () => {
    // 8% free of 500 GB = 40 GB — under the 10% warn floor, well over both critical floors.
    const b = detectLowSpace([snap({ totalBytes: 500 * GIB, freeBytes: 40 * GIB, freePct: 0.08 })]);
    expect(b[0].severity).toBe('warning');
  });

  it('marks a filesystem under the critical % floor as critical', () => {
    // The condition measured on this box: 17.6 GB free of 1875.7 GB = 0.9% — a huge
    // disk that is nowhere near the absolute byte floor but is proportionally doomed.
    const b = detectLowSpace([snap({ totalBytes: 1875.7 * GIB, freeBytes: 17.6 * GIB, freePct: 0.0094 })]);
    expect(b[0].severity).toBe('critical');
  });

  it('marks a filesystem under the critical BYTE floor as critical even at a healthy percentage', () => {
    // Small disk: 1 GB free of 20 GB = 5%. Over the 2% floor, under the 2 GB floor.
    const b = detectLowSpace([snap({ totalBytes: 20 * GIB, freeBytes: 1 * GIB, freePct: 0.05 })]);
    expect(b[0].severity).toBe('critical');
  });

  it('does NOT escalate on an inode-only breach (bytes are what kill a write mid-copy)', () => {
    const b = detectLowSpace([snap({ totalInodes: 1_000_000, freeInodes: 30_000, freeInodesPct: 0.03 })]);
    expect(b[0].kinds).toEqual(['low-inodes']);
    expect(b[0].severity).toBe('warning');
  });
});

describe('detectCriticalWriteHeadroom', () => {
  it('allows the warning band but refuses the critical byte band', () => {
    // 8% free is intentionally an alarm warning, not a reason to burn no verdict.
    expect(
      detectCriticalWriteHeadroom([
        snap({ totalBytes: 500 * GIB, freeBytes: 40 * GIB, freePct: 0.08 }),
      ]),
    ).toEqual([]);

    const critical = detectCriticalWriteHeadroom([
      snap({ totalBytes: 500 * GIB, freeBytes: 4 * GIB, freePct: 0.008 }),
    ]);
    expect(critical).toHaveLength(1);
    expect(critical[0].kinds).toContain('low-bytes');
  });

  it('still refuses low inode headroom because inode exhaustion is ENOSPC too', () => {
    const breaches = detectCriticalWriteHeadroom([
      snap({ totalInodes: 1_000_000, freeInodes: 30_000, freeInodesPct: 0.03 }),
    ]);
    expect(breaches[0].kinds).toEqual(['low-inodes']);
  });
});

describe('criticalWriteHeadroomBytes', () => {
  it('projects the same larger-of-absolute-or-percent reserve writers must preserve', () => {
    expect(criticalWriteHeadroomBytes(20 * GIB)).toBe(2 * GIB);
    expect(criticalWriteHeadroomBytes(500 * GIB)).toBe(10 * GIB);
    expect(criticalWriteHeadroomBytes(1875.7 * GIB)).toBeCloseTo(37.514 * GIB, -3);
  });

  it('falls back to the absolute reserve when total bytes are not measurable', () => {
    expect(criticalWriteHeadroomBytes(Number.NaN)).toBe(DEFAULT_DISK_POLICY.criticalFreeBytesMin);
    expect(criticalWriteHeadroomBytes(0)).toBe(DEFAULT_DISK_POLICY.criticalFreeBytesMin);
  });
});

describe('formatDiskAlarmToast', () => {
  it('names the path with free GB + %, and mentions inodes only when low-inodes', () => {
    const t = formatDiskAlarmToast([
      {
        path: '/ws',
        kinds: ['low-bytes', 'low-inodes'],
        severity: 'critical', // 0.4% free — critical under the default policy
        freeBytes: 2 * GIB,
        totalBytes: 500 * GIB,
        freePct: 0.004,
        freeInodes: 10_000,
        totalInodes: 1_000_000,
        freeInodesPct: 0.01,
      },
    ]);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('1 filesystem');
    expect(t.description).toContain('/ws');
    expect(t.description).toContain('2.0 GB free');
    expect(t.description).toContain('inodes free');
    expect(t.description).toContain('PAPERCUSP_DISK_SPACE_ALARM=0');
  });

  it('omits the inode clause for a bytes-only breach', () => {
    const t = formatDiskAlarmToast([
      {
        path: '/ws',
        kinds: ['low-bytes'],
        severity: 'critical', // 0.4% free — critical under the default policy
        freeBytes: 2 * GIB,
        totalBytes: 500 * GIB,
        freePct: 0.004,
        freeInodes: 900_000,
        totalInodes: 1_000_000,
        freeInodesPct: 0.9,
      },
    ]);
    expect(t.description).not.toContain('inodes free');
  });
});

describe('runDiskSpaceAlarmOnce', () => {
  // Every case below injects BOTH escalation deps. A critical-tier breach otherwise
  // falls through to the real notifyAttention (defaultRecentlyEscalated fails OPEN on
  // a missing DB, by design) — i.e. a unit test firing a live push.
  const noEscalate = {
    escalate: async (_t: { title: string; body: string }) => {},
    recentlyEscalated: async () => false,
  };

  it('emits exactly one toast when a filesystem breaches, and returns the breaches', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/ws', freeBytes: 1 * GIB, freePct: 1 / 500 }), snap({ path: '/tmp' })],
      emitToast,
      ...noEscalate,
    });
    expect(res.checked).toBe(2);
    expect(res.breaches.map((b) => b.path)).toEqual(['/ws']);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].level).toBe('warning');
  });

  it('escalates a CRITICAL breach to a human, once', async () => {
    const escalate = vi.fn(async (_t: { title: string; body: string }) => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/ws', totalBytes: 1875 * GIB, freeBytes: 17 * GIB, freePct: 0.009 })],
      emitToast: async () => {},
      escalate,
      recentlyEscalated: async () => false,
    });
    expect(res.escalated).toBe(true);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0][0].body).toContain('/ws');
  });

  it('does NOT escalate a warning-tier breach (toast only — the pre-existing behaviour)', async () => {
    const escalate = vi.fn(async (_t: { title: string; body: string }) => {});
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/ws', totalBytes: 500 * GIB, freeBytes: 40 * GIB, freePct: 0.08 })],
      emitToast,
      escalate,
      recentlyEscalated: async () => false,
    });
    expect(emitToast).toHaveBeenCalledTimes(1); // still toasts
    expect(escalate).not.toHaveBeenCalled();
    expect(res.escalated).toBe(false);
  });

  it('suppresses a repeat escalation inside the cooldown window', async () => {
    const escalate = vi.fn(async (_t: { title: string; body: string }) => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/ws', totalBytes: 1875 * GIB, freeBytes: 17 * GIB, freePct: 0.009 })],
      emitToast: async () => {},
      escalate,
      recentlyEscalated: async () => true, // already pinged within the window
    });
    expect(escalate).not.toHaveBeenCalled();
    expect(res.escalated).toBe(false);
    expect(res.breaches).toHaveLength(1); // still detected + toasted, just not re-pinged
  });

  it('never throws when the escalation rail itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/ws', totalBytes: 1875 * GIB, freeBytes: 17 * GIB, freePct: 0.009 })],
      emitToast: async () => {},
      escalate: async () => {
        throw new Error('push rail down');
      },
      recentlyEscalated: async () => false,
    });
    expect(res.escalated).toBe(false);
    expect(res.breaches).toHaveLength(1); // detection survives a dead delivery rail
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('emits NO toast when every filesystem is healthy', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runDiskSpaceAlarmOnce({ sample: async () => [snap(), snap({ path: '/tmp' })], emitToast });
    expect(res.breaches).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('never throws when sampling fails — returns an empty result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => {
        throw new Error('boom statfs');
      },
      emitToast,
    });
    expect(res).toEqual({ checked: 0, breaches: [], escalated: false });
    expect(emitToast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('diskPolicyFromEnv', () => {
  it('falls back to defaults when env is unset', () => {
    expect(diskPolicyFromEnv()).toEqual(DEFAULT_DISK_POLICY);
  });
});

describe('watchedPaths', () => {
  it('watches the process temp filesystem by default and deduplicates an explicit repeat', () => {
    const previous = process.env.PAPERCUSP_DISK_ALARM_PATHS;
    process.env.PAPERCUSP_DISK_ALARM_PATHS = `${tmpdir()},${tmpdir()}`;
    try {
      const paths = watchedPaths();
      expect(paths).toContain(tmpdir());
      expect(paths.filter((path) => path === tmpdir())).toHaveLength(1);
    } finally {
      if (previous == null) delete process.env.PAPERCUSP_DISK_ALARM_PATHS;
      else process.env.PAPERCUSP_DISK_ALARM_PATHS = previous;
    }
  });
});
