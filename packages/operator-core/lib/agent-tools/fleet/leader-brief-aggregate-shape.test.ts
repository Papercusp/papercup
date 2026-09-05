import { describe, expect, it } from 'vitest';
import { LEADER_BRIEF_SHAPER_BUDGET_CHARS, shapeLeaderBrief } from './leader-brief-shape';

describe('claimable_now aggregate projection (WI-41164 / P-002)', () => {
  it('keeps value + population + unknown atomic while bounding full family evidence', () => {
    const output = shapeLeaderBrief(
      {
        ok: true,
        summary: {
          fleet: 'observability-fleet',
          members: 3,
          population: {
            population: "member(s) of fleet 'observability-fleet'",
            basis: 'canonical roster',
            candidates: 3,
            counted: 3,
            withheld: 0,
          },
          claimable_now: {
            value: null,
            interpretation: {
              state: 'unknown',
              exactness: { status: 'unknown', reason: 'family-complete count unavailable' },
              evidence: {
                fleetPaused: false,
                matchedByFilter: null,
                excluded: null,
              },
            },
            population: {
              kind: 'fleet-claim-spec',
              fleet: 'observability-fleet',
              harness: 'papercusp',
              spec: {
                ref: 'observability-fleet@4',
                revision: 4,
                matchedBy: 'fleet',
                assigneeScoped: null,
                planScoped: false,
              },
              basis: 'issue+feature-family',
              matchedByFilter: null,
              families: {
                issue: { excluded: { noisy: 'x'.repeat(9_000) } },
                feature: { excluded: { noisy: 'x'.repeat(9_000) } },
                effective: { claimable: null, basis: 'issue+feature-family' },
              },
              note: 'n'.repeat(2_000),
            },
            unknown: {
              code: 'not-measured',
              detail: 'the feature-family leg did not produce a count',
            },
          },
        },
      },
      'trimmed',
    ) as Record<string, unknown>;

    expect(JSON.stringify(output).length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
    expect(output).toMatchObject({
      summary: {
        claimable_now: {
          value: null,
          interpretation: {
            state: 'unknown',
            exactness: { status: 'unknown' },
            evidence: { fleetPaused: false, matchedByFilter: null, excluded: null },
          },
          population: {
            kind: 'fleet-claim-spec',
            fleet: 'observability-fleet',
            harness: 'papercusp',
            spec: {
              ref: 'observability-fleet@4',
              revision: 4,
              assigneeScoped: null,
              planScoped: false,
            },
            basis: 'issue+feature-family',
          },
          unknown: { code: 'not-measured' },
        },
      },
    });
    expect(JSON.stringify(output)).not.toContain('claimable_now_spec');
    expect(JSON.stringify(output)).not.toContain('x'.repeat(1_000));
  });
});

describe('headcount aggregate projection (WI-41145)', () => {
  it('keeps target, current, shortfall, verdict, and productive-population basis in every monitor tier', () => {
    for (const tier of ['standard', 'trimmed'] as const) {
      const output = shapeLeaderBrief(
        {
          ok: true,
          summary: {
            fleet: 'under-strength-fleet',
            members: 3,
            headcount: {
              enabled: true,
              target: 5,
              current: 3,
              shortfall: 2,
              underStrength: true,
              verdict: 'under-strength',
              basis: {
                kind: 'agent-origin-execution-attested',
                liveRosterMembers: 53,
                executingMembers: 3,
                transactionWorkerReadyMembers: 5,
                ignoredLargeField: 'x'.repeat(4_000),
              },
            },
          },
        },
        tier,
      ) as { summary: { headcount: Record<string, unknown> } };

      expect(output.summary.headcount).toEqual({
        enabled: true,
        target: 5,
        current: 3,
        shortfall: 2,
        underStrength: true,
        verdict: 'under-strength',
        basis: {
          kind: 'agent-origin-execution-attested',
          liveRosterMembers: 53,
          executingMembers: 3,
          transactionWorkerReadyMembers: 5,
        },
      });
    }
  });
});
