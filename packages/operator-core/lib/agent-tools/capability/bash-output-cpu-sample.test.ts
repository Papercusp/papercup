import { describe, it, expect } from 'vitest';
import { sampleJobCpu } from './bash_output';
import type { BashJob } from './bash-jobs';

/**
 * EI-20051445912325691 — `bash_output` reports measured cgroup CPU without pretending that
 * wrapper CPU proves payload progress. The property under test is not the arithmetic (that is
 * covered in cgroup-cpu.test.ts) but the REFUSALS: every path that cannot measure must return
 * a reason, never a number, and never throw.
 */
describe('sampleJobCpu — cpu_cores on bash_output (EI-20051445912325691)', () => {
  const SCOPE =
    '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-bash.slice/papercusp-bash-job.slice/pc-0msn040hb1xzkt0q1we.scope';

  const cpuStat = (usageUsec: number) => `usage_usec ${usageUsec}\nuser_usec 1\nsystem_usec 2\n`;

  /** Minimal BashJob stand-in — only the fields sampleJobCpu reads. */
  const job = (over: Partial<BashJob> & { pid?: number | null } = {}): BashJob => {
    const { pid = 4242, ...rest } = over;
    return {
      id: 'job-1',
      status: 'running',
      child: { pid } as BashJob['child'],
      ...rest,
    } as BashJob;
  };

  const fs = (usageUsec: number | null, pid = 4242) => (p: string) => {
    if (p === `/proc/${pid}/cgroup`) return `0::${SCOPE}\n`;
    if (p === `/sys/fs/cgroup${SCOPE}/cpu.stat`) return usageUsec == null ? null : cpuStat(usageUsec);
    return null;
  };

  it('FIRST read takes a baseline and says so — it does not stall the reply to invent a rate', () => {
    const j = job();
    const out = sampleJobCpu(j, { readText: fs(1_000_000), now: () => 10_000 });
    expect(out.cpu_cores).toBeUndefined();
    expect(out.cpu_unavailable).toBe('awaiting-second-sample');
    expect(j.lastCpuSample).toEqual({ atMs: 10_000, usageUsec: 1_000_000 });
  });

  it('SECOND read reports cores burned since the last read (the measured 1-core case)', () => {
    const j = job();
    sampleJobCpu(j, { readText: fs(0), now: () => 0 });
    // 10s later, 10s of CPU consumed => exactly one core saturated.
    const out = sampleJobCpu(j, { readText: fs(10_000_000), now: () => 10_000 });
    expect(out.cpu_cores).toBe(1);
    expect(out.cpu_basis).toMatch(/one core saturated/);
    expect(out.cpu_basis).toMatch(/CPU use is NOT payload progress/);
    expect(out.cpu_basis).toMatch(/waiting-for-slot/);
    expect(out.cpu_basis).toMatch(/payload-emitted/);
  });

  it('reports a genuinely idle-but-running job as 0 — distinct from unavailable', () => {
    const j = job();
    sampleJobCpu(j, { readText: fs(5_000), now: () => 0 });
    const out = sampleJobCpu(j, { readText: fs(5_000), now: () => 10_000 });
    expect(out.cpu_cores).toBe(0);
    expect(out.cpu_unavailable).toBeUndefined();
  });

  /**
   * The three refusals. Each is a case where the shell recipe printed a plausible number:
   * an exited job whose scope is torn down produced `-3.35 cores`, and a foreground call
   * measured the operator's cgroup at 7.33 cores while the job burned 0.91.
   */
  it('refuses when the job is not running (its scope is being torn down)', () => {
    const out = sampleJobCpu(job({ status: 'completed' }), { readText: fs(1) });
    expect(out.cpu_unavailable).toBe('job-not-running');
    expect(out.cpu_cores).toBeUndefined();
  });

  it('refuses when the cgroup is unreadable, and when there is no pid at all', () => {
    expect(sampleJobCpu(job(), { readText: fs(null) }).cpu_unavailable).toBe('cgroup-unreadable');
    expect(sampleJobCpu(job({ pid: null }), { readText: fs(1) }).cpu_unavailable).toBe('cgroup-unreadable');
    expect(sampleJobCpu(job(), { readText: () => null }).cpu_unavailable).toBe('cgroup-unreadable');
  });

  /**
   * A usage_usec that went DOWN means a different cgroup (scope recreated, or a reused pid —
   * PID wrap happens ~daily here under fleet load). It must refuse rather than report a
   * negative rate, and it must re-baseline so the NEXT read can succeed.
   */
  it('refuses a backwards delta and re-baselines instead of reporting a negative rate', () => {
    const j = job();
    sampleJobCpu(j, { readText: fs(9_000_000), now: () => 0 });
    const out = sampleJobCpu(j, { readText: fs(1_000), now: () => 10_000 });
    expect(out.cpu_cores).toBeUndefined();
    expect(out.cpu_unavailable).toBe('awaiting-second-sample');
    expect(j.lastCpuSample).toEqual({ atMs: 10_000, usageUsec: 1_000 });
    // Re-baselined, so a normal read now works — the refusal is not sticky.
    expect(sampleJobCpu(j, { readText: fs(6_000_000), now: () => 20_000 }).cpu_cores).toBeCloseTo(0.6, 5);
  });

  it('NEVER throws, whatever the reader does — this is garnish on a reply that must still ship', () => {
    const thrower = () => {
      throw new Error('EACCES');
    };
    expect(() => sampleJobCpu(job(), { readText: thrower })).not.toThrow();
    expect(sampleJobCpu(job(), { readText: thrower }).cpu_unavailable).toBe('cgroup-unreadable');
  });
});
