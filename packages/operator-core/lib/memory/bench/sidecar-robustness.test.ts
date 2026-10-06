import { describe, expect, it } from 'vitest';
import { hashJson } from './measurement-manifest';
import { parseRobustnessInput, summarizeRobustnessReport, ROBUSTNESS_PHASES, type RobustnessIdentity,
  type RobustnessInput, type RobustnessReport, type RobustnessSample } from './sidecar-robustness';

const raw = {
  formatVersion: 1, seed: 'unit', serverConcurrency: 1, requestTimeoutMs: 5000,
  requests: { query: [{ id: 'q0', text: 'a' }, { id: 'q1', text: 'b' }], document: [{ id: 'd0', text: 'c' }, { id: 'd1', text: 'd' }],
    long: { id: 'long', text: 'long text' } },
  concurrency: { clients: 2, rounds: 1 }, saturation: { inFlight: 2, deadlineMs: 1000, drainWithinMs: 1000 },
  coalescing: { duplicates: 2 }, timeout: { clientDeadlineMs: 100, recoveryWithinMs: 1000 },
  cancellation: { requests: 1, abortAfterMs: 50, releaseWithinMs: 1000, drainWithinMs: 1000 },
  crash: { cycles: 1, inFlight: 1, startWithinMs: 1000, settleWithinMs: 500, recoveryWithinMs: 1000 },
  soak: { durationMs: 1000, clients: 1, windowFraction: 0.25 }, sampling: { healthzIntervalMs: 50, healthzTimeoutMs: 500 },
  gates: { cosineMin: 0.99999, maxAbs: 0.00003 },
  thresholds: { healthzP99Ms: 100, eventLoopDelayP99Ms: 50, soakLateP95Ratio: 1.5, rssGrowthMiB: 32, timeoutSlackMs: 20 },
};
const expected: RobustnessIdentity = { model: 'mdenseon', modelRev: 'rev', runtime: 'node-onnx-worker', dims: 768 };

/** The smallest structurally complete report for `raw`; each knob breaks one bar. */
function report(input: RobustnessInput, knobs: { longMs?: number; soakLateMs?: number; rssLateMiB?: number; healthRttMs?: number; drop?: boolean } = {}): RobustnessReport {
  const samples: RobustnessSample[] = [];
  let t = 0;
  const add = (phase: RobustnessSample['phase'], role: RobustnessSample['role'], over: Partial<RobustnessSample> = {}) => {
    const latencyMs = over.latencyMs ?? 10, startedAtMs = over.startedAtMs ?? t;
    samples.push({ phase, role, sequence: samples.length, kind: 'query', requestId: 'q0', bypassCache: true, timeoutMs: 5000,
      startedAtMs, settledAtMs: startedAtMs + latencyMs, latencyMs, outcome: 'ok', cache: { hits: 0, coalesced: 0, inferred: 1 },
      modelRev: expected.modelRev, runtime: expected.runtime, dims: expected.dims,
      ...(role === 'reference' ? {} : { cosine: 1, maxAbs: 0 }), vectorSha256: 'a'.repeat(64), ...over });
    t = startedAtMs + latencyMs;
  };
  for (let i = 0; i < 6; i++) add('reference', 'reference', i === 4 ? { latencyMs: knobs.longMs ?? 400 } : {});
  add('concurrency', 'load'); add('concurrency', 'load');
  add('saturation', 'load'); add('saturation', 'load'); add('saturation', 'probe');
  add('coalescing', 'load'); add('coalescing', 'load', { cache: { hits: 0, coalesced: 1, inferred: 0 } });
  add('bypass', 'load'); add('bypass', 'load');
  add('timeout', 'load', { outcome: 'timeout', latencyMs: 105 }); add('timeout', 'probe');
  add('cancellation', 'load', { outcome: 'aborted' }); add('cancellation', 'probe');
  const crashAtMs = t + 5;
  add('crash', 'load', { cycle: 0, outcome: 'http-error', status: 500, startedAtMs: t, latencyMs: 20 });
  add('crash', 'probe', { cycle: 0 });
  const soakStart = t;
  for (let i = 0; i < 20; i++) add('soak', 'load', { startedAtMs: soakStart + i * 50, latencyMs: i >= 15 ? knobs.soakLateMs ?? 10 : 10 });
  const soakEnd = soakStart + 1000;
  const health = Array.from({ length: 21 }, (_, i) => ({ phase: 'soak' as const, atMs: soakStart + i * 50, rttMs: knobs.healthRttMs ?? 5,
    ok: true, status: 200, queue: { depth: 0, active: 0 }, rssBytes: (i >= 16 ? 100 + (knobs.rssLateMiB ?? 0) : 100) * 1024 * 1024 }));
  if (knobs.drop) {
    // A report that lost one fixed-count request but was renumbered to look contiguous.
    samples.splice(samples.findIndex((s) => s.phase === 'bypass'), 1);
    samples.forEach((s, i) => { s.sequence = i; });
  }
  const drained = { drained: true, afterMs: 1 };
  return { formatVersion: 1, pid: 1, expected, inputSha256: hashJson(input), startedAt: 'x', finishedAt: 'y', samples, health,
    eventLoop: Object.fromEntries(ROBUSTNESS_PHASES.map((p) => [p, { p50Ms: 1, p99Ms: 2, maxMs: 3 }])),
    phases: { saturation: { burstWallMs: 20, drain: drained }, timeout: { referenceLongLatencyMs: knobs.longMs ?? 400, recovery: drained },
      cancellation: { atAbort: { depth: 0, active: 1 }, abortedAtMs: 1, releaseMs: 3, drain: drained,
        workerAfter: { alive: true, disabled: false, pendingCount: 0 } },
      crash: [{ cycle: 0, crashAtMs, startedBeforeCrash: { active: 1, pending: 1 }, workerAfterCrash: { alive: false, disabled: false, pendingCount: 0 },
        recoveryProbeSequence: samples.findIndex((s) => s.phase === 'crash' && s.role === 'probe'),
        workerAfterRecovery: { alive: true, disabled: false, pendingCount: 0 } }],
      soak: { startedAtMs: soakStart, endedAtMs: soakEnd } } };
}

describe('robustness input contract', () => {
  it('accepts the declared shape and refuses ambiguous or vacuous designs before any request', () => {
    expect(parseRobustnessInput(raw).serverConcurrency).toBe(1);
    expect(() => parseRobustnessInput({ ...raw, requests: { ...raw.requests, long: { id: 'q0', text: 'x' } } })).toThrow(/duplicate robustness request id/);
    expect(() => parseRobustnessInput({ ...raw, timeout: { ...raw.timeout, clientDeadlineMs: 5000 } })).toThrow(/timeout phase deadline/);
    expect(() => parseRobustnessInput({ ...raw, cancellation: { ...raw.cancellation, abortAfterMs: 6000 } })).toThrow(/cancellation must abort/);
    expect(() => parseRobustnessInput({ ...raw, extra: true })).toThrow();
  });
});

describe('robustness verdict re-derived from raw samples', () => {
  const input = parseRobustnessInput(raw);
  it('passes a complete in-bound report', () => {
    const summary = summarizeRobustnessReport(input, expected, report(input));
    expect(summary.failures).toEqual([]);
    expect(summary.verdict).toBe('pass');
    expect(summary.crash).toEqual([{ cycle: 0, startedBeforeCrash: { active: 1, pending: 1 }, interrupted: 1, recoveredMs: expect.any(Number) }]);
  });
  it.each([
    ['a timeout phase whose long request beats the deadline', { longMs: 50 }, /timeout phase is vacuous/],
    ['late-soak latency growth', { soakLateMs: 40 }, /soak late\/early p95 ratio/],
    ['late-soak RSS growth', { rssLateMiB: 64 }, /soak RSS grew/],
    ['an unresponsive /healthz', { healthRttMs: 500 }, /\/healthz p99/],
  ] as const)('fails on %s', (_name, knobs, failure) => {
    const summary = summarizeRobustnessReport(input, expected, report(input, knobs));
    expect(summary.verdict).toBe('fail');
    expect(summary.failures.some((f) => failure.test(f))).toBe(true);
  });
  it('throws on a structurally incomplete population instead of grading it', () => {
    expect(() => summarizeRobustnessReport(input, expected, report(input, { drop: true }))).toThrow(/bypass\/load has 1 samples, expected 2/);
  });
});
