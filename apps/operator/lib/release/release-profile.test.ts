/**
 * release-profile.test.ts — the papercusp wiring over the generic composite evaluator
 * (rubric-system-and-auto-loop-release-profile-2026-07-15 P-006). Every dependency is
 * INJECTED (deps.* — matches this package's existing gate-test convention, e.g.
 * perf-gate.test.ts's PerfGateIO), so these run hermetically with no PG / git / DB.
 *
 * Terminal proof required by the plan item: the composite REFUSES GO on a real
 * fail / stale / lineage-mismatch case, wired through the actual adapter (not just the
 * generic lib's fabricated-component tests in libs/generic/release-profile).
 */
import { describe, it, expect } from 'vitest';
import {
  buildPapercuspReleaseProfile,
  classifyRatingForGate,
  deployStalenessGateComponent,
  evaluatePapercuspReleaseProfile,
  rubricReleaseComponent,
  worstCaseVerdict,
  DEFAULT_RUBRIC_STALE_AFTER_MS,
} from './release-profile';
import { evaluateReleaseProfile } from '@papercusp/release-profile';
import type { Rubric } from '@papercusp/operator-core/lib/rubrics';
import type { ScorecardRow } from '@papercusp/operator-core/lib/scorecards';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');

function rubric(overrides: Partial<Rubric> = {}): Rubric {
  return {
    rubricId: 'test-rubric',
    workspaceId: 'ws',
    characteristic: 'test',
    title: 'Test rubric',
    description: '',
    criteria: [
      { key: 'c1', title: 'C1', model: 'm', method: 'me', driftMarkers: 'd' },
      { key: 'c2', title: 'C2', model: 'm', method: 'me', driftMarkers: 'd' },
    ],
    ratingScale: ['pass', 'fail', 'unknown'],
    methodRef: null,
    releaseGating: true,
    status: 'active',
    createdBy: 'owner',
    proposedBy: 'owner',
    ratifiedBy: 'reviewer',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function scorecardRow(overrides: Partial<ScorecardRow> = {}): ScorecardRow {
  return {
    issueId: 'EI-1',
    createdAt: new Date(NOW).toISOString(),
    createdBy: 'agent-1',
    rubricRef: 'test-rubric',
    ratings: { c1: { rating: 'pass', evidence: 'e1' }, c2: { rating: 'pass', evidence: 'e2' } },
    nKeys: 2,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    score10: 10,
    linkedItems: [],
    ...overrides,
  };
}

describe('classifyRatingForGate / worstCaseVerdict — the pass-bar', () => {
  it('classifies common pass/fail/unknown vocabularies', () => {
    expect(classifyRatingForGate('pass')).toBe('pass');
    expect(classifyRatingForGate('HEALTHY')).toBe('pass');
    expect(classifyRatingForGate('unknown')).toBe('unknown');
    expect(classifyRatingForGate('fail')).toBe('fail');
    expect(classifyRatingForGate('broken')).toBe('fail');
  });
  it('treats partial/degraded as FAIL for gating — a gate does not average away a mid rating', () => {
    expect(classifyRatingForGate('partial')).toBe('fail');
    expect(classifyRatingForGate('degraded')).toBe('fail');
  });
  it('worstCaseVerdict picks the single worst criterion, not a majority vote', () => {
    const { verdict, worstKey, worstRating } = worstCaseVerdict({
      a: { rating: 'pass' },
      b: { rating: 'pass' },
      c: { rating: 'broken' },
    });
    expect(verdict).toBe('fail');
    expect(worstKey).toBe('c');
    expect(worstRating).toBe('broken');
  });
  it('all-pass ratings verdict pass', () => {
    expect(worstCaseVerdict({ a: { rating: 'pass' }, b: { rating: 'healthy' } }).verdict).toBe('pass');
  });
});

describe('rubricReleaseComponent — real adapter, injected deps', () => {
  it('unknown when the rubric does not resolve', async () => {
    const comp = rubricReleaseComponent('missing-rubric', { deps: { getRubric: async () => null } });
    const result = await comp.check();
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toMatch(/not found/);
  });

  it('unknown when the rubric is not ratified (proposed, not active)', async () => {
    const comp = rubricReleaseComponent('draft-rubric', {
      deps: { getRubric: async () => rubric({ status: 'proposed' }) },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toMatch(/not ratified/);
  });

  it('unknown when there is no scorecard on record', async () => {
    const comp = rubricReleaseComponent('test-rubric', {
      deps: { getRubric: async () => rubric(), listScorecards: async () => [] },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toMatch(/no scorecard/);
  });

  it('unknown when the latest scorecard is INCOMPLETE', async () => {
    const comp = rubricReleaseComponent('test-rubric', {
      deps: {
        getRubric: async () => rubric(),
        listScorecards: async () => [scorecardRow({ missingKeys: ['c2'] })],
      },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toMatch(/INCOMPLETE/);
  });

  it('pass when the latest complete scorecard rates every criterion pass', async () => {
    const comp = rubricReleaseComponent('test-rubric', {
      deps: { getRubric: async () => rubric(), listScorecards: async () => [scorecardRow()] },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('pass');
    expect(result.evidence[0]).toEqual({ ref: 'EI-1', kind: 'scorecard', detail: { sourceHive: null } });
  });

  it('fail when any criterion is rated broken/fail', async () => {
    const comp = rubricReleaseComponent('test-rubric', {
      deps: {
        getRubric: async () => rubric(),
        listScorecards: async () => [
          scorecardRow({ ratings: { c1: { rating: 'pass', evidence: 'e' }, c2: { rating: 'broken', evidence: 'e' } } }),
        ],
      },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('fail');
    expect(result.reason).toMatch(/c2' rated 'broken'/);
  });

  it('carries gradedGeneration through as lineage', async () => {
    const comp = rubricReleaseComponent('test-rubric', {
      deps: {
        getRubric: async () => rubric(),
        listScorecards: async () => [scorecardRow({ gradedGeneration: { sha: 'shaX', hostStartedAt: null } })],
      },
    });
    const result = await comp.check();
    expect(result.lineage).toEqual({ sha: 'shaX' });
  });
});

describe('deployStalenessGateComponent — real adapter, injected git-ops', () => {
  it('unknown when the deployed sha cannot be resolved', async () => {
    const comp = deployStalenessGateComponent({ deps: { deployedSha: async () => null } });
    const result = await comp.check();
    expect(result.verdict).toBe('unknown');
  });

  it('pass when the pin is fresh and close to tip', async () => {
    const comp = deployStalenessGateComponent({
      deps: {
        deployedSha: async () => 'deployed-sha',
        currentSha: async () => 'candidate-sha',
        commitUnixTime: async () => Math.floor(Date.now() / 1000) - 60, // 1 min old
        commitsBetween: async () => ['c1', 'c2'],
      },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('pass');
    expect(result.lineage).toEqual({ sha: 'deployed-sha' });
  });

  it('fails when the pin is stale (old + far behind tip)', async () => {
    const comp = deployStalenessGateComponent({
      deps: {
        deployedSha: async () => 'deployed-sha',
        currentSha: async () => 'candidate-sha',
        commitUnixTime: async () => Math.floor(Date.now() / 1000) - 20 * 3_600, // 20h old
        commitsBetween: async () => Array.from({ length: 50 }, (_, i) => `c${i}`),
      },
      thresholds: { maxPinAgeMs: 6 * 3_600_000, maxCommitsBehind: 20 },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('fail');
    expect(result.reason).toMatch(/deploy stale/);
  });
});

describe('buildPapercuspReleaseProfile / evaluatePapercuspReleaseProfile — end to end', () => {
  const healthyDeps = {
    listRubrics: async () => [rubric()],
    readRunningGeneration: async () => ({ sha: 'gen-sha-1', hostStartedAt: null }),
  };
  const healthyGateOpts = {
    deps: {
      deployedSha: async () => 'gen-sha-1',
      currentSha: async () => 'gen-sha-1',
      commitUnixTime: async () => Math.floor(Date.now() / 1000) - 60,
      commitsBetween: async () => [],
    },
  };

  it('GOes when the rubric passes and the deploy gate is fresh', async () => {
    const spec = await buildPapercuspReleaseProfile({
      deps: healthyDeps,
      gateOpts: healthyGateOpts,
      rubricOpts: { deps: { listScorecards: async () => [scorecardRow({ gradedGeneration: { sha: 'gen-sha-1', hostStartedAt: null } })] } },
    });
    const verdict = await evaluateReleaseProfile(spec, { now: NOW });
    expect(verdict.go).toBe(true);
    expect(verdict.components).toHaveLength(2); // 1 rubric + 1 gate
  });

  it('REFUSES GO on a real FAIL case — a mandatory rubric criterion rated broken', async () => {
    const verdict = await evaluatePapercuspReleaseProfile({
      deps: healthyDeps,
      gateOpts: healthyGateOpts,
      evaluateOpts: { now: NOW },
      rubricOpts: {
        deps: {
          listScorecards: async () => [
            scorecardRow({
              ratings: { c1: { rating: 'pass', evidence: 'e' }, c2: { rating: 'broken', evidence: 'e' } },
              gradedGeneration: { sha: 'gen-sha-1', hostStartedAt: null },
            }),
          ],
        },
      },
    });
    expect(verdict.go).toBe(false);
    expect(verdict.reason).toMatch(/rubric:test-rubric/);
    expect(verdict.components.find((c) => c.key === 'rubric:test-rubric')?.verdict).toBe('fail');
  });

  it('REFUSES GO on a real STALE case — the scorecard predates the freshness window', async () => {
    const staleMeasuredAt = new Date(NOW - 7 * 60 * 60_000).toISOString(); // 7h old vs 6h default window
    const verdict = await evaluateReleaseProfile(
      await buildPapercuspReleaseProfile({
        deps: healthyDeps,
        gateOpts: healthyGateOpts,
        rubricOpts: {
          maxAgeMs: DEFAULT_RUBRIC_STALE_AFTER_MS,
          deps: {
            listScorecards: async () => [
              scorecardRow({ createdAt: staleMeasuredAt, gradedGeneration: { sha: 'gen-sha-1', hostStartedAt: null } }),
            ],
          },
        },
      }),
      { now: NOW },
    );
    expect(verdict.go).toBe(false);
    const rubricComp = verdict.components.find((c) => c.key === 'rubric:test-rubric');
    expect(rubricComp?.verdict).toBe('stale');
  });

  it('REFUSES GO on a real LINEAGE-MISMATCH case — the scorecard graded a different generation', async () => {
    const verdict = await evaluatePapercuspReleaseProfile({
      deps: healthyDeps, // running generation is 'gen-sha-1'
      gateOpts: healthyGateOpts,
      evaluateOpts: { now: NOW },
      rubricOpts: {
        deps: {
          // this scorecard graded an OLDER generation than what's running now
          listScorecards: async () => [
            scorecardRow({ gradedGeneration: { sha: 'gen-sha-0-OLD', hostStartedAt: null } }),
          ],
        },
      },
    });
    expect(verdict.go).toBe(false);
    const rubricComp = verdict.components.find((c) => c.key === 'rubric:test-rubric');
    expect(rubricComp?.verdict).toBe('lineage-mismatch');
    expect(rubricComp?.reason).toMatch(/disagrees with the expected candidate on: sha/);
  });

  it('REFUSES GO on the deploy-staleness hard gate alone, even with a healthy rubric', async () => {
    const verdict = await evaluatePapercuspReleaseProfile({
      deps: healthyDeps,
      evaluateOpts: { now: NOW },
      rubricOpts: {
        deps: { listScorecards: async () => [scorecardRow({ gradedGeneration: { sha: 'gen-sha-1', hostStartedAt: null } })] },
      },
      gateOpts: {
        // deployedSha matches the running generation ('gen-sha-1') so this case isolates
        // the STALENESS gate — not a lineage mismatch, which is covered by its own test above.
        deps: {
          deployedSha: async () => 'gen-sha-1',
          currentSha: async () => 'candidate-sha',
          commitUnixTime: async () => Math.floor(Date.now() / 1000) - 20 * 3_600,
          commitsBetween: async () => Array.from({ length: 50 }, (_, i) => `c${i}`),
        },
        thresholds: { maxPinAgeMs: 6 * 3_600_000, maxCommitsBehind: 20 },
      },
    });
    expect(verdict.go).toBe(false);
    expect(verdict.components.find((c) => c.key === 'gate:deploy-staleness')?.verdict).toBe('fail');
  });
});
