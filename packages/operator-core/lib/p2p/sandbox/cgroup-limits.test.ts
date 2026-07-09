import { describe, expect, it } from 'vitest';
import {
  applyCgroupLimits,
  buildCgroupLimits,
  buildUlimitFloor,
  decideOverLimit,
  renderCgroupV2Files,
} from './cgroup-limits';

describe('buildCgroupLimits', () => {
  it('builds a spec with the default 100ms cpu period', () => {
    const s = buildCgroupLimits({ cpuMaxPercent: 50, memoryMaxBytes: 1_000_000, ioMaxBytesPerSec: 5_000_000 });
    expect(s.cpuPeriodUs).toBe(100_000);
  });

  it('rejects non-positive bounds on every axis', () => {
    expect(() => buildCgroupLimits({ cpuMaxPercent: 0, memoryMaxBytes: 1, ioMaxBytesPerSec: 1 })).toThrow();
    expect(() => buildCgroupLimits({ cpuMaxPercent: 1, memoryMaxBytes: 0, ioMaxBytesPerSec: 1 })).toThrow();
    expect(() => buildCgroupLimits({ cpuMaxPercent: 1, memoryMaxBytes: 1, ioMaxBytesPerSec: 0 })).toThrow();
  });
});

describe('renderCgroupV2Files', () => {
  it('renders cpu.max as "<quota> <period>" scaled from the percentage', () => {
    const spec = buildCgroupLimits({ cpuMaxPercent: 50, memoryMaxBytes: 1_000_000, ioMaxBytesPerSec: 5_000_000 });
    const files = renderCgroupV2Files(spec);
    expect(files['cpu.max']).toBe('50000 100000');
    expect(files['memory.max']).toBe('1000000');
    expect(files['io.max']).toBe('<major>:<minor> rbps=5000000 wbps=5000000');
  });

  it('substitutes a concrete device id when given', () => {
    const spec = buildCgroupLimits({ cpuMaxPercent: 100, memoryMaxBytes: 1, ioMaxBytesPerSec: 1 });
    const files = renderCgroupV2Files(spec, '8:0');
    expect(files['io.max']).toContain('8:0');
  });
});

describe('buildUlimitFloor', () => {
  it('ties the address-space ceiling to the cgroup memory limit', () => {
    const spec = buildCgroupLimits({ cpuMaxPercent: 50, memoryMaxBytes: 42, ioMaxBytesPerSec: 1 });
    expect(buildUlimitFloor(spec).addressSpaceBytes).toBe(42);
  });
});

describe('decideOverLimit', () => {
  const spec = buildCgroupLimits({ cpuMaxPercent: 50, memoryMaxBytes: 1000, ioMaxBytesPerSec: 100 });

  it('returns an empty array when everything is within bounds', () => {
    expect(decideOverLimit({ cpuPercent: 10, memoryBytes: 100, ioBytesPerSec: 10 }, spec)).toEqual([]);
  });

  it('reports every axis currently over, not just the first', () => {
    expect(decideOverLimit({ cpuPercent: 90, memoryBytes: 2000, ioBytesPerSec: 10 }, spec).sort()).toEqual(['cpu', 'memory']);
  });
});

describe('applyCgroupLimits', () => {
  it('creates the cgroup dir and writes all three controller files', async () => {
    const written: Record<string, string> = {};
    const r = await applyCgroupLimits(
      '/sys/fs/cgroup/p105',
      'sess-1',
      buildCgroupLimits({ cpuMaxPercent: 50, memoryMaxBytes: 1000, ioMaxBytesPerSec: 100 }),
      '8:0',
      {
        mkdir: async () => undefined,
        writeFile: async (path, content) => {
          written[path] = content;
        },
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cgroupPath).toBe('/sys/fs/cgroup/p105/sess-1');
      expect(written['/sys/fs/cgroup/p105/sess-1/cpu.max']).toBe('50000 100000');
      expect(written['/sys/fs/cgroup/p105/sess-1/memory.max']).toBe('1000');
    }
  });

  it('surfaces a write failure as a typed refusal, never a thrown exception', async () => {
    const r = await applyCgroupLimits(
      '/sys/fs/cgroup/p105',
      'sess-1',
      buildCgroupLimits({ cpuMaxPercent: 50, memoryMaxBytes: 1000, ioMaxBytesPerSec: 100 }),
      undefined,
      {
        mkdir: async () => undefined,
        writeFile: async () => {
          throw new Error('EACCES: permission denied');
        },
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.detail).toMatch(/EACCES/);
  });
});
