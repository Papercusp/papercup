/**
 * boundTestRunPayload — plan `bash-substitution-reachable-ceiling-2026-08-01`, D-062.
 *
 * `testing:run` is promoted over `npm run test:file -- … 2>&1 | tail -60` on a
 * per-call DOMINANCE argument: it must be cheaper on the calls that HURT, not
 * merely on average. An average lets the tool be worse exactly when a suite
 * fails badly and the agent can least afford the context. `| tail -60` hard-caps
 * bash at 5,949 B; before this bound existed `testing:run` reached 20,569 B,
 * with 2.6% of calls carrying 28.7% of all its bytes.
 *
 * The subtle requirement, and the one these tests exist to pin: `maxFailures`
 * caps the failure LIST COUNT, which is not a byte bound in any sense — one long
 * assertion diff outweighs fifty terse failures.
 *
 * Lives in its own file, like its `mergeDistilledRuns` sibling: these are pure
 * assertions that want neither the child_process fakes nor the resetModules
 * dance in testing-run-store.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  boundTestRunPayload,
  TESTING_RUN_MAX_PAYLOAD_BYTES,
  type DistilledTestRun,
} from './testing-run-store';

function run(over: Partial<DistilledTestRun> = {}): DistilledTestRun {
  return {
    passed: 0, failed: 0, skipped: 0, files: 0,
    failures: [], failuresTruncated: false, durationMs: null, byFile: {},
    ...over,
  };
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

function failure(i: number, messageChars: number) {
  return {
    file: `packages/operator-core/lib/some/area/module-${i}.test.ts`,
    test: `suite ${i} > does the thing it says it does`,
    message: 'x'.repeat(messageChars),
  };
}

describe('boundTestRunPayload', () => {
  it('leaves an ordinary GREEN result byte-identical — the median must not move', () => {
    // The verification criterion for D-062 is that the MAX drops to <=5,949 B
    // while the MEDIAN stays near 197 B. The median call is a green run, so if
    // this function added explanatory fields unconditionally it would move the
    // very number that certifies the change worked.
    const green = run({ passed: 27, files: 1, durationMs: 2159 });
    const envelope = { ok: true, runId: 'abc' };

    const bounded = boundTestRunPayload(envelope, green);

    expect(bounded).toEqual({ ...envelope, ...green });
    expect(bounded).not.toHaveProperty('truncationNote');
    expect(bounded).not.toHaveProperty('failuresReturned');
    expect(bounded).not.toHaveProperty('failuresOmitted');
    expect(bytes(bounded)).toBe(bytes({ ...envelope, ...green }));
  });

  it('leaves a small RED result untouched — bounding only engages when it must', () => {
    const red = run({ passed: 5, failed: 1, files: 1, failures: [failure(1, 80)] });

    const bounded = boundTestRunPayload({ ok: false, runId: 'r' }, red);

    expect(bounded.failures).toHaveLength(1);
    expect(bounded.failures[0].message).toBe('x'.repeat(80));
    expect(bounded).not.toHaveProperty('truncationNote');
    expect(bytes(bounded)).toBeLessThanOrEqual(TESTING_RUN_MAX_PAYLOAD_BYTES);
  });

  it('bounds a payload that maxFailures could never bound: FEW failures, HUGE messages', () => {
    // Three failures is well under maxFailures' default of 20, so the existing
    // list cap does nothing here. The bytes come from the diffs.
    const red = run({
      failed: 3, files: 3,
      failures: [failure(1, 20_000), failure(2, 20_000), failure(3, 20_000)],
    });

    const bounded = boundTestRunPayload({ ok: false, runId: 'r' }, red);

    expect(bytes(bounded)).toBeLessThanOrEqual(TESTING_RUN_MAX_PAYLOAD_BYTES);
    expect(bounded.failuresTruncated).toBe(true);
    // Messages were shrunk, but WHICH tests failed is fully preserved.
    expect(bounded.failures).toHaveLength(3);
    expect(bounded.failed).toBe(3);
  });

  it('keeps every COUNT complete and states both numbers, so failures.length can never be read as "how many failed"', () => {
    const red = run({
      passed: 100, failed: 60, skipped: 2, files: 12,
      failures: Array.from({ length: 60 }, (_, i) => failure(i, 4_000)),
    });

    const bounded = boundTestRunPayload({ ok: false, runId: 'r' }, red);

    expect(bytes(bounded)).toBeLessThanOrEqual(TESTING_RUN_MAX_PAYLOAD_BYTES);
    // The counts are the TRUE totals, untouched by the byte bound.
    expect(bounded.passed).toBe(100);
    expect(bounded.failed).toBe(60);
    expect(bounded.skipped).toBe(2);
    // ...and the payload says out loud that the list is a sample.
    expect(bounded.failures.length).toBeLessThan(60);
    expect(bounded.failuresReturned).toBe(bounded.failures.length);
    expect(bounded.failuresOmitted).toBe(60 - bounded.failures.length);
    expect(bounded.truncationNote).toContain('of 60 failing test(s)');
    expect(bounded.truncationNote).toContain('COMPLETE');
  });

  it('never reports ZERO failures for a red run, even when one failure alone overruns the budget', () => {
    // The worst case: a single collection failure carrying a 200KB stack. Dropping
    // it would leave `failures: []` on a red run — the exact shape that reads as
    // "nothing to see here" and is the incident mergeDistilledRuns was built for.
    const red = run({ failed: 1, files: 1, failures: [failure(1, 200_000)] });

    const bounded = boundTestRunPayload({ ok: false, runId: 'r' }, red);

    expect(bytes(bounded)).toBeLessThanOrEqual(TESTING_RUN_MAX_PAYLOAD_BYTES);
    expect(bounded.failures).toHaveLength(1);
    expect(bounded.failures[0].file).toBe(red.failures[0].file);
    expect(bounded.failures[0].test).toBe(red.failures[0].test);
    expect(bounded.failed).toBe(1);
  });

  it('honours an explicit maxBytes, so the bound is testable without hardcoding the derived constant', () => {
    const red = run({ failed: 5, files: 5, failures: Array.from({ length: 5 }, (_, i) => failure(i, 5_000)) });

    const bounded = boundTestRunPayload({ ok: false, runId: 'r' }, red, { maxBytes: 1_500 });

    expect(bytes(bounded)).toBeLessThanOrEqual(1_500);
    expect(bounded.failed).toBe(5);
    expect(bounded.failuresTruncated).toBe(true);
  });

  it('preserves an upstream truncation flag that maxFailures already set', () => {
    // distillVitestRun/mergeDistilledRuns may have already cut the list via
    // maxFailures. That flag must survive, and the omitted count must be
    // computed against the TRUE total rather than the list we received.
    const red = run({
      failed: 40, files: 4, failuresTruncated: true,
      failures: Array.from({ length: 20 }, (_, i) => failure(i, 50)),
    });

    const bounded = boundTestRunPayload({ ok: false, runId: 'r' }, red);

    expect(bounded.failuresTruncated).toBe(true);
    expect(bounded.failuresOmitted).toBe(40 - bounded.failures.length);
    expect(bounded.truncationNote).toContain('of 40 failing test(s)');
  });

  it('is derived from the bash `| tail -60` ceiling, not rounded', () => {
    // Guards the constant itself: D-062 fixed it at the measured cap of the
    // command this tool replaces. A future "tidy up to 6000" silently forfeits
    // the per-call dominance argument the promotion rests on.
    expect(TESTING_RUN_MAX_PAYLOAD_BYTES).toBe(5949);
  });
});
