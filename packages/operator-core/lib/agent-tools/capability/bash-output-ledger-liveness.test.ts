/**
 * capability:bash_output — diagnoseFromLedger (EI-18759519171684432).
 *
 * Before this fix, a stranded job (in-memory JOBS map entry gone, log file
 * survived) was diagnosed ENTIRELY from operator uptime vs the log's birth time
 * (diagnoseStrandedCause) — a heuristic that rules out ONE cause (a whole-operator
 * restart) but was never sound evidence that the job's OWN process actually died.
 * Live repro: a `test:affected` run was still executing (confirmed via `ps`, its
 * log file still growing) while the tool confidently told the caller "CONFIRMED
 * NOT the cause … the job's OWN process died independently" and advised re-running
 * it — doubling the load on an already-loaded box.
 *
 * `diagnoseFromLedger` consults the durable task-manager ledger row instead (it
 * survives the exact failure that wipes the in-memory registry) and, when the
 * ledger still shows the job non-terminal, RE-PROBES the recorded pid's process
 * identity (immune to PID reuse) rather than guessing. Pure unit tests — a fake
 * TaskRow + an injected probe function, no PG, no subprocess.
 */
import { describe, it, expect } from 'vitest';
import { diagnoseFromLedger, terminalStatusFromLedger } from './bash_output';
import type { TaskRow } from '../../task-manager/types';

function fakeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: 'tsk0000001',
    workspaceId: 'ws-1',
    rootTaskId: 'tsk0000001',
    class: 'bash-job',
    title: 'npm run test:affected',
    argv: ['bash', '-o', 'pipefail', '-c', 'npm run test:affected'],
    launchedBy: 'capability:bash',
    confined: true,
    state: 'running',
    startedAt: new Date(0).toISOString(),
    lastSeenAt: new Date(0).toISOString(),
    detail: { bashJobId: '5f4ad9a1-272' },
    ...overrides,
  };
}

describe('diagnoseFromLedger (EI-18759519171684432)', () => {
  it('reports no_ledger_row when no matching ledger row exists (job predates the ledger, or the write raced)', () => {
    expect(diagnoseFromLedger(null)).toEqual({ kind: 'no_ledger_row' });
  });

  it('reports confirmed_dead straight from a TERMINAL ledger state — stronger evidence than any heuristic', () => {
    const row = fakeRow({ state: 'exited', exitCode: 1, exitReason: null });
    expect(diagnoseFromLedger(row)).toEqual({
      kind: 'confirmed_dead',
      state: 'exited',
      exitCode: 1,
      exitReason: null,
      confined: true,
    });
  });

  it('reports confirmed_dead for every terminal state (killed / timed_out / stranded), carrying the recorded reason', () => {
    for (const state of ['killed', 'timed_out', 'stranded'] as const) {
      const row = fakeRow({ state, exitCode: null, exitReason: `test-${state}` });
      expect(diagnoseFromLedger(row)).toEqual({
        kind: 'confirmed_dead',
        state,
        exitCode: null,
        exitReason: `test-${state}`,
        confined: true,
      });
    }
  });

  it('reports confined:false on a stranded UNCONFINED row — EI-19315479997523199 (this is what lets the handler tell "routine operator restart" apart from "a confined job died unexpectedly")', () => {
    const row = fakeRow({ state: 'stranded', confined: false, exitReason: 'process identity linux:boot-x:1 is gone from the kernel' });
    expect(diagnoseFromLedger(row)).toEqual({
      kind: 'confirmed_dead',
      state: 'stranded',
      exitCode: null,
      exitReason: 'process identity linux:boot-x:1 is gone from the kernel',
      confined: false,
    });
  });

  it('reports confirmed_alive when the ledger is non-terminal AND the pid re-probe matches the recorded identity — THE live-repro regression', () => {
    const row = fakeRow({
      state: 'running',
      pid: 2820845,
      processIdentity: 'linux:boot-abc:123456',
      scopeUnit: 'pc-tsk0000001.scope',
    });
    const probe = (pid: number) => (pid === 2820845 ? 'linux:boot-abc:123456' : null);
    expect(diagnoseFromLedger(row, probe)).toEqual({
      kind: 'confirmed_alive',
      pid: 2820845,
      scopeUnit: 'pc-tsk0000001.scope',
      taskId: 'tsk0000001',
    });
  });

  it('does NOT report confirmed_alive when the probed identity differs (a DIFFERENT process now holds that pid — PID reuse)', () => {
    const row = fakeRow({ state: 'running', pid: 999, processIdentity: 'linux:boot-abc:111' });
    const probe = () => 'linux:boot-abc:999'; // a different process now owns pid 999
    expect(diagnoseFromLedger(row, probe)).toEqual({ kind: 'ledger_inconclusive' });
  });

  it('does NOT report confirmed_alive when the probe finds nothing (process genuinely gone) — falls to inconclusive, not a death claim', () => {
    const row = fakeRow({ state: 'running', pid: 999, processIdentity: 'linux:boot-abc:111' });
    const probe = () => null;
    expect(diagnoseFromLedger(row, probe)).toEqual({ kind: 'ledger_inconclusive' });
  });

  it('reports ledger_inconclusive when the row is non-terminal but carries no pid/processIdentity to re-probe', () => {
    const row = fakeRow({ state: 'pending', pid: null, processIdentity: null });
    expect(diagnoseFromLedger(row, () => 'should-not-be-called')).toEqual({ kind: 'ledger_inconclusive' });
  });

  it('never calls the probe for a terminal row — the recorded exit is authoritative on its own', () => {
    const row = fakeRow({ state: 'exited', exitCode: 0, pid: 123, processIdentity: 'linux:boot-abc:1' });
    let called = false;
    diagnoseFromLedger(row, () => {
      called = true;
      return 'linux:boot-abc:1';
    });
    expect(called).toBe(false);
  });
});

describe('terminalStatusFromLedger (EI-20232536598731015)', () => {
  it('preserves a durable clean exit as normal completed BashOutput status', () => {
    expect(terminalStatusFromLedger(fakeRow({ state: 'exited', exitCode: 0 }))).toEqual({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('does not turn a non-zero or unobserved terminal row into success', () => {
    expect(terminalStatusFromLedger(fakeRow({ state: 'exited', exitCode: 1 }))).toEqual({
      status: 'failed',
      exitCode: 1,
    });
    expect(terminalStatusFromLedger(fakeRow({ state: 'ended_unobserved', exitCode: null }))).toEqual({
      status: 'failed',
      exitCode: null,
    });
  });

  it('returns null while the durable row is still live', () => {
    expect(terminalStatusFromLedger(fakeRow({ state: 'running' }))).toBeNull();
  });
});
