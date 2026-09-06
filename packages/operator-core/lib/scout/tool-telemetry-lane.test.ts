import { describe, it, expect } from 'vitest';
import {
  buildToolTelemetryPatterns,
  type ToolTelemetryInput,
} from './tool-telemetry-lane';

/**
 * blender-self-learning-2026-07-12 P-009 / WI-4454: the tool-telemetry lane feeds
 * MEASURED tool DX friction (per-tool error rates, arg-limit rejections, retry /
 * batching-waste loops, chronic p95 latency) from tool_invocations into the corpus
 * digest, so ideation targets the tools objectively costing the fleet instead of
 * only the ones an agent bothered to self-report. These pin the PURE builder; the
 * PG edge (telemetryRollup + readLimitFailureRate reuse) is fail-soft and exercised
 * by the cycle integration tests.
 */

function base(over: Partial<ToolTelemetryInput> = {}): ToolTelemetryInput {
  return { tools: [], limitFailures: [], ...over };
}

describe('buildToolTelemetryPatterns — the measured-DX lane (WI-4454)', () => {
  it('emits NOTHING when every tool is healthy (all clear)', () => {
    expect(
      buildToolTelemetryPatterns(
        base({ tools: [{ tool: 'coord:orient', calls: 500, errors: 1, refusals: 0, p95Ms: 300, repeatWithinSpawn: 0 }] }),
      ),
    ).toEqual([]);
  });

  it('surfaces a high error-rate tool, but only above the volume floor (a fluke on tiny N is not a pattern)', () => {
    const out = buildToolTelemetryPatterns(
      base({ tools: [{ tool: 'flaky:tool', calls: 100, errors: 40, refusals: 0, p95Ms: 200, repeatWithinSpawn: 0 }] }),
    );
    const err = out.find((p) => p.ref === 'tool:error-rate:flaky-tool');
    expect(err).toBeTruthy();
    expect(err!.category).toBe('tool-telemetry');
    expect(err!.summary).toContain('40%');
    expect(err!.weight).toBeGreaterThan(0.6);

    // 1/1 = 100% rate but below the volume floor ⇒ silent
    const fluke = buildToolTelemetryPatterns(
      base({ tools: [{ tool: 'rare:tool', calls: 1, errors: 1, refusals: 0, p95Ms: 10, repeatWithinSpawn: 0 }] }),
    );
    expect(fluke.some((p) => p.ref.startsWith('tool:error-rate:'))).toBe(false);
  });

  it('keeps deliberate refusals out of the error rate while carrying them as context', () => {
    const refusalOnly = buildToolTelemetryPatterns(
      base({ tools: [{ tool: 'guarded:tool', calls: 100, errors: 0, refusals: 80, p95Ms: 10, repeatWithinSpawn: 0 }] }),
    );
    expect(refusalOnly.some((p) => p.ref === 'tool:error-rate:guarded-tool')).toBe(false);

    const mixed = buildToolTelemetryPatterns(
      base({ tools: [{ tool: 'mixed:tool', calls: 100, errors: 30, refusals: 50, p95Ms: 10, repeatWithinSpawn: 0 }] }),
    );
    const error = mixed.find((p) => p.ref === 'tool:error-rate:mixed-tool');
    expect(error).toBeTruthy();
    expect(error!.summary).toContain('30% of calls (30/100 in window)');
    expect(error!.summary).toContain('a further 50 call(s) were refused by guards');
    expect(error!.detail).toContain('30 genuine error(s)');
    expect(error!.detail).toContain('50 deliberate refusal(s) are excluded');
  });

  it('ranks failing tools by absolute failed-call impact (rate × volume), not rate alone', () => {
    const out = buildToolTelemetryPatterns(
      base({
        tools: [
          { tool: 'high:rate-low-vol', calls: 25, errors: 25, refusals: 0, p95Ms: 10, repeatWithinSpawn: 0 }, // 100% × 25 = 25
          { tool: 'mid:rate-high-vol', calls: 1000, errors: 300, refusals: 0, p95Ms: 10, repeatWithinSpawn: 0 }, // 30% × 1000 = 300
        ],
      }),
    );
    const errRefs = out.filter((p) => p.ref.startsWith('tool:error-rate:')).map((p) => p.ref);
    expect(errRefs[0]).toBe('tool:error-rate:mid-rate-high-vol'); // 300 failed calls > 25
  });

  it('surfaces per-tool arg-limit rejections above the floor, most-frequent first', () => {
    const out = buildToolTelemetryPatterns(
      base({
        limitFailures: [
          { tool: 'work_items:complete', errs: 120 },
          { tool: 'coord:send', errs: 3 }, // below floor (10)
          { tool: 'plans:set-content', errs: 40 },
        ],
      }),
    );
    const refs = out.filter((p) => p.ref.startsWith('tool:limit-failure:')).map((p) => p.ref);
    // slug lowercases and maps every non-[a-z0-9] run to '-' (so ':' and '_' both become '-').
    expect(refs).toEqual(['tool:limit-failure:work-items-complete', 'tool:limit-failure:plans-set-content']);
    expect(refs).not.toContain('tool:limit-failure:coord-send');
  });

  it('surfaces retry / batching-waste loops (same-tool over-call within a spawn) above the floor', () => {
    const out = buildToolTelemetryPatterns(
      base({
        tools: [
          { tool: 'work_items:get', calls: 400, errors: 0, refusals: 0, p95Ms: 50, repeatWithinSpawn: 120 },
          { tool: 'calm:tool', calls: 400, errors: 0, refusals: 0, p95Ms: 50, repeatWithinSpawn: 3 }, // below floor (25)
        ],
      }),
    );
    const retry = out.find((p) => p.ref === 'tool:retry-loop:work-items-get');
    expect(retry).toBeTruthy();
    expect(retry!.detail).toContain('code:run');
    expect(out.some((p) => p.ref === 'tool:retry-loop:calm-tool')).toBe(false);
  });

  it('surfaces a chronically slow tool by p95 (volume-gated), and tolerates a null p95', () => {
    const out = buildToolTelemetryPatterns(
      base({
        tools: [
          { tool: 'slow:tool', calls: 60, errors: 0, refusals: 0, p95Ms: 45_000, repeatWithinSpawn: 0 },
          { tool: 'unmeasured:tool', calls: 60, errors: 0, refusals: 0, p95Ms: null, repeatWithinSpawn: 0 },
        ],
      }),
    );
    expect(out.some((p) => p.ref === 'tool:p95:slow-tool')).toBe(true);
    expect(out.find((p) => p.ref === 'tool:p95:slow-tool')!.summary).toContain('45.0s');
    // a null-p95 tool never surfaces and never throws
    expect(out.some((p) => p.ref === 'tool:p95:unmeasured-tool')).toBe(false);
  });

  it('orders acute (error-rate → limit-failure → retry-loop) before chronic p95 latency', () => {
    const out = buildToolTelemetryPatterns(
      base({
        tools: [
          { tool: 't:err', calls: 100, errors: 50, refusals: 0, p95Ms: 10, repeatWithinSpawn: 0 },
          { tool: 't:retry', calls: 100, errors: 0, refusals: 0, p95Ms: 10, repeatWithinSpawn: 80 },
          { tool: 't:slow', calls: 100, errors: 0, refusals: 0, p95Ms: 40_000, repeatWithinSpawn: 0 },
        ],
        limitFailures: [{ tool: 't:limit', errs: 50 }],
      }),
    );
    const refs = out.map((p) => p.ref);
    expect(refs.indexOf('tool:error-rate:t-err')).toBeLessThan(refs.indexOf('tool:limit-failure:t-limit'));
    expect(refs.indexOf('tool:limit-failure:t-limit')).toBeLessThan(refs.indexOf('tool:retry-loop:t-retry'));
    expect(refs.indexOf('tool:retry-loop:t-retry')).toBeLessThan(refs.indexOf('tool:p95:t-slow'));
  });

  it('slugifies an mcp__-prefixed tool name into a bounded, stable ref suffix', () => {
    const out = buildToolTelemetryPatterns(
      base({ tools: [{ tool: 'mcp__papercusp-su__work_items_complete', calls: 200, errors: 60, refusals: 0, p95Ms: 10, repeatWithinSpawn: 0 }] }),
    );
    const ref = out.find((p) => p.ref.startsWith('tool:error-rate:'))!.ref;
    const suffix = ref.slice('tool:error-rate:'.length);
    expect(suffix.length).toBeLessThanOrEqual(48);
    expect(suffix).toMatch(/^[a-z0-9-]+$/);
    // the full tool name still rides the human-facing summary
    expect(out[0].summary).toContain('mcp__papercusp-su__work_items_complete');
  });

  it('respects the pattern cap', () => {
    const out = buildToolTelemetryPatterns(
      base({
        tools: Array.from({ length: 20 }, (_, i) => ({
          tool: `t${i}`,
          calls: 100,
          errors: 50,
          refusals: 0,
          p95Ms: 10,
          repeatWithinSpawn: 0,
        })),
      }),
      { limit: 4 },
    );
    expect(out.length).toBe(4);
  });
});
