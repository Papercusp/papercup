import { describe, expect, it } from 'vitest';
import {
  buildAcceptanceBarSeed,
  parseBarMappings,
  parseRequirementBars,
} from './acceptance-bar-seed';
import { computeAcceptanceBarSetHash } from './rubrics';

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
  it('adopts explicitly mapped legacy criteria without losing their identity, stronger outcomes or METHODS', () => {
    const existing = { kind: 'acceptance', subjectPlan: input.planSlug, characteristic: 'plan-acceptance',
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'], criteria: [
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
      barProvenance: { lifecycle: 'legacy-backfilled' } });
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
});
