/**
 * capability:bash_output — diagnoseStrandedCause (EI-18666279107998059). Pure unit
 * tests over the operator-uptime-vs-job-age check — no subprocess, deterministic.
 *
 * Before this fix, EVERY stranded background job (in-memory registry entry gone,
 * log file survived) was reported with the same misleading headline cause,
 * "the operator process that ran it restarted" — even when confirmed false live
 * (operator uptime far exceeded the job's age, and the job's own process was still
 * running per `pgrep`). `diagnoseStrandedCause` distinguishes the two possible
 * causes using only this process's own `process.uptime()` versus the job log
 * file's birth time: if the operator started AFTER the job's log was created, a
 * restart is the only possible explanation (this process wouldn't exist to answer
 * the call otherwise); if the operator has been up continuously since before the
 * job started, a restart is impossible and the job's own process must have died
 * independently.
 */
import { describe, it, expect } from 'vitest';
import { diagnoseStrandedCause } from './bash_output';

describe('diagnoseStrandedCause (EI-18666279107998059)', () => {
  it('confirms a restart when the operator process started AFTER the job began (job outlived the process that ran it)', () => {
    const now = 1_000_000;
    // Job log created 10 minutes before "now"; operator has been up only 2 minutes.
    const jobBirthtimeMs = now - 10 * 60_000;
    const processUptimeMs = 2 * 60_000;
    expect(diagnoseStrandedCause({ jobBirthtimeMs, processUptimeMs, now })).toBe('stranded_by_operator_restart');
  });

  it('confirms job_process_gone when the operator has been up continuously since BEFORE the job started (a restart is impossible)', () => {
    const now = 1_000_000;
    // Operator has been up 2 hours; the job only started 10 minutes ago.
    const jobBirthtimeMs = now - 10 * 60_000;
    const processUptimeMs = 2 * 60 * 60_000;
    expect(diagnoseStrandedCause({ jobBirthtimeMs, processUptimeMs, now })).toBe('job_process_gone');
  });

  it('is the exact live-observed regression: long operator uptime (~2.5h) with a much younger job must NOT report a restart', () => {
    // EI-18666279107998059's own repro: dev:service_health showed secondsSinceStart
    // 8819 (~2.45h) right after a job reported stranded — a restart was impossible.
    const now = 2_000_000_000;
    const processUptimeMs = 8819 * 1000;
    const jobBirthtimeMs = now - 60_000; // the job is only ~1 minute old
    expect(diagnoseStrandedCause({ jobBirthtimeMs, processUptimeMs, now })).toBe('job_process_gone');
  });

  it('treats the boundary (operator started EXACTLY at the job\'s birthtime) as NOT a restart', () => {
    const now = 1_000_000;
    const jobBirthtimeMs = now - 60_000;
    const processUptimeMs = 60_000; // processStartedAtMs === jobBirthtimeMs exactly
    expect(diagnoseStrandedCause({ jobBirthtimeMs, processUptimeMs, now })).toBe('job_process_gone');
  });

  it('defaults now/processUptimeMs from the real clock when omitted (does not throw, returns a valid verdict)', () => {
    const result = diagnoseStrandedCause({ jobBirthtimeMs: Date.now() - 1_000_000 });
    expect(['stranded_by_operator_restart', 'job_process_gone']).toContain(result);
  });
});
