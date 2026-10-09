import { describe, expect, it } from 'vitest';
import { previewProductShaping, productShapingScaffold, type ProductShaping } from './product-shaping';

const source = 'session_turn:codex:original-request:1';
function brief(outcome = 'The user can retry without losing their draft.'): ProductShaping {
  return {
    audience: 'A person reporting a bug', problem: 'A failed submission loses their work', outcome,
    nonGoals: ['Automatic public posting'], sourceRefs: [source],
    context: [{ kind: 'owner-request', text: 'Make bug reporting easy', sourceRefs: [source] },
      { kind: 'assumption', text: 'Retain drafts locally', recommendation: 'Use the existing draft store' }],
    scenarios: [{ id: 'SC-001', title: 'Retry submission', kind: 'normal', trigger: 'A saved draft',
      action: 'Submit the report', outcome, requirementIds: ['R-1'] }],
    considerations: [{ category: 'Network failure', disposition: 'covered', reason: 'Retry retains the draft', scenarioIds: ['SC-001'] },
      { category: 'Billing', disposition: 'not-applicable', reason: 'No payments in this feature', scenarioIds: [] }],
  };
}
function plan(shape: ProductShaping, requirements = '**R-1 — Retry.** The person can retry submission.', map = '| R-1 | P-001 | tree |') {
  return '# Feature\n\n## Product shaping\n\n```product-shaping\n' + JSON.stringify(shape) +
    '\n```\n\n## Requirements\n\n' + requirements + '\n\n## Design\n\n### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n|---|---|---|\n' + map + '\n\n## Build\n\n- **P-001** `todo` Deliver the outcome\n';
}

describe('product shaping', () => {
  it('keeps the intended outcome, source and assumed technical choice distinct', () => {
    const result = previewProductShaping(plan(brief()));
    expect(result.status).toBe('ready-for-review');
    expect(result.diagnostics).toEqual([]);
    expect(result.trace).toEqual([{ scenarioId: 'SC-001', requirementIds: ['R-1'], planItemIds: ['P-001'] }]);
    expect(result.reviewerBrief.sourceRefs).toEqual([source]);
    expect(result.brief && 'context' in result.brief ? result.brief.context.map(entry => entry.kind) : []).toEqual(['owner-request', 'assumption']);
    expect(result.semanticCompleteness).toBe('not-measured');
    expect(result.sourceContentVerified).toBe(false);
    expect(result.advisory).toBe(true);
  });

  it('guides a legacy plan without inventing product intent or blocking it', () => {
    const result = previewProductShaping('# Legacy\n## Build\n- **P-001** `todo` Work');
    expect(result.status).toBe('missing');
    expect(result.brief).toBeNull();
    expect(result.scaffold).toContain('```product-shaping');
    expect(result.reviewerBrief.sourceRefs).toEqual([]);
  });

  it('the scaffold admits incomplete drafts while exposing their omissions', () => {
    const result = previewProductShaping('# Draft\n' + productShapingScaffold());
    expect(result.status).toBe('incomplete');
    expect(result.diagnostics.map(row => row.code)).toContain('original_sources_missing');
    expect(result.diagnostics.map(row => row.code)).toContain('scenario_field_missing');
  });

  it.each(['{oops', '{"audience":"only a fragment"}'])('reports invalid data without calling it complete: %s', json => {
    const result = previewProductShaping('## Product shaping\n```product-shaping\n' + json + '\n```');
    expect(result.status).toBe('invalid');
    expect(result.brief).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('rejects duplicate shaping sections and blocks', () => {
    const single = productShapingScaffold();
    expect(previewProductShaping(single + '\n' + single).status).toBe('invalid');
    expect(previewProductShaping(single + '\n```product-shaping\n{}\n```').status).toBe('invalid');
  });

  it('exposes an unsupported extra requirement and dangling implementation mapping', () => {
    const result = previewProductShaping(plan(brief(), '**R-1 — Retry.** Retry works.\n\n**R-2 — Publish.** Public posting works.', '| R-1 | P-999 | tree |\n| R-2 | P-001 | tree |'));
    expect(result.status).toBe('incomplete');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'requirement_untraced', ref: 'R-2' }),
      expect.objectContaining({ code: 'bar_mapping_unknown', ref: 'R-1' }),
    ]));
  });

  it('flags missing requirements, duplicate scenarios and unresolved material choices together', () => {
    const shape = brief();
    shape.scenarios[0]!.requirementIds = ['R-999'];
    shape.scenarios.push({ ...shape.scenarios[0]! });
    shape.context.push({ kind: 'product-choice', text: 'Public or private reports?', material: true, resolved: false, recommendation: 'Private by default' });
    const codes = previewProductShaping(plan(shape)).diagnostics.map(row => row.code);
    expect(codes).toEqual(expect.arrayContaining(['scenario_requirement_missing', 'scenario_duplicate', 'material_choice_open']));
  });

  it('accepts a reasoned non-applicable concern without manufacturing a scenario', () => {
    expect(previewProductShaping(plan(brief())).diagnostics.some(row => row.ref === 'Billing')).toBe(false);
  });

  it('allows code/document evidence for facts while preserving owner-source distinctions', () => {
    const shape = brief();
    shape.context.push({ kind: 'observed-fact', text: 'Draft storage exists', sourceRefs: ['file:lib/drafts.ts'] });
    expect(previewProductShaping(plan(shape)).status).toBe('ready-for-review');
    shape.context[0]!.sourceRefs = ['file:generated-spec.md'];
    expect(previewProductShaping(plan(shape)).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'owner_source_invalid' }),
    ]));
  });

  it('bounds large diagnostic lists with explicit overflow and a repair path', () => {
    const shape = brief();
    shape.scenarios = Array.from({ length: 30 }, (_, i) => ({ id: 'SC-' + String(i + 1).padStart(3, '0'), title: '', kind: 'normal' as const,
      trigger: '', action: '', outcome: '', requirementIds: [] }));
    const result = previewProductShaping(plan(shape));
    expect(result.diagnostics.length).toBeLessThanOrEqual(20);
    expect(result.diagnosticsOmitted).toBeGreaterThan(0);
    expect(result.overflowRead).toContain('canonical Product shaping');
    expect(result.status).toBe('incomplete');
  });

  it('keeps a large valid brief bounded with original-source and canonical-section pointers', () => {
    const shape = brief();
    shape.problem = 'Problem '.repeat(200);
    shape.sourceRefs = Array.from({ length: 20 }, (_, i) => 'session_turn:codex:' + 'x'.repeat(400) + ':' + i);
    const result = previewProductShaping(plan(shape));
    expect(result.status).toBe('ready-for-review');
    expect(result.briefIsExcerpt).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(6000);
    expect(result.reviewerBrief.readFullContext).toContain('Product shaping');
    expect(result.reviewerBrief.sourceRefs).toHaveLength(3);
  });

  it.each([
    ['bug report retry', 'The report draft survives a failed submission.', 'failure'],
    ['notification preferences', 'A disabled notification remains suppressed.', 'boundary'],
    ['collaboration permissions', 'A reader cannot publish changes.', 'authorization'],
  ] as const)('pilot fixture: %s exposes an omitted behavior before tasking', (_name, outcome, kind) => {
    const shape = brief(outcome);
    shape.scenarios.push({ id: 'SC-002', title: _name, kind, trigger: 'Relevant edge case', action: 'Attempt the action', outcome, requirementIds: [] });
    const before = previewProductShaping(plan(shape));
    expect(before.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'scenario_unmapped', ref: 'SC-002' })]));
    shape.scenarios[1]!.requirementIds = ['R-2'];
    const after = previewProductShaping(plan(shape, '**R-1 — Normal.** The normal journey works.\n\n**R-2 — Edge.** ' + outcome, '| R-1 | P-001 | tree |\n| R-2 | P-001 | tree |'));
    expect(after.status).toBe('ready-for-review');
    expect(after.trace[1]?.requirementIds).toEqual(['R-2']);
    // A fixture validates the workflow, not the rate of real owner omissions.
    expect(after.semanticCompleteness).toBe('not-measured');
  });
});
