import { describe, it, expect, vi } from 'vitest';
import {
  detectLowSpace,
  formatDiskAlarmToast,
  runDiskSpaceAlarmOnce,
  diskPolicyFromEnv,
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
    const strict: DiskAlarmPolicy = { freePctMin: 0.6, freeBytesMin: 0, freeInodesPctMin: 0 };
    expect(detectLowSpace([snap()], strict)[0].kinds).toEqual(['low-bytes']); // 50% < 60%
  });
});

describe('formatDiskAlarmToast', () => {
  it('names the path with free GB + %, and mentions inodes only when low-inodes', () => {
    const t = formatDiskAlarmToast([
      {
        path: '/ws',
        kinds: ['low-bytes', 'low-inodes'],
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
  it('emits exactly one toast when a filesystem breaches, and returns the breaches', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/ws', freeBytes: 1 * GIB, freePct: 1 / 500 }), snap({ path: '/tmp' })],
      emitToast,
    });
    expect(res.checked).toBe(2);
    expect(res.breaches.map((b) => b.path)).toEqual(['/ws']);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].level).toBe('warning');
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
    expect(res).toEqual({ checked: 0, breaches: [] });
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
