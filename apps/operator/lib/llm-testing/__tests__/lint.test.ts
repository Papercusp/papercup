/**
 * Tests for the static scenario linter.
 *
 * Synthetic cases exercise each validation branch. The final block
 * asserts the real scenario registry lints clean — that's the
 * recurring authoring-drift catch the linter was built for.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { lintScenario, lintScenarios, formatViolations, type LintViolation } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../rubrics/operator';
import { SCENARIOS } from '../scenarios';
import { listTargets } from '../targets';
import type { Scenario } from '@papercusp/testing-shell/llm';

// Minimal valid baseline; tests mutate copies of this.
function baseScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'op-test-base',
    version: 1,
    target: 'operator',
    description: 'A long-enough description to satisfy the substantive-paragraph warning threshold.',
    persona: 'brief-admin',
    goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
    caps: { maxTurns: 3, maxWallSecs: 60, maxCostUsd: 0.5 },
    asserts: [],
    rubric: OPERATOR_RUBRIC,
    ...over,
  };
}

const errors = (v: LintViolation[]) => v.filter((x) => x.severity === 'error');

describe('lintScenario — schema basics', () => {
  it('passes a minimal valid scenario', () => {
    expect(errors(lintScenario(baseScenario()))).toEqual([]);
  });

  it('flags missing id', () => {
    const v = lintScenario(baseScenario({ id: '' }));
    expect(errors(v).some((e) => e.field === 'id')).toBe(true);
  });

  it('flags non-integer version', () => {
    const v = lintScenario(baseScenario({ version: 1.5 as unknown as number }));
    expect(errors(v).some((e) => e.field === 'version')).toBe(true);
  });

  it('flags an unregistered target', () => {
    // The lib's lint only checks target registration when the host injects its
    // registry (P-073). The operator's real lint path (bin/llm-test) passes
    // listTargets(); mirror that here so the check is exercised.
    const v = lintScenario(baseScenario({ target: 'not-a-real-target' }), {
      registeredTargets: listTargets(),
    });
    expect(errors(v).some((e) => e.field === 'target')).toBe(true);
  });

  it('warns on a short description (judges and sim-users read it)', () => {
    const v = lintScenario(baseScenario({ description: 'too short' }));
    expect(v.some((e) => e.field === 'description' && e.severity === 'warn')).toBe(true);
  });
});

describe('lintScenario — caps', () => {
  it('flags non-positive maxTurns', () => {
    const v = lintScenario(baseScenario({ caps: { maxTurns: 0, maxWallSecs: 1, maxCostUsd: 1 } }));
    expect(errors(v).some((e) => e.field === 'caps.maxTurns')).toBe(true);
  });

  it('flags non-finite maxWallSecs', () => {
    const v = lintScenario(
      baseScenario({ caps: { maxTurns: 1, maxWallSecs: Number.POSITIVE_INFINITY, maxCostUsd: 1 } }),
    );
    expect(errors(v).some((e) => e.field === 'caps.maxWallSecs')).toBe(true);
  });
});

describe('lintScenario — goal', () => {
  it('flags an unknown goal.kind', () => {
    const v = lintScenario(baseScenario({ goal: { kind: 'mystery' } as unknown as Scenario['goal'] }));
    expect(errors(v).some((e) => e.field === 'goal.kind')).toBe(true);
  });
});

describe('lintScenario — persona', () => {
  it('flags an unregistered persona blend string', () => {
    const v = lintScenario(baseScenario({ persona: 'no-such-blend' as unknown as Scenario['persona'] }));
    expect(errors(v).some((e) => e.field === 'persona')).toBe(true);
  });

  it('accepts a valid inline PersonaTraits', () => {
    const v = lintScenario(
      baseScenario({
        persona: {
          verbosity: 'terse',
          politeness: 'neutral',
          clarification: 'never_clarifies',
          goalClarity: 'precise',
          interrupts: false,
          modality: 'text',
        } as unknown as Scenario['persona'],
      }),
    );
    expect(errors(v)).toEqual([]);
  });

  it('flags an invalid verbosity value', () => {
    const v = lintScenario(
      baseScenario({
        persona: {
          verbosity: 'loud' as unknown,
          politeness: 'neutral',
          clarification: 'never_clarifies',
          goalClarity: 'precise',
          interrupts: false,
          modality: 'text',
        } as unknown as Scenario['persona'],
      }),
    );
    expect(errors(v).some((e) => e.field === 'persona.traits.verbosity')).toBe(true);
  });

  it('flags non-boolean interrupts', () => {
    const v = lintScenario(
      baseScenario({
        persona: {
          verbosity: 'terse',
          politeness: 'neutral',
          clarification: 'never_clarifies',
          goalClarity: 'precise',
          interrupts: 'yes' as unknown,
          modality: 'text',
        } as unknown as Scenario['persona'],
      }),
    );
    expect(errors(v).some((e) => e.field === 'persona.traits.interrupts')).toBe(true);
  });
});

describe('lintScenario — rubric', () => {
  it('flags missing version', () => {
    const v = lintScenario(
      baseScenario({ rubric: { ...OPERATOR_RUBRIC, version: '' } }),
    );
    expect(errors(v).some((e) => e.field === 'rubric.version')).toBe(true);
  });

  it('flags zero axes', () => {
    const v = lintScenario(
      baseScenario({ rubric: { ...OPERATOR_RUBRIC, axes: [] } }),
    );
    expect(errors(v).some((e) => e.field === 'rubric.axes')).toBe(true);
  });

  it('flags duplicate axis ids', () => {
    const v = lintScenario(
      baseScenario({
        rubric: {
          ...OPERATOR_RUBRIC,
          axes: [
            ...OPERATOR_RUBRIC.axes,
            { ...OPERATOR_RUBRIC.axes[0] },
          ],
        },
      }),
    );
    expect(errors(v).some((e) => e.field.startsWith('rubric.axes['))).toBe(true);
  });

  it('flags invalid criticality', () => {
    const v = lintScenario(
      baseScenario({
        rubric: { ...OPERATOR_RUBRIC, criticality: 'extreme' as unknown as 'normal' },
      }),
    );
    expect(errors(v).some((e) => e.field === 'rubric.criticality')).toBe(true);
  });
});

describe('lintScenario — triggers', () => {
  it('flags an unknown TurnTrigger fire value', () => {
    const v = lintScenario(
      baseScenario({
        triggers: [{ on: 'after_turn', fire: 'not_a_trigger' as Scenario['triggers'] extends infer T ? never : never, param: 0 }] as unknown as Scenario['triggers'],
      }),
    );
    expect(errors(v).some((e) => e.field === 'triggers[0].fire')).toBe(true);
  });

  it('flags a scripted param ≥ caps.maxTurns (unreachable)', () => {
    const v = lintScenario(
      baseScenario({
        caps: { maxTurns: 1, maxWallSecs: 60, maxCostUsd: 0.5 },
        triggers: [{ on: 'after_turn', fire: 'open_canvas', param: 1 }],
      }),
    );
    expect(errors(v).some((e) => e.field === 'triggers[0].param')).toBe(true);
  });

  it('flags a negative scripted param', () => {
    const v = lintScenario(
      baseScenario({
        triggers: [{ on: 'after_turn', fire: 'open_canvas', param: -1 }],
      }),
    );
    expect(errors(v).some((e) => e.field === 'triggers[0].param')).toBe(true);
  });

  it('accepts a valid after_turn=0 with maxTurns=1', () => {
    const v = lintScenario(
      baseScenario({
        caps: { maxTurns: 1, maxWallSecs: 60, maxCostUsd: 0.5 },
        triggers: [{ on: 'after_turn', fire: 'open_canvas', param: 0 }],
      }),
    );
    expect(errors(v)).toEqual([]);
  });
});

describe('lintScenario — asserts', () => {
  it('flags an unknown assert kind', () => {
    const v = lintScenario(
      baseScenario({
        asserts: [{ kind: 'not_a_thing' } as unknown as Scenario['asserts'][number]],
      }),
    );
    expect(errors(v).some((e) => e.field === 'asserts[0].kind')).toBe(true);
  });

  it('flags a custom assert with no name', () => {
    const v = lintScenario(
      baseScenario({
        asserts: [{ kind: 'custom', name: '', eval: () => [] }],
      }),
    );
    expect(errors(v).some((e) => e.field === 'asserts[0].name')).toBe(true);
  });

  it('flags a custom assert with non-callable eval', () => {
    const v = lintScenario(
      baseScenario({
        asserts: [
          { kind: 'custom', name: 'x', eval: 'not a function' as unknown as Scenario['asserts'][number] extends { eval: infer F } ? F : never },
        ] as unknown as Scenario['asserts'],
      }),
    );
    expect(errors(v).some((e) => e.field === 'asserts[0].eval')).toBe(true);
  });

  it('flags control_tag_present with an unsupported tag', () => {
    const v = lintScenario(
      baseScenario({
        asserts: [
          { kind: 'control_tag_present', tag: 'set_mode' as unknown as 'continue', minCount: 1 },
        ],
      }),
    );
    expect(errors(v).some((e) => e.field === 'asserts[0].tag')).toBe(true);
  });

  it('flags tool_called with no name', () => {
    const v = lintScenario(
      baseScenario({
        asserts: [{ kind: 'tool_called', name: '', minTimes: 1 }],
      }),
    );
    expect(errors(v).some((e) => e.field === 'asserts[0].name')).toBe(true);
  });
});

describe('lintScenario — runMatrix + transport + fixtures', () => {
  it('flags repeat < 1', () => {
    const v = lintScenario(baseScenario({ runMatrix: { repeat: 0 } }));
    expect(errors(v).some((e) => e.field === 'runMatrix.repeat')).toBe(true);
  });

  it('flags unknown variancePolicy', () => {
    const v = lintScenario(
      baseScenario({
        runMatrix: { repeat: 3, variancePolicy: 'flag-anything' as unknown as 'none' },
      }),
    );
    expect(errors(v).some((e) => e.field === 'runMatrix.variancePolicy')).toBe(true);
  });

  it('flags unknown transport', () => {
    const v = lintScenario(baseScenario({ transport: 'tcp' as unknown as 'http-sse' }));
    expect(errors(v).some((e) => e.field === 'transport')).toBe(true);
  });

  it('flags a fixtures.sseTapePath that does not exist on disk', () => {
    const v = lintScenario(
      baseScenario({ fixtures: { sseTapePath: 'fixtures/not-there.sse' } }),
      { fileExists: () => false, fixtureRoot: '/tmp' },
    );
    expect(errors(v).some((e) => e.field === 'fixtures.sseTapePath')).toBe(true);
  });

  it('does NOT flag a fixtures path that exists', () => {
    const v = lintScenario(
      baseScenario({ fixtures: { sseTapePath: 'fixtures/here.sse' } }),
      { fileExists: () => true, fixtureRoot: '/tmp' },
    );
    expect(errors(v)).toEqual([]);
  });
});

describe('lintScenarios — registry-level', () => {
  it('flags duplicate scenario ids across the list', () => {
    const v = lintScenarios([baseScenario(), baseScenario()]);
    expect(errors(v).some((e) => e.field === 'id' && /duplicate/.test(e.message))).toBe(true);
  });
});

describe('formatViolations', () => {
  it('returns a clean-suite message for empty input', () => {
    expect(formatViolations([])).toMatch(/lint clean/);
  });

  it('groups by scenario id', () => {
    const out = formatViolations([
      { scenarioId: 'op-A', field: 'id', severity: 'error', message: 'bad' },
      { scenarioId: 'op-B', field: 'caps', severity: 'warn', message: 'meh' },
    ]);
    expect(out).toMatch(/op-A:/);
    expect(out).toMatch(/op-B:/);
    expect(out).toMatch(/1 error\(s\), 1 warning\(s\)/);
  });
});

// =============================================================================
// The real value: every scenario shipped in the registry lints clean.
// =============================================================================

describe('scenario registry lints clean', () => {
  it('the full registry has zero errors', () => {
    const v = lintScenarios(SCENARIOS, {
      fileExists: (p) => existsSync(p),
      fixtureRoot: resolve(__dirname, '..'),
    });
    const errs = errors(v);
    if (errs.length > 0) {
      console.log('Lint errors found:\n' + formatViolations(errs));
    }
    expect(errs).toEqual([]);
  });
});
