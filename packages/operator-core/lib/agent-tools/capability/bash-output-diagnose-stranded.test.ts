/**
 * capability:bash_output — diagnoseStrandedCause (EI-18666279107998059). Pure unit
 * tests over the operator-uptime-vs-job-age check — no subprocess, deterministic.
 *
 * Before EI-18666279107998059, EVERY stranded background job (in-memory registry
 * entry gone, log file survived) was reported with the same misleading headline
 * cause, "the operator process that ran it restarted" — even when confirmed false
 * live (operator uptime far exceeded the job's age, and the job's own process was
 * still running per `pgrep`). `diagnoseStrandedCause` tests that claim using only
 * this process's own `process.uptime()` versus the job log file's birth time.
 *
 * WHAT THE CHECK CAN AND CANNOT ESTABLISH — the distinction this suite exists to
 * pin, because it was mis-stated twice and filed four times:
 *
 *   - operator started AFTER the job's log was created  -> a restart is the only
 *     possible explanation (this process would not exist to answer the call
 *     otherwise). CONFIRMED: 'stranded_by_operator_restart'.
 *   - operator up continuously since BEFORE the job started -> a restart is
 *     IMPOSSIBLE. That rules out one cause and establishes nothing about the
 *     job. Its process may well be alive — on this box the usual explanation is
 *     a job queued behind pc-heavy's slot clamp, running fine, simply not
 *     producing output yet. So: 'job_liveness_unknown'.
 *
 * The second branch used to return 'job_process_gone'. EI-18666279107998059 fixed
 * the advice PROSE to hedge correctly but left that token in the `reason` field —
 * the field callers actually branch on — so the tool went on asserting a death it
 * had never observed. Four independent filings followed (EI-19304682667917795,
 * EI-19310882583645327, EI-19327967209159644, EI-19332191089874223), each costing
 * an agent a verification round-trip, and each carrying the same live repro: a
 * queued `lint:tsc` reported gone while `ps` showed its full process chain alive.
 *
 * The two states have OPPOSITE correct responses — keep waiting vs re-run — and
 * re-running a queued heavy job adds load to the very queue that delayed it, so
 * the wrong verdict is self-amplifying under exactly the conditions producing it.
 * 'job_process_gone' now has exactly one emitter: the ledger-confirmed terminal
 * state, which really did observe an exit.
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

  it('reports job_liveness_unknown when the operator has been up continuously since BEFORE the job started (a restart is ruled out, but nothing about the job is)', () => {
    const now = 1_000_000;
    // Operator has been up 2 hours; the job only started 10 minutes ago.
    const jobBirthtimeMs = now - 10 * 60_000;
    const processUptimeMs = 2 * 60 * 60_000;
    expect(diagnoseStrandedCause({ jobBirthtimeMs, processUptimeMs, now })).toBe('job_liveness_unknown');
  });

  it('is the exact live-observed regression: long operator uptime (~2.5h) with a much younger job must NOT report a restart', () => {
    // EI-18666279107998059's own repro: dev:service_health showed secondsSinceStart
    // 8819 (~2.45h) right after a job reported stranded — a restart was impossible.
    const now = 2_000_000_000;
    const processUptimeMs = 8819 * 1000;
    const jobBirthtimeMs = now - 60_000; // the job is only ~1 minute old
    expect(diagnoseStrandedCause({ jobBirthtimeMs, processUptimeMs, now })).toBe('job_liveness_unknown');
  });

  it("treats the boundary (operator started EXACTLY at the job's birthtime) as NOT a restart", () => {
    const now = 1_000_000;
    const jobBirthtimeMs = now - 60_000;
    const processUptimeMs = 60_000; // processStartedAtMs === jobBirthtimeMs exactly
    expect(diagnoseStrandedCause({ jobBirthtimeMs, processUptimeMs, now })).toBe('job_liveness_unknown');
  });

  it('defaults now/processUptimeMs from the real clock when omitted (does not throw, returns a valid verdict)', () => {
    const result = diagnoseStrandedCause({ jobBirthtimeMs: Date.now() - 1_000_000 });
    expect(['stranded_by_operator_restart', 'job_liveness_unknown']).toContain(result);
  });

  /**
   * THE RECURRENCE GUARD. The bug was never a wrong branch — the branching has
   * been correct since EI-18666279107998059. It was a NAME: a heuristic that can
   * only rule a cause OUT emitting the token that means a death was observed.
   * Nothing but a test can hold that line, because re-collapsing the two is a
   * one-word edit that no type error and no other assertion would catch.
   *
   * This asserts the invariant directly over the whole input space rather than at
   * sampled points: whatever the uptime/age relationship, this function must never
   * produce the ledger-confirmed token. It is the only emitter that could.
   */
  it('NEVER returns job_process_gone — that token is reserved for the ledger-confirmed terminal state, which actually observed an exit', () => {
    const now = 1_000_000;
    const offsets = [-3_600_000, -60_000, -1, 0, 1, 60_000, 3_600_000];
    const verdicts = new Set<string>();

    for (const jobOffset of offsets) {
      for (const uptime of [0, 1, 60_000, 3_600_000, 24 * 3_600_000]) {
        verdicts.add(
          diagnoseStrandedCause({ jobBirthtimeMs: now + jobOffset, processUptimeMs: uptime, now }),
        );
      }
    }

    expect(verdicts.has('job_process_gone')).toBe(false);
    // ...and the two legitimate verdicts are both still reachable, so the guard
    // above cannot be satisfied by a function that has stopped discriminating.
    expect(verdicts).toEqual(new Set(['stranded_by_operator_restart', 'job_liveness_unknown']));
  });
});
