import { describe, expect, it, vi } from 'vitest';

import {
  buildCrashCheckpointResult,
  buildTerminalFailureCheckpointResult,
  createFatalProcessHandler,
  emitTerminalCheckpointResult,
  GREEN_CHECKPOINT_RESULT_MARKER,
} from './green-checkpoint';
// EI-21465187777146773: the CONSUMER half of the seam these builders sit on. Imported for real
// (as torn-sweep-classification-path.test.ts does) rather than restated as a literal — the whole
// defect was that the producer's vocabulary and the consumer's class list drifted apart while
// both suites stayed green.
import { classifyGateStallStatus } from '@papercusp/operator-core/lib/harness/routines/release-actions';
import {
  classifyGateAbort,
  gateAbortLever,
  isRecordedInconclusiveStatus,
} from '@papercusp/operator-core/lib/release/gate-abort-status';

describe('EI-21462448110688084: process-level fatal errors await terminal finalization', () => {
  it('does not exit until the typed-result finalizer completes', async () => {
    let finish!: (owned: boolean) => void;
    const finalize = vi.fn(
      () => new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const exit = vi.fn();
    const handler = createFatalProcessHandler(finalize, exit);

    const fatal = new Error('dependency-generation output escaped the run promise');
    handler(fatal);
    expect(finalize).toHaveBeenCalledWith(fatal);
    expect(exit).not.toHaveBeenCalled();

    finish(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('claims only the first fatal event while finalization is in flight', () => {
    const finalize = vi.fn(() => new Promise<boolean>(() => {}));
    const handler = createFatalProcessHandler(finalize, vi.fn());
    handler(new Error('first'));
    handler(new Error('second'));
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('emits and cleans an exact candidate when dependency generation dies after the after-copy manifest begins', async () => {
    const candidate = '8104d3804ac4d134cead82a10c89c54d5efa53b7';
    const markerLines: string[] = [];
    const emitted: string[] = [];
    const cleaned: string[] = [];
    const exited: number[] = [];
    const handler = createFatalProcessHandler(
      async (error) => {
        const result = buildTerminalFailureCheckpointResult({
          candidate,
          error,
          runId: 'scheduled-05a2a744',
        });
        await emitTerminalCheckpointResult(result, {
          writeHuman: vi.fn(),
          writeMarker: (line) => markerLines.push(line),
          emitInconclusive: async (terminal) => {
            emitted.push(`${terminal.candidate}:${terminal.green}`);
          },
          retire: async (terminal) => {
            cleaned.push(terminal.candidate);
          },
        });
        return true;
      },
      (code) => exited.push(code),
    );

    handler(
      new Error(
        'dependency-generation stdout: capturing live dependency manifest (after copy)\n' +
          'dependency-generation process exited 1',
      ),
    );
    await vi.waitFor(() => expect(exited).toEqual([1]));

    expect(markerLines).toHaveLength(1);
    expect(markerLines[0]).toContain(GREEN_CHECKPOINT_RESULT_MARKER);
    const terminal = JSON.parse(markerLines[0].slice(markerLines[0].indexOf('{')));
    expect(terminal).toMatchObject({
      candidate,
      green: null,
      // EI-21465187777146773: the marker a CAUGHT crash publishes now carries the same
      // no-verdict status an UNREPORTED crash gets from checkpointFallbackStatus.
      reason: 'error',
      crashed: true,
      runId: 'scheduled-05a2a744',
    });
    expect(emitted).toEqual([`${candidate}:null`]);
    expect(cleaned).toEqual([candidate]);
  });
});

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
  it('produces an INCONCLUSIVE, non-advancing verdict flagged as crashed', () => {
    const r = buildCrashCheckpointResult({ candidate: 'abc123', error: new Error('lint:plane-ratchet exited 1'), runId: 'run-1' });
    expect(r.green).toBeNull();
    expect(r.advanced).toBe(false);
    expect(r.reason).toBe('error');
    expect(r.crashed).toBe(true);
    expect(r.from).toBeNull();
    expect(r.candidate).toBe('abc123');
    expect(r.runId).toBe('run-1');
  });

  /**
   * EI-20702428259478130 — these two pin the DISCRIMINATION, which is the whole point of the
   * field and the part a future edit is most likely to "simplify" away.
   *
   * `green: false` is the type's assertion that a verdict was rendered and the code is RED. A
   * crash renders no verdict, so as `false` this result was indistinguishable in the ledger from
   * a real test failure — and worse, `green === null` is the ONLY dispatch for
   * `green-checkpoint:inconclusive` (green-checkpoint.ts's emitInconclusiveVerdict), so every
   * agent parked on `checkpoint:await` was told the CODE was broken on the one class of run where
   * the truth is "the gate is wedged".
   */
  it('is strictly null — not false — so the inconclusive-verdict dispatch fires', () => {
    const r = buildCrashCheckpointResult({ candidate: 'abc123', error: new Error('boom'), runId: 'run-6' });
    // The literal condition at the emitResult dispatch site. `=== null` does not admit `false`,
    // which is exactly why the bug was invisible: both are falsy.
    expect(r.green === null).toBe(true);
    expect(r.green).not.toBe(false);
  });

  /**
   * EI-21465187777146773 — this test's PROPERTY is inherited unchanged from the one it replaces
   * ("a persistent crash must keep counting and keep firing the held-gate alarm"); only the
   * counter it counts in has moved. Read the whole comment before touching the expectation.
   *
   * The predecessor pinned `reason === 'not-green'`, and its reasoning was sound at the time:
   * release-actions derives `status` from `reason` and NEVER from `green`, so softening the
   * reason would have made a crash-looping gate go silent — and silence is how `main` freezes
   * with nobody told. What it could not express is that 'not-green' bought that loudness by
   * asserting something false: a red verdict, with an EMPTY failing-test list, about code no run
   * had judged. EI-21462211894072863 built the class that gets both — `'error'` counts in
   * `gate_health.consecutiveNoVerdict` and escalates at the same `stallReds` threshold, saying
   * WEDGED rather than RED — so staying loud no longer costs a fabricated verdict.
   *
   * ⚠ Asserting the reason STRING alone is what let this defect exist: the producer said
   * 'not-green' while the consumer's no-verdict class only ever recognized 'error', and both
   * suites stayed green through the disagreement. So the assertion runs the builder's OWN output
   * through the real consumer instead, in the manner of torn-sweep-classification-path.test.ts.
   */
  it('⭐ a crash still COUNTS — the builder\'s own reason routes to no-verdict, never red, never a silent noop', () => {
    const r = buildCrashCheckpointResult({ candidate: 'abc123', error: new Error('boom'), runId: 'run-7' });
    expect(r.reason).toBe('error');
    // The seam. Both collapse directions are stated explicitly so neither is reachable silently:
    expect(classifyGateStallStatus(r.reason, false)).toBe('no-verdict');
    expect(classifyGateStallStatus(r.reason, false)).not.toBe('red'); // the fabricated verdict
    expect(classifyGateStallStatus(r.reason, false)).not.toBe('noop'); // the silence WI-39841 feared
    // …and a moved pin still wins, exactly as for every other status.
    expect(classifyGateStallStatus(r.reason, true)).toBe('reset');
  });

  it('⭐ and stays VISIBLE — the reason is a recorded abort, classified transient (a crash latches nothing)', () => {
    // Counting it is only half of "loud": a reader has to be able to see it. A reason outside
    // RECORDED_INCONCLUSIVE_STATUSES records a tick nobody can be advised about.
    const r = buildCrashCheckpointResult({ candidate: 'abc123', error: new Error('boom'), runId: 'run-8' });
    expect(isRecordedInconclusiveStatus(r.reason)).toBe(true);
    expect(classifyGateAbort(r.reason)).toBe('transient');
    // The advice must not send the reader at a failing-test list this tick never produced —
    // the exact response the no-verdict split exists to prevent.
    expect(gateAbortLever(r.reason)).toMatch(/do NOT triage/i);
  });

  /**
   * PERMANENT FALSIFIABILITY CONTROL (repo convention: for a module you import, keep a
   * deliberately-wrong implementation in the test file rather than mutating the shared tree — a
   * mutation probe would hold a real source file modified for the life of the run, which
   * git-sync's whole-tree sweep can commit even when nothing goes wrong).
   *
   * `preFixCrashResult` is `buildCrashCheckpointResult` AS IT BEHAVED before this change. Its
   * divergence from the real builder is ONE field, and the calibration below pins that, so the
   * failure it produces is attributable to this fix rather than to an unrelated difference.
   */
  it('CONTROL: the pre-fix crash result FAILS the property the fixed one satisfies', () => {
    const opts = { candidate: 'abc123', error: new Error('boom'), runId: 'run-control' };
    const real = buildCrashCheckpointResult(opts);
    const preFix = { ...real, reason: 'not-green' as const };

    // CALIBRATION — everything the fix did not touch must still agree, or the divergence below
    // says nothing about this change. `green: null` in particular: the pre-fix builder ALREADY
    // returned it, which is why the tri-state alone never fixed the streak.
    expect(preFix.green).toBe(real.green);
    expect(preFix.green).toBeNull();
    expect(preFix.crashed).toBe(real.crashed);
    expect(preFix.summary).toBe(real.summary);
    expect(preFix.advanced).toBe(real.advanced);

    // …and diverges at EXACTLY the defect: the old reason banked a red for a run that judged
    // nothing, and was not even a status a reader could be advised about.
    expect(classifyGateStallStatus(preFix.reason, false)).toBe('red');
    expect(classifyGateStallStatus(real.reason, false)).toBe('no-verdict');
    expect(isRecordedInconclusiveStatus(preFix.reason)).toBe(false);
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
    // Survives the round-trip as null (JSON has a null; the risk would be it becoming absent,
    // which downstream `?? null` coercions would then read as an ordinary missing field).
    expect(parsed.green).toBeNull();
    expect('green' in parsed).toBe(true);
  });
});

describe('WI-40916 / EI-212278: materialization admission refusal is not a code red', () => {
  const refusal = new Error(
    'bash /repo/scripts/pc-heavy.sh --exclusive-all-slots -- bash setup-release-checkout.sh ' +
      'exited 75: [pc-heavy] REFUSED materialization after 900s: only 13/16 heavy slots drained',
  );

  it('classifies the exact bounded drain refusal as infra-inconclusive', () => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: 'abc123',
      error: refusal,
      runId: 'run-materializing',
    });
    expect(r.green).toBeNull();
    expect(r.advanced).toBe(false);
    expect(r.reason).toBe('infra-inconclusive');
    expect(r.crashed).toBeUndefined();
    expect(r.summary).toContain('No code verdict was rendered');
    expect(r.summary).toContain('13/16 heavy slots drained');
  });

  it.each([
    ['wrong mode', 'pc-heavy.sh npm test exited 75: [pc-heavy] REFUSED materialization'],
    ['wrong exit', 'pc-heavy.sh --exclusive-all-slots exited 1: [pc-heavy] REFUSED materialization'],
    ['missing marker', 'pc-heavy.sh --exclusive-all-slots exited 75: unknown failure'],
  ])('keeps an unknown crash counting when the signature is incomplete: %s', (_label, message) => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: 'abc123',
      error: new Error(message),
      runId: 'run-generic',
    });
    // EI-21465187777146773: the generic crash path now says 'error'. The discrimination this
    // test exists for is UNCHANGED and is still the load-bearing part — an incomplete signature
    // must not be absorbed into the measured infra class, because 'infra-inconclusive' is a
    // true NOOP (it disturbs no counter at all) while a crash has to keep counting.
    expect(r.reason).toBe('error');
    expect(r.crashed).toBe(true);
    expect(classifyGateStallStatus(r.reason, false)).toBe('no-verdict');
    expect(classifyGateStallStatus('infra-inconclusive', false)).toBe('noop');
  });
});

describe('WI-41252 / D-066: dependency-generation torn snapshots are not code reds', () => {
  it.each([
    [
      'new generation changed during copy',
      'bash /repo/apps/operator/bin/release/dependency-generation.sh --integration /repo exited 75: ' +
        '[dependency-generation] FATAL: live node_modules changed during generation build; refusing a torn snapshot',
    ],
    [
      'existing generation changed while pinning',
      'bash /repo/apps/operator/bin/release/dependency-generation.sh --integration /repo exited 75: ' +
        '[dependency-generation] FATAL: live node_modules changed while pinning an existing generation',
    ],
  ])('classifies %s as infra-inconclusive with the exact dependency phase', (_label, message) => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: 'dfe7bd9f4e56',
      error: new Error(message),
      runId: 'run-dependency-generation',
    });

    expect(r).toMatchObject({
      advanced: false,
      candidate: 'dfe7bd9f4e56',
      from: null,
      green: null,
      reason: 'infra-inconclusive',
      runId: 'run-dependency-generation',
    });
    expect(r.crashed).toBeUndefined();
    expect(r.summary).toContain('pinning an immutable dependency generation');
    expect(r.summary).toContain('refused a torn snapshot');
    expect(r.summary).toContain('No code verdict was rendered');
  });

  it.each([
    ['wrong exit', 'dependency-generation.sh exited 1: refusing a torn snapshot'],
    ['missing script identity', 'publisher exited 75: refusing a torn snapshot'],
    ['missing torn-source marker', 'dependency-generation.sh exited 75: unknown failure'],
  ])('keeps an incomplete dependency signature on the generic crash path: %s', (_label, message) => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: 'dfe7bd9f4e56',
      error: new Error(message),
      runId: 'run-generic',
    });
    // EI-21465187777146773: 'error' is the generic crash path's reason now — still counting
    // (no-verdict), still NOT the measured infra noop the exact signatures earn.
    expect(r.reason).toBe('error');
    expect(r.crashed).toBe(true);
    expect(classifyGateStallStatus(r.reason, false)).toBe('no-verdict');
  });
});
