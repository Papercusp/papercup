import { describe, expect, it } from 'vitest';
import { parsePlan } from '@papercusp/plan-parser';
import {
  invalidPlanDependenciesValue,
  validatePlanCandidateDependencies,
  validatePlanCandidateDependencyTransition,
} from './plan-candidate-dependencies';

function body(status: 'draft' | 'ready' | 'active' | 'shipped' | 'superseded', items: string[]): string {
  return `---
title: candidate dependency test
slug: candidate-dependency-test
status: ${status}
created: 2026-08-27
updated: 2026-08-27
---

# candidate dependency test

## Phase 1

${items.join('\n')}
`;
}

function verdict(status: Parameters<typeof body>[0], items: string[], opStatus: string | null = null) {
  return validatePlanCandidateDependencies(parsePlan(body(status, items)), opStatus);
}

describe('validatePlanCandidateDependencies', () => {
  it('adapts a resolved DAG onto the shared analyser as a valid executable candidate', () => {
    expect(
      verdict('ready', ['- **P-001** `done` foundation', '- **P-002** `todo` dependent blocked-by: P-001']),
    ).toEqual({
      state: 'valid',
      executable: true,
      lifecycleStatus: 'ready',
      opStatus: null,
      diagnostics: [],
    });
  });

  it('always rejects cycles and preserves the exact closed analyzer path', () => {
    const result = verdict('draft', [
      '- **P-001** `todo` first blocked-by: P-002',
      '- **P-002** `todo` second blocked-by: P-001',
    ]);

    expect(result.state).toBe('rejected');
    expect(result.diagnostics).toContainEqual({
      code: 'dependency_cycle',
      disposition: 'reject',
      message: 'Plan dependency cycle: P-001 -> P-002 -> P-001',
      itemId: 'P-001',
      ref: null,
      endpointRole: null,
      path: ['P-001', 'P-002', 'P-001'],
      members: ['P-001', 'P-002'],
    });
  });

  it('allows a draft forward ref only as an explicit invalid-draft diagnostic', () => {
    const result = verdict('draft', ['- **P-001** `todo` future-dependent blocked-by: P-099']);

    expect(result).toMatchObject({
      state: 'invalid-draft',
      executable: false,
      lifecycleStatus: 'draft',
      diagnostics: [
        {
          code: 'dependency_endpoint_missing',
          disposition: 'invalid-draft',
          itemId: 'P-001',
          ref: 'P-099',
          endpointRole: 'blocker',
          path: ['P-001', 'P-099'],
        },
      ],
    });
    expect(result.diagnostics[0]?.message).toContain('Invalid draft forward reference');
  });

  it.each(['ready', 'active'] as const)('rejects the same dangling ref when lifecycle status is %s', (status) => {
    const result = verdict(status, ['- **P-001** `todo` future-dependent blocked-by: P-099']);
    expect(result).toMatchObject({
      state: 'rejected',
      executable: true,
      diagnostics: [
        {
          disposition: 'reject',
          itemId: 'P-001',
          ref: 'P-099',
          path: ['P-001', 'P-099'],
        },
      ],
    });
  });

  it.each(['started', 'paused'])(
    'treats a frontmatter draft with op_status=%s as executable and rejects its forward ref',
    (opStatus) => {
      const result = verdict('draft', ['- **P-001** `todo` future-dependent blocked-by: P-099'], opStatus);
      expect(result).toMatchObject({
        state: 'rejected',
        executable: true,
        lifecycleStatus: 'draft',
        opStatus,
        diagnostics: [{ disposition: 'reject', path: ['P-001', 'P-099'] }],
      });
    },
  );

  it('formats a non-throwing refusal with the exact path evidence', () => {
    const result = verdict('active', ['- **P-001** `todo` future-dependent blocked-by: P-099']);
    expect(invalidPlanDependenciesValue('candidate-dependency-test', result)).toMatchObject({
      ok: false,
      code: 'invalid_plan_dependencies',
      message: expect.stringContaining('P-001 -> P-099'),
      dependencyDiagnostics: [
        {
          disposition: 'reject',
          ref: 'P-099',
          path: ['P-001', 'P-099'],
        },
      ],
    });
  });
});

describe('validatePlanCandidateDependencyTransition', () => {
  const ready = (items: string[]) => parsePlan(body('ready', items));
  const transition = (beforeItems: string[], afterItems: string[]) =>
    validatePlanCandidateDependencyTransition(ready(beforeItems), ready(afterItems), null);

  it('admits a strict-subset repair and labels every remaining hard defect legacy-residual', () => {
    const result = transition(
      [
        '- **P-001** `todo` first blocked-by: P-099',
        '- **P-002** `todo` second blocked-by: P-098',
      ],
      ['- **P-001** `todo` first blocked-by: P-099', '- **P-002** `todo` second'],
    );

    expect(result).toMatchObject({
      state: 'legacy-residual',
      diagnostics: [
        {
          code: 'dependency_endpoint_missing',
          disposition: 'legacy-residual',
          itemId: 'P-001',
          ref: 'P-099',
        },
      ],
    });
  });

  it('rejects an edit that leaves the hard fingerprint set unchanged', () => {
    const items = ['- **P-001** `todo` first blocked-by: P-099', '- **P-002** `todo` second'];
    expect(transition(items, items).state).toBe('rejected');
  });

  it('rejects a defect swap even when the hard-defect count does not increase', () => {
    const result = transition(
      [
        '- **P-001** `todo` first blocked-by: P-099',
        '- **P-002** `todo` second blocked-by: P-098',
      ],
      [
        '- **P-001** `todo` first blocked-by: P-099',
        '- **P-002** `todo` second blocked-by: P-097',
      ],
    );
    expect(result.state).toBe('rejected');
    expect(result.diagnostics.map((diagnostic) => diagnostic.ref)).toEqual(['P-099', 'P-097']);
  });

  it('returns the ordinary valid verdict when the repair removes every hard defect', () => {
    const result = transition(
      ['- **P-001** `todo` first blocked-by: P-099', '- **P-002** `todo` second'],
      ['- **P-001** `todo` first', '- **P-002** `todo` second'],
    );
    expect(result).toMatchObject({ state: 'valid', diagnostics: [] });
  });

  it('never grandfathers a hard defect on a newly created plan', () => {
    const after = ready(['- **P-001** `todo` first blocked-by: P-099']);
    expect(validatePlanCandidateDependencyTransition(null, after, null).state).toBe('rejected');
  });
});
