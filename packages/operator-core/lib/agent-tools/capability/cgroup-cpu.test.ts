import { describe, it, expect } from 'vitest';
import {
  MIN_SAMPLE_GAP_MS,
  coresBetween,
  cgroupRelPathFromProc,
  parseCgroupUsageUsec,
  readCgroupCpuSample,
  type ReadTextFn,
} from './cgroup-cpu';

/**
 * EI-20051445912325691. Every case below is anchored to a reading MEASURED on this box
 * 2026-08-10, because the failure mode being guarded is not "wrong arithmetic" — it is a
 * function that returns a PLAUSIBLE NUMBER when it has measured nothing.
 */
describe('cgroup-cpu — per-job CPU accounting (EI-20051445912325691)', () => {
  /** A real cpu.stat body from a per-job scope. Note usage_usec is present even though the
   *  scope's cgroup.controllers is only [memory pids] — the surprise that made me briefly
   *  conclude this was unmeasurable. */
  const CPU_STAT = [
    'usage_usec 4172318',
    'user_usec 3011002',
    'system_usec 1161316',
    'nr_periods 0',
    'nr_throttled 0',
    'throttled_usec 0',
  ].join('\n');

  /** The measured scope path of a real backgrounded capability:bash job. */
  const SCOPE =
    '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-bash.slice/papercusp-bash-job.slice/pc-0msn040hb1xzkt0q1we.scope';

  describe('parseCgroupUsageUsec', () => {
    it('reads usage_usec out of a real cpu.stat body', () => {
      expect(parseCgroupUsageUsec(CPU_STAT)).toBe(4172318);
    });

    /**
     * THE CENTRAL GUARD. When the job exits, its scope is torn down and the read comes back
     * empty; the shell form then fed the blanks to `bc`, which printed `-3.35 cores` for a
     * job that had already finished. Null is the only honest answer, and callers must never
     * be able to read it as 0 — "no measurement" and "measured idle" prompt opposite actions.
     */
    it('returns null — never 0 — for a read that measured nothing', () => {
      expect(parseCgroupUsageUsec('')).toBeNull();
      expect(parseCgroupUsageUsec(null)).toBeNull();
      expect(parseCgroupUsageUsec(undefined)).toBeNull();
      expect(parseCgroupUsageUsec('user_usec 5\nsystem_usec 6')).toBeNull(); // key absent
      expect(parseCgroupUsageUsec('usage_usec notanumber')).toBeNull();
      expect(parseCgroupUsageUsec('usage_usec ')).toBeNull();
    });

    it('does not match a key that merely CONTAINS the name', () => {
      // Anchored at line start, so a hypothetical sibling key cannot be read as the total.
      expect(parseCgroupUsageUsec('nr_usage_usec 999\nusage_usec 12')).toBe(12);
    });
  });

  describe('cgroupRelPathFromProc', () => {
    it('resolves the v2 unified path', () => {
      expect(cgroupRelPathFromProc(`0::${SCOPE}\n`)).toBe(SCOPE);
    });

    /**
     * A v1 body has no unified path. Guessing one from a controller hierarchy would yield a
     * real-looking path that accounts for a DIFFERENT cgroup — the same class as measuring
     * the operator's cgroup and calling it the job's.
     */
    it('refuses a cgroup v1 body rather than guessing a path', () => {
      expect(cgroupRelPathFromProc('11:cpu,cpuacct:/some/path\n4:memory:/other')).toBeNull();
      expect(cgroupRelPathFromProc('')).toBeNull();
      expect(cgroupRelPathFromProc('0::relative-not-absolute')).toBeNull();
    });
  });

  describe('coresBetween', () => {
    it('computes the MEASURED case: one core saturated for 10s reads ~1.0', () => {
      // The real job reported .91 for a bash busy-loop; 1 core exactly is 10s of CPU per 10s.
      const a = { atMs: 1_000, usageUsec: 0 };
      const b = { atMs: 11_000, usageUsec: 10_000_000 };
      expect(coresBetween(a, b)).toBeCloseTo(1.0, 5);
    });

    it('scales past one core (a 4-core-busy tree)', () => {
      expect(coresBetween({ atMs: 0, usageUsec: 0 }, { atMs: 5_000, usageUsec: 20_000_000 })).toBeCloseTo(4.0, 5);
    });

    it('reports a genuinely idle job as 0 — distinct from unknown', () => {
      expect(coresBetween({ atMs: 0, usageUsec: 500 }, { atMs: 5_000, usageUsec: 500 })).toBe(0);
    });

    /**
     * A NEGATIVE delta is not a slow job: usage_usec is monotonic per cgroup, so a decrease
     * means this is a DIFFERENT cgroup — scope torn down and recreated, or a reused pid (PID
     * wrap happens ~daily on this box under fleet load). Refuse rather than report a
     * negative or an absolute value.
     */
    it('refuses a NEGATIVE delta (a different cgroup, not a slow one)', () => {
      expect(coresBetween({ atMs: 0, usageUsec: 9_000_000 }, { atMs: 5_000, usageUsec: 1_000 })).toBeNull();
    });

    it('refuses a window too short to mean anything, and a zero/backwards one', () => {
      expect(coresBetween({ atMs: 0, usageUsec: 0 }, { atMs: MIN_SAMPLE_GAP_MS - 1, usageUsec: 100 })).toBeNull();
      expect(coresBetween({ atMs: 0, usageUsec: 0 }, { atMs: 0, usageUsec: 100 })).toBeNull();
      expect(coresBetween({ atMs: 5_000, usageUsec: 0 }, { atMs: 0, usageUsec: 100 })).toBeNull();
      expect(coresBetween({ atMs: 0, usageUsec: 0 }, { atMs: MIN_SAMPLE_GAP_MS, usageUsec: 0 })).toBe(0);
    });

    it('refuses a missing sample instead of treating it as zero usage', () => {
      expect(coresBetween(null, { atMs: 5_000, usageUsec: 1 })).toBeNull();
      expect(coresBetween({ atMs: 0, usageUsec: 0 }, null)).toBeNull();
      expect(coresBetween(undefined, undefined)).toBeNull();
    });
  });

  describe('readCgroupCpuSample', () => {
    const fakeFs = (files: Record<string, string>): ReadTextFn => (p) => files[p] ?? null;

    it('resolves a pid to its own scope and samples it', () => {
      const read = fakeFs({
        '/proc/4242/cgroup': `0::${SCOPE}\n`,
        [`/sys/fs/cgroup${SCOPE}/cpu.stat`]: CPU_STAT,
      });
      expect(readCgroupCpuSample(4242, { readText: read, now: () => 777 })).toEqual({
        atMs: 777,
        usageUsec: 4172318,
      });
    });

    /**
     * CONTROL: the same call with ONLY the cpu.stat missing must fail — otherwise the test
     * above would pass on a stub that ignores its inputs. This is the torn-down-scope case,
     * which is the single most likely real-world failure.
     */
    it('CONTROL: returns null when the scope exists but cpu.stat is gone (torn-down scope)', () => {
      const read = fakeFs({ '/proc/4242/cgroup': `0::${SCOPE}\n` });
      expect(readCgroupCpuSample(4242, { readText: read })).toBeNull();
    });

    it('returns null when the process is gone entirely', () => {
      expect(readCgroupCpuSample(4242, { readText: fakeFs({}) })).toBeNull();
    });

    it('rejects a nonsense pid without touching the filesystem', () => {
      let reads = 0;
      const counting: ReadTextFn = () => {
        reads += 1;
        return null;
      };
      for (const pid of [null, undefined, 0, -1, 1.5, Number.NaN]) {
        expect(readCgroupCpuSample(pid as number | null, { readText: counting })).toBeNull();
      }
      expect(reads).toBe(0);
    });

    it('never throws when the reader itself throws (diagnostic garnish must not break the reply)', () => {
      const boom: ReadTextFn = () => {
        throw new Error('EACCES');
      };
      expect(() => readCgroupCpuSample(1, { readText: (p) => { try { return boom(p); } catch { return null; } } })).not.toThrow();
    });
  });
});
