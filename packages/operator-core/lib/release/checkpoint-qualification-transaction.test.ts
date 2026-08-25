import { describe, expect, it } from 'vitest';
import {
  beginQualificationTransaction,
  classifyQualificationVerdict,
  reserveQualificationRunner,
  settleQualificationTransaction,
  waitQualificationTransaction,
} from './checkpoint-qualification-transaction';

const begin = () => beginQualificationTransaction(null, {
  attemptId: 'attempt-1',
  requiredAncestorSha: 'abc123',
  declaredPaths: ['b.ts', 'a.ts', 'a.ts'],
  candidate: 'candidate-1',
  evidenceRefs: ['tool:release:checkpoint-run'],
  nowMs: 100,
}).transaction;

describe('logical checkpoint qualification transaction', () => {
  it('creates one normalized durable identity and reuses the same attempt idempotently', () => {
    const current = begin();
    expect(current).toMatchObject({
      attemptId: 'attempt-1',
      phase: 'ready',
      outcome: { kind: 'pending' },
      candidatePolicy: { kind: 'quiet-cut', declaredPaths: ['b.ts', 'a.ts'] },
      waitGeneration: 0,
    });
    expect(beginQualificationTransaction(current, { attemptId: 'attempt-1', nowMs: 200 }).status).toBe('idempotent');
    expect(beginQualificationTransaction(current, { attemptId: 'attempt-2', nowMs: 200 }).status).toBe('conflict');
  });

  it('persists retryable no-verdict waits and allows at most one physical runner', () => {
    const waiting = waitQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'eligibility-wait',
      blockers: [{ code: 'quiet-cut', clearEvents: ['checkpoint:eligible:attempt-1'] }],
      nowMs: 200,
    }).transaction;
    expect(waiting).toMatchObject({ phase: 'waiting', waitGeneration: 1, currentPhysicalRunner: null });

    const running = reserveQualificationRunner(waiting, {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      nowMs: 300,
    }).transaction;
    expect(running).toMatchObject({ phase: 'running', currentPhysicalRunner: { id: 'physical-1' } });
    expect(reserveQualificationRunner(running, { attemptId: 'attempt-1', runnerId: 'physical-1' }).status).toBe('idempotent');
    expect(reserveQualificationRunner(running, { attemptId: 'attempt-1', runnerId: 'physical-2' }).status).toBe('conflict');
  });

  it('retries only the explicit pre-suite no-verdict allowlist and makes red/code outcomes terminal', () => {
    expect(classifyQualificationVerdict({ reason: 'migrations-pending', green: null })).toEqual({
      kind: 'pre-suite-no-verdict', reason: 'migrations-pending',
    });
    expect(classifyQualificationVerdict({ reason: 'not-green', green: false })).toEqual({ kind: 'red', reason: 'not-green' });
    expect(classifyQualificationVerdict({ reason: 'not-fast-forward', green: null })).toEqual({
      kind: 'code-inconclusive', reason: 'not-fast-forward',
    });

    const red = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1', reason: 'not-green', green: false, nowMs: 400,
    }).transaction;
    expect(red).toMatchObject({ phase: 'terminal', outcome: { kind: 'red' }, currentPhysicalRunner: null });
    expect(waitQualificationTransaction(red, {
      attemptId: 'attempt-1', reason: 'eligibility-wait', nowMs: 500,
    }).status).toBe('terminal');
  });
});
