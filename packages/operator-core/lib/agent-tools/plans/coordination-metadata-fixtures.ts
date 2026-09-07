/**
 * Test-only representative inputs for coordination-metadata-friction-reduction,
 * P-001. No runtime consumer, IO, stored identities, or policy overrides.
 * Keep these inputs stable when replacing the pre-change characterization tests.
 */
import type { PlanSchemaRef } from './plan-input-validation';
import { specClauseContentHash, type SpecClauseRevision, type SpecClauseWrite } from './spec-clauses-store';

export const metadataPlanSlug = 'metadata-regression-fixture';
export const metadataHarness = 'metadata-test-harness';

export const metadataInputSchema: PlanSchemaRef = {
  template: null,
  inputSchema: {
    type: 'object',
    properties: { harness: { type: 'string', minLength: 1 }, attempts: { type: 'integer', minimum: 1 } },
    required: ['harness', 'attempts'],
    additionalProperties: false,
  },
};

export function metadataClauseWrite(overrides: Partial<SpecClauseWrite> = {}): SpecClauseWrite {
  return {
    planSlug: metadataPlanSlug,
    harnessSlug: metadataHarness,
    specId: 'SPEC-001-01',
    sourceValId: 'VAL-001-01',
    expectedRevision: 0,
    planItemId: 'P-001',
    behavior: 'POST /events returns 202 for a valid request',
    behaviorClass: 'happy-path',
    requiredEvidence: [],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    acceptanceRef: `${metadataPlanSlug}#D-001`,
    actorId: 'fixture-author',
    ...overrides,
  };
}

export function metadataClause(overrides: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  const write = metadataClauseWrite();
  return {
    planSlug: metadataPlanSlug,
    specId: write.specId,
    sourceValId: write.sourceValId ?? null,
    revision: 1,
    currentRevision: 1,
    planItemId: write.planItemId,
    behavior: write.behavior,
    behaviorClass: write.behaviorClass,
    requiredEvidence: [],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: specClauseContentHash(write),
    createdBy: 'fixture-author',
    createdAt: '2026-09-07T00:00:00.000Z',
    acceptedBy: 'fixture-reviewer',
    acceptedAt: '2026-09-07T00:01:00.000Z',
    acceptanceRef: write.acceptanceRef ?? null,
    ...overrides,
  };
}
