/**
 * P-001 characterization, NOT acceptance of the old behavior.
 *
 * The first two tests intentionally measure the pre-change workflow. P-002
 * replaces their expectations, not their inputs; retain this run's receipt for
 * before/after comparison. Counts below are oracle/handler calls in a hermetic
 * fixture, NOT network round trips, fleet telemetry, elapsed user time, or a
 * claim that the whole imported source tree was pinned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { evaluatePlanStartReadiness } from './plan-input-validation';
import { computeSpecSetHash } from './spec-clause-compiler';
import { evaluatePlanSpecQuality } from './spec-quality';
import { evaluatePlanSpecQualityGate } from './plan-spec-quality-gate';
import {
  metadataClause, metadataClauseWrite, metadataHarness, metadataInputSchema, metadataPlanSlug,
} from './coordination-metadata-fixtures';
import { specClauseContentHash } from './spec-clauses-store';

// Real evaluator/tool/validators; only store IO is replaced. Unexpected store
// access fails instead of falling through to the shared workspace database.
const stores = vi.hoisted(() => ({
  readPlan: vi.fn(),
  listClauses: vi.fn(),
  listRubrics: vi.fn(),
}));
vi.mock('./source', async (importOriginal) => ({
  ...await importOriginal<typeof import('./source')>(),
  readPlanBySlug: stores.readPlan,
}));
vi.mock('./spec-clauses-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('./spec-clauses-store')>(),
  listSpecClauses: stores.listClauses,
}));
vi.mock('../../rubrics', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../rubrics')>(),
  getAcceptanceRubricsForPlan: stores.listRubrics,
}));

import evaluateTool from './evaluate-spec-quality';

const context: UnifiedToolContext = {
  harnessSlug: metadataHarness,
  workspaceId: 'metadata-fixture-workspace',
  log: () => {},
  signal: new AbortController().signal,
  progress: () => {},
  emit: () => {},
};

beforeEach(() => {
  vi.resetAllMocks();
  stores.readPlan.mockResolvedValue({
    row: {
      items: [{ id: 'P-001' }],
      template: null,
      inputSchema: metadataInputSchema.inputSchema,
      templateData: { attempts: 'invalid' },
    },
    parsed: { items: [{ id: 'P-001' }] },
  });
  stores.listClauses.mockResolvedValue([metadataClause()]);
  stores.listRubrics.mockImplementation(() => {
    throw new Error('unexpected acceptance-rubric IO: inject the test dependency');
  });
});

describe('P-001 pre-change workflow measurements', () => {
  it('needs three readiness oracle calls to discover, repair and confirm two input defects', () => {
    const calls = [
      evaluatePlanStartReadiness(metadataInputSchema, { attempts: 'invalid' }),
      evaluatePlanStartReadiness(metadataInputSchema, { harness: 'fixture', attempts: 'invalid' }),
      evaluatePlanStartReadiness(metadataInputSchema, { harness: 'fixture', attempts: 1 }),
    ];
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ ready: false, code: 'missing_required', missing: ['harness'], issues: [] });
    expect(calls[1]).toMatchObject({ ready: false, code: 'invalid_data', missing: [] });
    expect(calls[2]).toEqual({ ready: true, source: 'input-schema' });
  });

  it('currently produces a spec-quality draft despite invalid start inputs and no persisted class lookup', async () => {
    const args = evaluateTool.args.parse({
      harness: metadataHarness, slug: metadataPlanSlug, classRef: 'plan-class-feature-ship',
    });
    const result = await evaluateTool.handler(args, context);
    expect(evaluatePlanStartReadiness(metadataInputSchema, { attempts: 'invalid' }).ready).toBe(false);
    expect(result).toMatchObject({ data: { ok: true, verdict: 'pass', scorecardDraft: { rubricRef: 'spec-quality' } } });
    expect(stores.readPlan).toHaveBeenCalledTimes(1);
    expect(stores.listClauses).toHaveBeenCalledTimes(1);
    expect(stores.listRubrics).not.toHaveBeenCalled();
    // Explicitly supplied bookkeeping: one caller-selected class. P-002 target:
    // zero selections when the persisted policy has one unambiguous class.
    expect(Object.hasOwn(args, 'classRef')).toBe(true);
  });
});

describe('P-001 safety fixtures — remain enforced throughout implementation', () => {
  it.each([
    ['missing', [], 'spec_quality_class_missing'],
    ['ambiguous', [{ classRef: 'plan-class-feature-ship' }, { classRef: 'plan-class-bugfix' }], 'spec_quality_class_ambiguous'],
    ['invalid', [{ classRef: 'arbitrary-policy' }], 'spec_quality_class_invalid'],
  ] as const)('does not read or accept a scorecard for %s persisted class', async (_name, rubrics, code) => {
    const listCards = vi.fn(async () => []);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: metadataHarness, planSlug: metadataPlanSlug, planItemIds: ['P-001'] },
      { listClauses: async () => [metadataClause()], listAcceptanceRubrics: async () => rubrics, listCards },
    );
    expect(result).toMatchObject({ satisfied: false, code });
    expect(listCards).not.toHaveBeenCalled();
  });

  it('keeps an unavailable persisted policy distinct from a valid class', async () => {
    const listCards = vi.fn(async () => []);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: metadataHarness, planSlug: metadataPlanSlug, planItemIds: ['P-001'] },
      {
        listClauses: async () => [metadataClause()],
        listAcceptanceRubrics: async () => { throw new Error('policy unavailable'); },
        listCards,
      },
    );
    expect(result.satisfied).toBe(false);
    expect(listCards).not.toHaveBeenCalled();
  });

  it('already preserves semantic identity across formatting and storage revision changes', () => {
    const original = metadataClause();
    const formatted = metadataClause({
      behavior: '  POST /events returns 202 for a valid request  ',
      revision: 2, currentRevision: 2, contentHash: 'different-storage-hash',
    });
    expect(computeSpecSetHash([formatted])).toBe(computeSpecSetHash([original]));
    expect(specClauseContentHash(metadataClauseWrite({ behavior: formatted.behavior })))
      .toBe(specClauseContentHash(metadataClauseWrite()));
  });

  it.each([
    { behavior: 'POST /events returns 403 for a valid request' },
    { requiredTestLayers: ['unit'] },
    { requiredEvidence: ['different-source-receipt'] },
    { acceptanceRef: `${metadataPlanSlug}#D-002` },
    { mutationRequired: true },
  ])('invalidates semantic identity for substantive change %j', (change) => {
    expect(computeSpecSetHash([metadataClause(change)]))
      .not.toBe(computeSpecSetHash([metadataClause()]));
  });

  it('keeps policy class in the reviewed subject even when clause semantics are identical', () => {
    const input = {
      planSlug: metadataPlanSlug, harnessSlug: metadataHarness,
      planItemIds: ['P-001'], clauses: [metadataClause()],
    };
    const feature = evaluatePlanSpecQuality({ ...input, classRef: 'plan-class-feature-ship' });
    const bugfix = evaluatePlanSpecQuality({ ...input, classRef: 'plan-class-bugfix' });
    expect(feature.specSetHash).toBe(bugfix.specSetHash);
    expect(feature.scorecardDraft.subject.ref).not.toBe(bugfix.scorecardDraft.subject.ref);
    expect(bugfix.wouldBlock).toContain('plan-class-specialization');
  });
});
