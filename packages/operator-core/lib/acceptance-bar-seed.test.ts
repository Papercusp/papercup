import { describe, expect, it } from 'vitest';
import {
  buildAcceptanceBarSeed,
  parseBarMappings,
  parseRequirementBars,
} from './acceptance-bar-seed';
import { computeAcceptanceBarSetHash, normalizeAcceptanceBarCriterion } from './rubrics';
import { guardAcceptanceBarTemplateDataWrite } from './agent-tools/plans/rubric-loss-guard';

function plan(opts: { requirements?: string; map?: string } = {}): string {
  return `---
title: Seed target
slug: seed-target
status: draft
created: 2026-09-04
updated: 2026-09-04
---

# Seed target

## Requirements

${opts.requirements ?? `**R-1 — First outcome.** The writer persists one canonical bar.

**R-2 — Runtime outcome.** The live service exposes the current verdict.`}

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
${opts.map ?? `| R-1 | P-001, P-002 | tree |
| R-2 | P-002 | live |`}

## Phase 1 — Build

- **P-001** \`todo\` persist the canonical BAR
- **P-002** \`blocked\` expose the BAR verdict
`;
}

const input = {
  planSlug: 'seed-target',
  actorId: 'su-seeder',
  declaredAt: '2026-09-04T20:00:00.000Z',
  cohort: 'post-epoch' as const,
  adoptionEpoch: 1,
  subjectPlanRevision: 7,
  rubricSlug: 'acceptance-seed-target',
  rubricRevision: 1,
};

describe('Requirements BAR parser', () => {
  it('parses every explicit R-N record and refuses malformed partial records', () => {
    const parsed = parseRequirementBars(plan());
    expect(parsed).toMatchObject({
      ok: true,
      bars: [
        { barKey: 'R-1', title: 'First outcome' },
        { barKey: 'R-2', title: 'Runtime outcome' },
      ],
    });

    const malformed = parseRequirementBars(plan({
      requirements: '**R-1 First outcome.** Missing the required dash delimiter.',
    }));
    expect(malformed).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ code: 'bar_requirement_parse_failed' })],
    });
  });

  it('requires an exact non-dropped map row per bar and validates the evidence plane', () => {
    const keys = new Set(['R-1', 'R-2']);
    expect(parseBarMappings(plan(), keys)).toMatchObject({
      ok: true,
      mappings: [
        { barKey: 'R-1', planItemIds: ['P-001', 'P-002'], evidencePlane: 'tree' },
        { barKey: 'R-2', planItemIds: ['P-002'], evidencePlane: 'live' },
      ],
    });
    expect(parseBarMappings(plan({ map: '| R-1 | P-001 | cloud |' }), keys)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ code: 'bar_evidence_plane_invalid', barKey: 'R-1' }),
        expect.objectContaining({ code: 'bar_mapping_missing', barKey: 'R-2' }),
      ]),
    });
  });
});

describe('acceptance BAR seed builder', () => {
  it('authors one unified requirement and derives all mapped proof contracts without rewriting its promise', () => {
    const sections = {
      intent: { request: 'Export every matching customer.', sourceRefs: ['session_turn:export'] },
      acceptance: { condition: 'Every matching ID appears exactly once with correct values.',
        falsifier: 'Any ID is missing or duplicated.', evidencePlane: 'tree',
        requiredScope: ['filters', 'pagination'], requiredTestLayers: ['e2e'] },
      verification: { method: 'Export a multi-page fixture and compare all expected rows.',
        check: { kind: 'instrument', instrumentKey: 'none' } },
    };
    const content = plan({ requirements: '**R-1 — Complete export.**\n```requirement\n' + JSON.stringify(sections) + '\n```',
      map: '| R-1 | P-001, P-002 | tree |' });
    const built = buildAcceptanceBarSeed({ ...input, planContent: content });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    expect(built.criteria[0]).toMatchObject({ model: sections.acceptance.condition,
      driftMarkers: sections.acceptance.falsifier, intent: sections.intent,
      method: sections.verification.method, requiredTestLayers: ['e2e'] });
    expect(built.projections).toHaveLength(2);
    expect(built.projections.every((clause) => clause.requiredTestLayers?.[0] === 'e2e')).toBe(true);
    expect(buildAcceptanceBarSeed({ ...input, planContent: content.replace('| tree |', '| live |') }))
      .toMatchObject({ ok: false, error: 'bar_evidence_plane_invalid' });
    expect(parseRequirementBars(content.replace('\n```\n', '\n```\nA different promise.\n')).ok).toBe(false);
  });
  it('adopts explicitly mapped legacy criteria without losing their identity, stronger outcomes or METHODS', () => {
    const existing = { kind: 'acceptance', subjectPlan: input.planSlug, characteristic: 'plan-acceptance',
      ratingScale: ['pass', 'partial', 'fail', 'unknown'], criteria: [
        { key: 'persisted-outcome', title: 'Persisted outcome', model: 'The canonical bar is durably persisted and immediately readable.', method: 'Run the exact roundtrip fixture.', driftMarkers: 'The read misses the committed value.' },
        { key: 'visible-outcome', title: 'Visible outcome', model: 'The live service exposes the current verdict and its exact revision.', method: 'Read the service verdict and compare the revision.', driftMarkers: 'The response names an older revision.' },
      ] };
    expect(buildAcceptanceBarSeed({ ...input, planContent: plan(), existingTemplateData: existing }).ok).toBe(false);
    const map = { 'R-1': 'persisted-outcome', 'R-2': 'visible-outcome' };
    const built = buildAcceptanceBarSeed({ ...input, planContent: plan(), existingTemplateData: existing,
      backfilled: true, legacyCriterionMap: map });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    expect(built.criteria[0]).toMatchObject({ ...existing.criteria[0], barKey: 'R-1',
      passRatings: ['pass'], barProvenance: { lifecycle: 'legacy-backfilled' } });
    expect(built.templateData.barContract).toMatchObject({ cohort: 'post-epoch' });
    expect(buildAcceptanceBarSeed({ ...input, planContent: plan(), existingTemplateData: existing,
      backfilled: true, legacyCriterionMap: { 'R-1': 'persisted-outcome', 'R-2': 'persisted-outcome' } }).ok).toBe(false);
    expect(buildAcceptanceBarSeed({ ...input, planContent: plan(), existingTemplateData: built.templateData,
      backfilled: true, legacyCriterionMap: map }).ok).toBe(false);
  });

  it('creates one mandatory outcome per requirement and one hash-pinned clause per map edge', () => {
    const built = buildAcceptanceBarSeed({ ...input, planContent: plan() });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.criteria).toHaveLength(2);
    expect(built.criteria[0]).toMatchObject({
      key: 'r-1',
      barKey: 'R-1',
      role: 'outcome',
      mandatory: true,
      requiredScope: ['tree'],
      evidencePlane: 'tree',
      passRatings: ['healthy'],
      barProvenance: {
        lifecycle: 'pre-implementation',
        declaredAt: input.declaredAt,
        declaredBy: input.actorId,
      },
    });
    expect(built.criteria[0]?.method).toBeUndefined();
    expect(built.projections).toHaveLength(3);
    expect(built.projections[0]).toMatchObject({
      specId: 'AUTO-BAR-R-1-P-001',
      planItemId: 'P-001',
      requiredEvidence: ['tree'],
      lifecycleStatus: 'draft',
      sourceBar: {
        barKey: 'R-1',
        barSetHash: built.barSetHash,
        rubricSlug: input.rubricSlug,
        rubricRevision: 1,
        evidencePlane: 'tree',
      },
    });
    expect(built.templateData).toMatchObject({
      kind: 'acceptance',
      subjectPlan: 'seed-target',
      barSetHash: built.barSetHash,
      barContract: {
        schemaVersion: 1,
        adoptionEpoch: 1,
        subjectPlanRevision: 7,
      },
    });
  });

  it('preserves METHOD fields only when the canonical BAR hash is unchanged', () => {
    const first = buildAcceptanceBarSeed({ ...input, planContent: plan() });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const existing = {
      ...first.templateData,
      criteria: first.criteria.map((criterion) =>
        criterion.barKey === 'R-1'
          ? { ...criterion, method: 'Run the focused test.', check: { kind: 'requirements' } }
          : criterion,
      ),
    };
    const second = buildAcceptanceBarSeed({ ...input, planContent: plan(), existingTemplateData: existing });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.criteria[0]).toMatchObject({ method: 'Run the focused test.', check: { kind: 'requirements' } });

    const changed = buildAcceptanceBarSeed({
      ...input,
      planContent: plan({
        requirements: `**R-1 — First outcome.** The canonical promise changed.

**R-2 — Runtime outcome.** The live service exposes the current verdict.`,
      }),
      existingTemplateData: existing,
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.criteria[0]?.method).toBeUndefined();
  });

  it('derives an order-independent set hash and refuses an unmapped bar', () => {
    const built = buildAcceptanceBarSeed({
      ...input,
      planContent: plan({ map: '| R-1 | P-001 | tree |' }),
    });
    expect(built).toMatchObject({
      ok: false,
      error: 'bar_mapping_missing',
      problems: expect.arrayContaining([expect.objectContaining({ barKey: 'R-2' })]),
    });

    const a = { key: 'a', barKey: 'R-1', barHash: 'a'.repeat(64) };
    const b = { key: 'b', barKey: 'R-2', barHash: 'b'.repeat(64) };
    expect(computeAcceptanceBarSetHash([a, b])).toBe(computeAcceptanceBarSetHash([b, a]));
  });

  it.each(['draft', 'ready', 'active'])('preserves approved BARs pinned to the current %s subject revision', (planStatus) => {
    const seeded = buildAcceptanceBarSeed({ ...input, planContent: plan(), planStatus });
    if (!seeded.ok) throw new Error(seeded.message);
    const criteria = seeded.criteria.map((criterion) => normalizeAcceptanceBarCriterion({
      ...criterion,
      intent: { request: 'Preserve the complete original request.', constraints: ['Keep the original proof plane.'] },
      model: `The approved ${criterion.barKey} outcome is delivered.`,
      driftMarkers: `The approved ${criterion.barKey} outcome is missing.`,
      requiredTestLayers: ['integration'],
      method: 'Exercise the complete writer and reader with an isolated fixture.',
    }));
    const approved = { ...seeded.templateData, criteria, barSetHash: computeAcceptanceBarSetHash(criteria) };
    expect(approved.barSetHash).not.toBe(seeded.barSetHash);

    const current = buildAcceptanceBarSeed({
      ...input, planContent: plan(), planStatus, existingTemplateData: approved,
    });
    if (!current.ok) throw new Error(current.message);
    expect(current.criteria).toEqual(criteria);
    expect(current.barSetHash).toBe(approved.barSetHash);
    expect(current.projections.every((clause) => clause.requiredTestLayers?.includes('integration'))).toBe(true);
    expect(() => guardAcceptanceBarTemplateDataWrite({
      slug: input.rubricSlug, storedTemplateData: approved, nextTemplateData: current.templateData,
      subjectPlan: { status: planStatus, revision: input.subjectPlanRevision, adoptionEpoch: 1, cohort: 'post-epoch' },
      actorId: input.actorId,
    })).not.toThrow();

    const unapprovedRevision = buildAcceptanceBarSeed({
      ...input, planContent: plan(), planStatus, existingTemplateData: approved,
      subjectPlanRevision: input.subjectPlanRevision + 1,
    });
    if (!unapprovedRevision.ok) throw new Error(unapprovedRevision.message);
    expect(() => guardAcceptanceBarTemplateDataWrite({
      slug: input.rubricSlug, storedTemplateData: approved, nextTemplateData: unapprovedRevision.templateData,
      subjectPlan: { status: planStatus, revision: input.subjectPlanRevision + 1, adoptionEpoch: 1, cohort: 'post-epoch' },
      actorId: input.actorId,
    })).toThrow('BAR meaning cannot change outside rubrics:amend');
  });
});
