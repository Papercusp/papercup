import { describe, expect, it } from 'vitest';

import { buildCrashCheckpointResult } from './green-checkpoint';

/**
 * EI-18850448565330905 — a green-checkpoint run that dies inside a non-test leg (a
 * PG-backed plane lint, or anything else that throws instead of reporting a normal red
 * through allowNonZero/haltedBy) used to leave NO `__GREEN_CHECKPOINT_RESULT__` marker at
 * all: the CLI entrypoint's `.catch` only `console.error`'d and exited. Every downstream
 * reader then saw either nothing or a stale PREVIOUS verdict, and the raw log read as
 * truncated/OOM-killed rather than as a reported failure.
 *
 * `buildCrashCheckpointResult` is the pure core of the fix — the CLI's `.catch` blocks now
 * resolve a best-effort candidate (via `revParse`, not exercised here) and pass it plus the
 * caught error into this function before calling `emitResult`. These tests pin its SHAPE,
 * since the `require.main === module` CLI block itself is not unit-testable in isolation.
 */
describe('EI-18850448565330905: buildCrashCheckpointResult never leaves a crash unreported', () => {
  it('produces a red, non-advancing verdict flagged as crashed', () => {
    const r = buildCrashCheckpointResult({ candidate: 'abc123', error: new Error('lint:plane-ratchet exited 1'), runId: 'run-1' });
    expect(r.green).toBe(false);
    expect(r.advanced).toBe(false);
    expect(r.reason).toBe('not-green');
    expect(r.crashed).toBe(true);
    expect(r.from).toBeNull();
    expect(r.candidate).toBe('abc123');
    expect(r.runId).toBe('run-1');
  });

  it('carries the thrown Error\'s stack (falling back to its message) in the summary', () => {
    const err = new Error('boom');
    const r = buildCrashCheckpointResult({ candidate: 'deadbeef', error: err, runId: 'run-2' });
    expect(r.summary).toContain('green-checkpoint crashed before producing a normal verdict');
    expect(r.summary).toContain(err.stack ?? err.message);
  });

  it('stringifies a non-Error throw rather than losing it', () => {
    const r = buildCrashCheckpointResult({ candidate: 'deadbeef', error: 'a plain string rejection', runId: 'run-3' });
    expect(r.summary).toContain('a plain string rejection');
  });

  it('handles an Error with no stack by falling back to its message', () => {
    const err = new Error('no-stack');
    err.stack = undefined;
    const r = buildCrashCheckpointResult({ candidate: 'deadbeef', error: err, runId: 'run-4' });
    expect(r.summary).toContain('no-stack');
  });

  it('is JSON-serializable (the CLI emits it verbatim on the result-marker line)', () => {
    const r = buildCrashCheckpointResult({ candidate: 'abc123', error: new Error('boom'), runId: 'run-5' });
    expect(() => JSON.stringify(r)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(r));
    expect(parsed.crashed).toBe(true);
    expect(parsed.green).toBe(false);
  });
});
