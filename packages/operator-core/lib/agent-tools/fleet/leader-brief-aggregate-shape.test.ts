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
            population: {
              kind: 'fleet-claim-spec',
              fleet: 'observability-fleet',
              harness: 'papercusp',
              spec: {
                ref: 'observability-fleet@4',
                revision: 4,
                matchedBy: 'fleet',
                assigneeScoped: null,
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
          population: {
            kind: 'fleet-claim-spec',
            fleet: 'observability-fleet',
            harness: 'papercusp',
            spec: {
              ref: 'observability-fleet@4',
              revision: 4,
              assigneeScoped: null,
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
