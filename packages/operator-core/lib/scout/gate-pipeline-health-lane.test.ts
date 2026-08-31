import { describe, it, expect } from 'vitest';
import {
  buildGatePipelineHealthPatterns,
  PIPELINE_FAILURE_STATUSES,
  type GatePipelineHealthInput,
} from './gate-pipeline-health-lane';

/**
 * blender-self-learning-2026-07-12 P-010 / WI-4455: the gate/pipeline-health lane feeds the
 * release ship-path's chronic pain into the corpus digest, JOINING signals that live in three
 * disjoint places today (standing gate verdict, git position, pipeline_events) into one incident.
 * These pin the PURE builder; the PG edge (computePipelineHealth reuse + pipeline_events read) is
 * fail-soft and exercised by the cycle integration tests.
 */

/** A green, caught-up baseline; each test overrides only the fields it exercises. */
function base(over: Partial<GatePipelineHealthInput> = {}): GatePipelineHealthInput {
  return {
    known: true,
    gateLabel: 'green',
    verdictStale: false,
    consecutiveReds: 0,
    gateStallMs: null,
    mainBehindStaging: 0,
    deployBehind: 0,
    recentFailingFiles: [],
    eventFailures: [],
    ...over,
  };
}

describe('buildGatePipelineHealthPatterns — the release ship-path lane (WI-4455)', () => {
  it('emits NOTHING when the harness has no gate (known:false) — a detector with no evidence is silent', () => {
    // Even with red-looking fields, an unknown gate must say nothing (mirrors pipeline-health.ts).
    expect(
      buildGatePipelineHealthPatterns(
        base({ known: false, gateLabel: 'red', consecutiveReds: 9, mainBehindStaging: 200 }),
      ),
    ).toEqual([]);
  });

  it('emits NOTHING for a green, caught-up pipeline (all clear)', () => {
    expect(buildGatePipelineHealthPatterns(base())).toEqual([]);
  });

  it('joins consecutive reds + stall + failing files into ONE gate incident with both triage hints', () => {
    const out = buildGatePipelineHealthPatterns(
      base({
        gateLabel: 'red',
        consecutiveReds: 3,
        gateStallMs: 2 * 3_600_000, // 2h
        recentFailingFiles: ['a.test.ts', 'b.test.ts'],
      }),
    );
    const gate = out.find((p) => p.ref === 'pipeline:gate');
    expect(gate).toBeTruthy();
    expect(gate!.category).toBe('gate-pipeline-health');
    expect(gate!.summary).toContain('3 consecutive red');
    expect(gate!.summary).toContain('2h');
    expect(gate!.detail).toContain('a.test.ts');
    // (c) env-debris triage hint + (d) 240s quiet-cut trap ride in the detail.
    expect(gate!.detail).toContain('env-debris');
    expect(gate!.detail).toContain('240s');
    expect(gate!.weight).toBe(1);
  });

  it('surfaces the gate on a LONG stall even at a single red (stall path), but treats a short single red as a blip', () => {
    const stalled = buildGatePipelineHealthPatterns(
      base({ gateLabel: 'red', consecutiveReds: 1, gateStallMs: 90 * 60_000 }), // 1h30m ≥ 1h
    );
    expect(stalled.some((p) => p.ref === 'pipeline:gate')).toBe(true);

    const blip = buildGatePipelineHealthPatterns(
      base({ gateLabel: 'red', consecutiveReds: 1, gateStallMs: 5 * 60_000 }), // 1 red, 5m
    );
    expect(blip.some((p) => p.ref === 'pipeline:gate')).toBe(false);
  });

  it('NEVER surfaces a stale verdict as a red gate (WI-4489 — its colour is UNKNOWN)', () => {
    const out = buildGatePipelineHealthPatterns(
      base({
        gateLabel: 'stale-verdict',
        verdictStale: true,
        consecutiveReds: 9,
        gateStallMs: 5 * 3_600_000,
        recentFailingFiles: ['do-not-dispatch.test.ts'],
      }),
    );
    expect(out.some((p) => p.ref === 'pipeline:gate')).toBe(false);
    // and it must not leak the failing-file names it would phantom-dispatch against
    expect(JSON.stringify(out)).not.toContain('do-not-dispatch');
  });

  it('never surfaces an inconclusive checkpoint as a code red, but preserves other pipeline evidence', () => {
    const out = buildGatePipelineHealthPatterns(
      base({
        gateLabel: 'inconclusive',
        consecutiveReds: 9,
        gateStallMs: 5 * 3_600_000,
        mainBehindStaging: 50,
        recentFailingFiles: ['historical-do-not-dispatch.test.ts'],
        eventFailures: [{ kind: 'deploy', status: 'failed', count: 4 }],
      }),
    );
    expect(out.some((p) => p.ref === 'pipeline:gate')).toBe(false);
    expect(JSON.stringify(out)).not.toContain('historical-do-not-dispatch');
    expect(out.find((p) => p.ref === 'pipeline:promotion-stall')?.detail).toContain(
      'rendered no code verdict',
    );
    expect(out.some((p) => p.ref === 'pipeline:event:deploy:failed')).toBe(true);
  });

  it('surfaces a promotion stall, and joins it to a standing red gate (the incident no consumer joins today)', () => {
    const joined = buildGatePipelineHealthPatterns(
      base({ gateLabel: 'red', consecutiveReds: 4, gateStallMs: 3_600_000, mainBehindStaging: 102 }),
    );
    const promo = joined.find((p) => p.ref === 'pipeline:promotion-stall');
    expect(promo).toBeTruthy();
    expect(promo!.summary).toContain('102 commits');
    expect(promo!.detail).toContain('same incident'); // explicitly joined to the red gate

    // behind but GREEN ⇒ a different message (routine wedged/paused, not blocked on a red)
    const greenBehind = buildGatePipelineHealthPatterns(base({ mainBehindStaging: 50 }));
    const p2 = greenBehind.find((p) => p.ref === 'pipeline:promotion-stall');
    expect(p2!.detail).toContain('despite a green gate');

    // below threshold ⇒ no promotion pattern
    expect(
      buildGatePipelineHealthPatterns(base({ mainBehindStaging: 3 })).some(
        (p) => p.ref === 'pipeline:promotion-stall',
      ),
    ).toBe(false);
  });

  it('surfaces a deploy lag when the green pin is not yet live', () => {
    const out = buildGatePipelineHealthPatterns(base({ deployBehind: 40 }));
    expect(out.some((p) => p.ref === 'pipeline:deploy-lag')).toBe(true);
    expect(buildGatePipelineHealthPatterns(base({ deployBehind: 2 })).length).toBe(0);
  });

  it('surfaces chronic pipeline_events failure classes above the floor, most-frequent first', () => {
    const out = buildGatePipelineHealthPatterns(
      base({
        eventFailures: [
          { kind: 'deploy', status: 'rolled-back', count: 2 }, // below floor (3)
          { kind: 'green_checkpoint', status: 'not-green', count: 12 },
          { kind: 'content_fixer', status: 'failed', count: 4 },
        ],
      }),
    );
    const evRefs = out.filter((p) => p.ref.startsWith('pipeline:event:')).map((p) => p.ref);
    expect(evRefs).toEqual([
      'pipeline:event:green_checkpoint:not-green',
      'pipeline:event:content_fixer:failed',
    ]);
    // the below-floor deploy rollback is excluded
    expect(evRefs).not.toContain('pipeline:event:deploy:rolled-back');
  });

  it('orders acute (gate → promotion → deploy) before chronic event classes', () => {
    const out = buildGatePipelineHealthPatterns(
      base({
        gateLabel: 'red',
        consecutiveReds: 4,
        gateStallMs: 7 * 3_600_000,
        mainBehindStaging: 102,
        deployBehind: 60,
        eventFailures: [{ kind: 'green_checkpoint', status: 'not-green', count: 12 }],
      }),
    );
    const refs = out.map((p) => p.ref);
    expect(refs.indexOf('pipeline:gate')).toBeLessThan(refs.indexOf('pipeline:promotion-stall'));
    expect(refs.indexOf('pipeline:promotion-stall')).toBeLessThan(refs.indexOf('pipeline:deploy-lag'));
    expect(refs.indexOf('pipeline:deploy-lag')).toBeLessThan(
      refs.indexOf('pipeline:event:green_checkpoint:not-green'),
    );
  });

  it('reproduces the 2026-07-12 live incident (4 reds, main 102 behind, ~7h) as ONE joined incident', () => {
    // WI-4455 fixture: the gate sat at 4 consecutive reds with main ~102 behind staging for ~7h.
    const out = buildGatePipelineHealthPatterns(
      base({
        gateLabel: 'red',
        consecutiveReds: 4,
        gateStallMs: 7 * 3_600_000,
        mainBehindStaging: 102,
        recentFailingFiles: ['no-pnpm-hijack.test.ts'],
      }),
    );
    expect(out.find((p) => p.ref === 'pipeline:gate')).toBeTruthy();
    expect(out.find((p) => p.ref === 'pipeline:promotion-stall')).toBeTruthy();
    // the env-debris triage hint is exactly the insight that would have saved the ~7h
    expect(out.find((p) => p.ref === 'pipeline:gate')!.detail).toContain('env-debris');
  });

  it('respects the pattern cap', () => {
    const out = buildGatePipelineHealthPatterns(
      base({
        gateLabel: 'red',
        consecutiveReds: 4,
        gateStallMs: 3_600_000,
        mainBehindStaging: 100,
        deployBehind: 100,
        eventFailures: Array.from({ length: 20 }, (_, i) => ({
          kind: `k${i}`,
          status: 'failed',
          count: 5 + i,
        })),
      }),
      { limit: 5 },
    );
    expect(out.length).toBe(5);
  });

  it('pins the failure-status set (only real failures, never benign skips)', () => {
    expect([...PIPELINE_FAILURE_STATUSES]).toEqual([
      'not-green',
      'rolled-back',
      'failed',
      'error',
      'wedged',
      'conflict',
      'crash',
    ]);
    // the benign skip statuses that dominate the log must NOT be in the failure set
    for (const benign of ['synced', 'nothing', 'up-to-date', 'advanced', 'skipped-locked', 'skipped-disabled', 'ok']) {
      expect(PIPELINE_FAILURE_STATUSES as readonly string[]).not.toContain(benign);
    }
  });
});
