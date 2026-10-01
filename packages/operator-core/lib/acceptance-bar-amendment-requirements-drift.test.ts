import { describe, expect, it } from 'vitest';
import { parseRequirementBars } from './acceptance-bar-seed';
import { diffAmendedCriteriaAgainstRequirements } from './acceptance-bar-amendment-requirements-drift';

// EI-24816459669484550: a rubric amendment can leave the plan's ## Requirements block
// disagreeing with the canonical rubric. These cases parse REAL plan text, so the
// falsifier -> driftMarkers mapping is exercised end to end, not restated by hand.

const sections = {
  intent: { request: 'Export every matching customer.', sourceRefs: ['session_turn:export'] },
  acceptance: {
    condition: 'Every matching ID appears exactly once with correct values.',
    falsifier: 'Any ID is missing or duplicated.',
    evidencePlane: 'tree',
    requiredScope: ['filters', 'pagination'],
    requiredTestLayers: ['e2e'],
  },
  verification: {
    method: 'Export a multi-page fixture and compare all expected rows.',
    check: { kind: 'instrument', instrumentKey: 'none' },
  },
};

const planContent = [
  '# Drift target',
  '',
  '## Requirements',
  '',
  '**R-1 — Complete export.**',
  '```requirement',
  JSON.stringify(sections),
  '```',
  '',
  '**R-2 — Legacy prose outcome.** The writer persists one canonical bar.',
  '',
  '## Items',
  '',
].join('\n');

function bars() {
  const parsed = parseRequirementBars(planContent);
  if (!parsed.ok) throw new Error(`fixture plan failed to parse: ${JSON.stringify(parsed.problems)}`);
  return parsed.bars;
}

// The rubric criteria exactly as the plan seeds them (R-2's driftMarkers is the generated
// sentence a legacy prose BAR receives, which the plan itself never states).
const inSyncCriteria = () => [
  {
    key: 'r-1', barKey: 'R-1', model: sections.acceptance.condition,
    driftMarkers: sections.acceptance.falsifier,
  },
  {
    key: 'r-2', barKey: 'R-2', model: 'The writer persists one canonical bar.',
    driftMarkers: 'R-2 is falsified when the required outcome is absent, contradicted, or cannot be evidenced.',
  },
];

describe('diffAmendedCriteriaAgainstRequirements', () => {
  it('fixture sanity: the three-section R-1 carries its falsifier as driftMarkers, the prose R-2 has none', () => {
    const [r1, r2] = bars();
    expect(r1!.criterion?.driftMarkers).toBe(sections.acceptance.falsifier);
    expect(r2!.criterion).toBeUndefined();
  });

  it('reports nothing when the amended rubric agrees with the plan', () => {
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: inSyncCriteria(), changedBars: ['R-1'],
    });
    expect(drift).toEqual({ inSync: true, entries: [], action: null });
  });

  it('ignores whitespace-only differences, because the canonical writer collapses BAR text', () => {
    const criteria = inSyncCriteria();
    criteria[0]!.model = `  ${sections.acceptance.condition.replace(/ /g, '\n  ')}  `;
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.inSync).toBe(true);
  });

  it('flags the R-13 incident shape: model patched to match, driftMarkers left on the superseded falsifier', () => {
    const criteria = inSyncCriteria();
    criteria[0]!.driftMarkers = 'An ingested ticket creates a work_items row.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.inSync).toBe(false);
    expect(drift.entries).toEqual([
      { barKey: 'R-1', changedByAmendment: true, kind: 'text-differs', fields: ['driftMarkers'] },
    ]);
    expect(drift.action).toContain('R-1 (driftMarkers)');
  });

  it('flags a reworded model the plan block was never updated to match', () => {
    const criteria = inSyncCriteria();
    criteria[0]!.model = 'Every matching ID appears at least once.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.entries).toEqual([
      { barKey: 'R-1', changedByAmendment: true, kind: 'text-differs', fields: ['model'] },
    ]);
  });

  it('never compares driftMarkers for a legacy prose BAR (its falsifier is generated, not authored)', () => {
    const criteria = inSyncCriteria();
    criteria[1]!.driftMarkers = 'Anything at all.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-2'],
    });
    expect(drift.inSync).toBe(true);
  });

  it('marks drift on a BAR this amendment does not touch as pre-existing', () => {
    const criteria = inSyncCriteria();
    criteria[1]!.model = 'The writer persists two bars.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.entries).toEqual([
      { barKey: 'R-2', changedByAmendment: false, kind: 'text-differs', fields: ['model'] },
    ]);
  });

  it('skips removed BARs and non-BAR criteria, and names a BAR the plan does not carry', () => {
    const criteria: Array<Record<string, unknown>> = [
      ...inSyncCriteria(),
      { key: 'r-3', barKey: 'R-3', model: 'A new outcome.' },
      { key: 'quality', model: 'A non-BAR quality criterion.' },
    ];
    criteria[1]!.model = 'Retired text that would otherwise be drift.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-2', 'R-3'], removedBars: ['R-2'],
    });
    expect(drift.entries).toEqual([
      { barKey: 'R-3', changedByAmendment: true, kind: 'missing-from-plan', fields: [] },
    ]);
    expect(drift.action).toContain('R-3 (missing from plan)');
  });

  it('orders entries by BAR number, not lexically (R-10 after R-2)', () => {
    const tenSections = { ...sections, acceptance: { ...sections.acceptance, condition: 'Ten holds.' } };
    const content = planContent.replace(
      '## Items',
      ['**R-10 — Tenth.**', '```requirement', JSON.stringify(tenSections), '```', '', '## Items'].join('\n'),
    );
    const parsed = parseRequirementBars(content);
    if (!parsed.ok) throw new Error('fixture plan failed to parse');
    const criteria: Array<Record<string, unknown>> = [
      { key: 'r-10', barKey: 'R-10', model: 'Ten drifted.', driftMarkers: sections.acceptance.falsifier },
      { ...inSyncCriteria()[1]!, model: 'Two drifted.' },
    ];
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: parsed.bars, nextCriteria: criteria, changedBars: [],
    });
    expect(drift.entries.map((entry) => entry.barKey)).toEqual(['R-2', 'R-10']);
  });
});
