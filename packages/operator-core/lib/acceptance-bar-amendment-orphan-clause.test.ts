import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ setSpecClause: vi.fn() }));

vi.mock('./agent-tools/plans/spec-clauses-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/plans/spec-clauses-store')>()),
  setSpecClause: h.setSpecClause,
}));

import { synchronizeAcceptanceBarRevision } from './acceptance-bar-amendment';
import { buildAcceptanceBarSeed } from './acceptance-bar-seed';

// Mirrors the fixture in acceptance-bar-amendment.test.ts. R-1 mapped to P-001 is what
// makes the canonical identity `AUTO-BAR-R-1-P-001` -- the exact clause that wedged the
// activation audit in EI-23816909807579931.
function subjectPlan(): string {
  return `---
title: Subject plan
slug: subject-plan
status: active
created: 2026-09-06
updated: 2026-09-06
---

# Subject plan

## Now

**State:** working

**Next:** keep going

## Requirements

**R-1 — Canonical outcome.** The writer persists one canonical BAR.

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |

## Phase 1 — Build

- **P-001** \`todo\` persist the canonical BAR
`;
}

function seedTemplateData() {
  const seeded = buildAcceptanceBarSeed({
    planSlug: 'subject-plan',
    planContent: subjectPlan(),
    actorId: 'seed-author',
    declaredAt: '2026-09-06T00:00:00.000Z',
    cohort: 'post-epoch',
    adoptionEpoch: 1,
    subjectPlanRevision: 2,
    planStatus: 'active',
    rubricSlug: 'acceptance-subject-plan',
    rubricRevision: 4,
  });
  if (!seeded.ok) throw new Error('fixture seed failed');
  return seeded.templateData;
}

/** One row of the clause-projection SELECT, defaulting to a healthy bar-linked clause. */
function clauseRow(overrides: Record<string, unknown> = {}) {
  return {
    spec_id: 'AUTO-BAR-R-1-P-001',
    source_val_id: null,
    current_revision: 1,
    source_bar_key: 'R-1',
    source_bar_hash: 'stored-bar-hash',
    plan_item_id: 'P-001',
    behavior: 'The writer persists one canonical BAR.',
    behavior_class: 'observable',
    falsifier: null,
    required_evidence: ['tree'],
    required_test_layers: [],
    mutation_required: false,
    lifecycle_status: 'active',
    supersedes_spec_id: null,
    supersedes_revision: null,
    exemption: null,
    ...overrides,
  };
}

/**
 * `rows` is what the clause-projection SELECT returns. The amendment re-reads that
 * projection after its repair pass, so `rowsAfterRepair` models the write landing --
 * without it a create is correctly reported as still-missing. Everything else is stubbed
 * to the minimum the transaction needs, so the only variable under test is what the
 * amendment believes about an already-stored clause.
 */
function sqlStub(rows: unknown[], rowsAfterRepair: unknown[] = rows) {
  let clauseReads = 0;
  const clauseQueries: Array<{ statement: string; values: unknown[] }> = [];
  const fn = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join(' ');
    if (statement.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
    if (statement.includes('SELECT plan_slug, content')) {
      return [{ plan_slug: 'subject-plan', content: subjectPlan() }];
    }
    if (statement.includes('FROM harness_shared.plan_spec_clauses c')) {
      clauseQueries.push({ statement, values });
      clauseReads += 1;
      return clauseReads === 1 ? rows : rowsAfterRepair;
    }
    return [];
  });
  return Object.assign(fn, { clauseQueries });
}

function runAmendment(sql: ReturnType<typeof sqlStub>) {
  return synchronizeAcceptanceBarRevision(sql as never, {
    workspaceId: 'workspace',
    harnessSlug: 'papercusp',
    rubricSlug: 'acceptance-subject-plan',
    rubricRevision: 4,
    templateData: seedTemplateData(),
    actorId: 'amender',
  });
}

function writeFor(specId: string) {
  return h.setSpecClause.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .find((write) => write.specId === specId);
}

// A clause whose current revision lost its bar linkage: a write that omitted `sourceBar`
// NULLed source_bar_key, but the row is emphatically present -- at revision 2.
const orphaned = () => clauseRow({ current_revision: 2, source_bar_key: null, source_bar_hash: null });

describe('AUTO-BAR clause whose bar linkage was lost (EI-23816909807579931)', () => {
  beforeEach(() => {
    h.setSpecClause.mockReset();
    h.setSpecClause.mockResolvedValue({
      status: 'revised', specId: 'AUTO-BAR-R-1-P-001', revision: 3,
    });
  });

  it('re-projects an existing clause at its REAL revision instead of creating it at 0', async () => {
    await runAmendment(sqlStub([orphaned()]));

    const write = writeFor('AUTO-BAR-R-1-P-001');
    expect(write).toBeDefined();
    // The defect: the clause was invisible to the projection query, so it was treated as
    // absent and written with expectedRevision 0 against a row at 2 -- a CAS conflict on
    // every retry, and the failing operation was the only one that could have healed it.
    expect(write!.expectedRevision).toBe(2);
  });

  it('restores the missing bar linkage rather than leaving the clause orphaned', async () => {
    await runAmendment(sqlStub([orphaned()]));

    const write = writeFor('AUTO-BAR-R-1-P-001');
    expect((write!.sourceBar as { barKey?: string } | undefined)?.barKey).toBe('R-1');
    // Healing must not silently demote a live clause back to draft: this one is active.
    expect(write!.lifecycleStatus).toBe('active');
  });

  it('still CREATES a genuinely absent clause at revision 0', async () => {
    // Calibration. Without this, widening clause ownership could pass the cases above
    // simply by never using 0 again -- which would break first-time projection instead.
    await runAmendment(sqlStub([], [clauseRow({ lifecycle_status: 'draft' })]));

    const write = writeFor('AUTO-BAR-R-1-P-001');
    expect(write).toBeDefined();
    expect(write!.expectedRevision).toBe(0);
    expect(write!.lifecycleStatus).toBe('draft');
  });

  it('asks the database for clauses by canonical identity, not by bar linkage alone', async () => {
    // The cases above stub the SELECT's result, so they pin the inference but cannot see
    // the predicate. In production the predicate is half the fix: filtering on
    // source_bar_key alone is what hid the row in the first place.
    const sql = sqlStub([orphaned()]);
    await runAmendment(sql);

    const [projection] = sql.clauseQueries;
    expect(projection).toBeDefined();
    expect(projection!.statement).toContain('c.spec_id = ANY(');
    expect(projection!.values.flat()).toContain('AUTO-BAR-R-1-P-001');
  });
});
