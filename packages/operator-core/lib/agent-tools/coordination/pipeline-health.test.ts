/**
 * pipeline-health.test.ts — WI-4533.
 *
 * This block rides `coord:orient`, the read EVERY agent makes at EVERY wake. Three properties are
 * therefore worth more than the happy path, and each has a live incident behind it:
 *
 *   1. it must be SILENT rather than wrong — an unknown gate folds NOTHING, never a green
 *      (a false all-clear at wake is an agent shipping into a pipeline it believes is healthy);
 *   2. it must never name the tests behind a STALE red (WI-4489's phantom dispatch);
 *   3. it must never break, slow, or fail an orient — any error is an absent block, full stop.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearOrientPipelineCache,
  fetchOrientPipeline,
  toOrientPipeline,
  PIPELINE_BEHIND_NOTE,
  PIPELINE_RED_NOTE,
  PIPELINE_STALE_NOTE,
  PIPELINE_REFIRE_IN_FLIGHT_NOTE,
  PIPELINE_RUN_IN_FLIGHT_NOTE,
} from './pipeline-health';
import type { PipelineHealth } from '../../why-chain';

const NOW = 1_700_000_000_000;

const health = (over: Partial<PipelineHealth> = {}): PipelineHealth => ({
  generatedAtMs: NOW,
  known: true,
  gate: { stage: 'gate', status: 'ok', reason: 'green-checkpoint gate is green' },
  deploy: { stage: 'deploy', status: 'ok', reason: 'fully caught up' },
  gateLabel: 'green',
  consecutiveReds: 0,
  lastGreenAtMs: NOW - 60_000,
  verdictStale: false,
  greenPinBehindStaging: 0,
  deployedBehindGreenPin: 0,
  recentFailingFiles: [],
  diagnosticVintage: {
    processSha: null,
    stagingHeadSha: null,
    greenPinSha: null,
    status: 'unknown',
    processMatchesStaging: null,
    processMatchesGreenPin: null,
    warning: 'Diagnostic build freshness is UNKNOWN',
  },
  rootCause: null,
  ...over,
});

describe('toOrientPipeline — what a waking agent is told', () => {
  it('a healthy pipeline is TWO fields — being told "all clear" must be nearly free', () => {
    const out = toOrientPipeline(health(), NOW)!;
    expect(out.gate).toBe('green');
    expect(out.deploy).toBe('current');
    // No advisory, no root cause, no file list on a healthy read: this rides the hottest tool in
    // the fleet, and a paragraph of reassurance every wake is a tax on 425 agents.
    expect(out.note).toBeUndefined();
    expect(out.rootCause).toBeUndefined();
    expect(out.failingFiles).toBeUndefined();
  });

  it('surfaces stale diagnostic vintage even when the pipeline itself is green', () => {
    const out = toOrientPipeline(
      health({
        diagnosticVintage: {
          processSha: '1111111aaaaaaa',
          stagingHeadSha: '2222222bbbbbbb',
          greenPinSha: '2222222bbbbbbb',
          status: 'stale',
          processMatchesStaging: false,
          processMatchesGreenPin: false,
          warning: 'guidance may predate current fixes',
        },
      }),
      NOW,
    )!;
    expect(out.diagnosticVintage?.status).toBe('stale');
    expect(out.diagnosticVintage?.warning).toContain('predate current fixes');
  });

  it('an UNKNOWN gate folds NOTHING — silence, never a false green', () => {
    // The harness has no green-checkpoint routine. Its gate_health defaults to zero reds, which
    // would otherwise render as a confident "green" to every agent working in it.
    expect(toOrientPipeline(health({ known: false }), NOW)).toBeNull();
  });

  it('a RED gate carries the failing files, the root cause, and what it means for MY work', () => {
    const out = toOrientPipeline(
      health({
        gateLabel: 'red',
        consecutiveReds: 2,
        lastGreenAtMs: NOW - 3 * 3600_000,
        recentFailingFiles: ['lib/a.test.ts', 'lib/b.test.ts'],
        gate: { stage: 'gate', status: 'degraded', reason: 'gate red (2 consecutive, not yet stalled)' },
        rootCause: { stage: 'gate', status: 'degraded', reason: 'gate red (2 consecutive, not yet stalled)' },
      }),
      NOW,
    )!;
    expect(out.gate).toBe('red');
    expect(out.consecutiveReds).toBe(2);
    expect(out.lastGreenAgoMs).toBe(3 * 3600_000);
    expect(out.failingFiles).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
    expect(out.rootCause).toContain('gate — gate red (2 consecutive');
    expect(out.note).toBe(PIPELINE_RED_NOTE);
  });

  it('a STALE-VERDICT gate names NO tests — the whole point of the label (WI-4489)', () => {
    const out = toOrientPipeline(
      health({
        gateLabel: 'stale-verdict',
        consecutiveReds: 4,
        verdictStale: true,
        // The files genuinely failed inside the lookback window — and STILL must not be handed to
        // a waking agent as "go fix these": the verdict naming them is superseded. Dispatching
        // against them is precisely the self-sustaining phantom WI-4489 documented.
        recentFailingFiles: ['lib/innocent.test.ts'],
        gate: { stage: 'gate', status: 'degraded', reason: "gate verdict is STALE (…) — the gate's colour is UNKNOWN" },
        rootCause: { stage: 'gate', status: 'degraded', reason: "gate verdict is STALE (…) — the gate's colour is UNKNOWN" },
      }),
      NOW,
    )!;
    expect(out.gate).toBe('stale-verdict');
    expect(out.failingFiles).toBeUndefined();
    expect(out.note).toBe(PIPELINE_STALE_NOTE);
    expect(JSON.stringify(out)).not.toContain('innocent.test.ts');
  });

  it('⭐ EI-18669342433807110: a REFIRE-IN-FLIGHT stale reason gets its OWN note — "re-run the checkpoint" is wrong when one is already running', () => {
    const out = toOrientPipeline(
      health({
        gateLabel: 'stale-verdict',
        consecutiveReds: 1,
        verdictStale: true,
        verdictStaleReasonCode: 'refire-in-flight',
        recentFailingFiles: ['lib/innocent.test.ts'],
        gate: { stage: 'gate', status: 'degraded', reason: 'gate verdict is STALE (a refire is IN FLIGHT) — UNKNOWN' },
        rootCause: { stage: 'gate', status: 'degraded', reason: 'gate verdict is STALE (a refire is IN FLIGHT) — UNKNOWN' },
      }),
      NOW,
    )!;
    expect(out.gate).toBe('stale-verdict');
    expect(out.failingFiles).toBeUndefined(); // still names nobody, same as any stale-verdict
    expect(out.note).toBe(PIPELINE_REFIRE_IN_FLIGHT_NOTE);
    expect(out.note).not.toBe(PIPELINE_STALE_NOTE);
  });

  it('⭐ a RUN-IN-FLIGHT stale reason gets a pending-verdict note and still names NO tests', () => {
    const out = toOrientPipeline(
      health({
        gateLabel: 'stale-verdict',
        consecutiveReds: 1,
        verdictStale: true,
        verdictStaleReasonCode: 'run-in-flight',
        recentFailingFiles: ['lib/innocent.test.ts'],
        gate: { stage: 'gate', status: 'degraded', reason: 'gate verdict is STALE (a run is IN FLIGHT) — UNKNOWN' },
        rootCause: { stage: 'gate', status: 'degraded', reason: 'gate verdict is STALE (a run is IN FLIGHT) — UNKNOWN' },
      }),
      NOW,
    )!;
    expect(out.gate).toBe('stale-verdict');
    expect(out.failingFiles).toBeUndefined();
    expect(out.note).toBe(PIPELINE_RUN_IN_FLIGHT_NOTE);
    expect(out.note).toContain('wait for this active run to finish');
    expect(out.note).not.toBe(PIPELINE_STALE_NOTE);
  });

  it('a stale-verdict WITHOUT the refire-in-flight reasonCode still gets the generic note (the other 3 rules)', () => {
    const out = toOrientPipeline(
      health({
        gateLabel: 'stale-verdict',
        consecutiveReds: 4,
        verdictStale: true,
        verdictStaleReasonCode: 'writer-starved',
        gate: { stage: 'gate', status: 'degraded', reason: "gate verdict is STALE (…) — the gate's colour is UNKNOWN" },
        rootCause: { stage: 'gate', status: 'degraded', reason: "gate verdict is STALE (…) — the gate's colour is UNKNOWN" },
      }),
      NOW,
    )!;
    expect(out.note).toBe(PIPELINE_STALE_NOTE);
  });

  it('a GREEN gate with an unpromoted tip is still "not shipped" — and says so without crying red', () => {
    const out = toOrientPipeline(
      health({
        greenPinBehindStaging: 49,
        deploy: { stage: 'deploy', status: 'degraded', reason: 'main is 49 commit(s) ahead of the green pin' },
        rootCause: { stage: 'deploy', status: 'degraded', reason: 'main is 49 commit(s) ahead of the green pin' },
      }),
      NOW,
    )!;
    expect(out.gate).toBe('green'); // the gate is genuinely fine…
    expect(out.deploy).toBe('behind'); // …but the change is not live
    expect(out.note).toBe(PIPELINE_BEHIND_NOTE);
    expect(out.rootCause).toContain('deploy —');
  });

  it('caps the failing-file list (a 200-red gate must not blow up every agent\'s wake)', () => {
    const out = toOrientPipeline(
      health({
        gateLabel: 'red',
        consecutiveReds: 9,
        recentFailingFiles: Array.from({ length: 20 }, (_, i) => `lib/f${i}.test.ts`),
      }),
      NOW,
    )!;
    expect(out.failingFiles).toHaveLength(5);
  });
});

describe('fetchOrientPipeline — the cache + the fail-soft contract', () => {
  beforeEach(() => clearOrientPipelineCache());

  it('serves a burst of waking agents from ONE snapshot (single-flight + TTL)', async () => {
    let computed = 0;
    const compute = async () => {
      computed++;
      return health();
    };
    // 10 agents wake at once, then one more orients a moment later.
    await Promise.all(Array.from({ length: 10 }, () => fetchOrientPipeline('papercusp', { compute })));
    await fetchOrientPipeline('papercusp', { compute });
    expect(computed).toBe(1);
  });

  it('keys the cache per HARNESS — one hive\'s gate is not another\'s', async () => {
    const compute = async (slug?: string) =>
      health({ gateLabel: slug === 'red-hive' ? 'red' : 'green', consecutiveReds: slug === 'red-hive' ? 1 : 0 });
    const a = await fetchOrientPipeline('green-hive', { compute });
    const b = await fetchOrientPipeline('red-hive', { compute });
    expect(a?.gate).toBe('green');
    expect(b?.gate).toBe('red');
  });

  it('a THROWING pipeline read resolves to null — it never breaks the orient it decorates', async () => {
    const out = await fetchOrientPipeline('papercusp', {
      compute: async () => {
        throw new Error('pg is down');
      },
    });
    expect(out).toBeNull(); // absent block, healthy orientation.
  });

  it('does not cache-poison a later good read with a failed one', async () => {
    const bad = await fetchOrientPipeline('papercusp', {
      compute: async () => {
        throw new Error('transient');
      },
    });
    expect(bad).toBeNull();
    clearOrientPipelineCache();
    const good = await fetchOrientPipeline('papercusp', { compute: async () => health() });
    expect(good?.gate).toBe('green');
  });
});
