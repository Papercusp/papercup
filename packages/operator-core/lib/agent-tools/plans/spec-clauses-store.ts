/** Canonical first-class plan spec clause storage (P-002 / D-001..D-003). */
import { createHash } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import { resolvePlanScope } from './source';

export const SPEC_BEHAVIOR_CLASSES = [
  'happy-path',
  'boundary',
  'failure',
  'authorization',
  'concurrency',
  'lifecycle',
  'observability',
  'migration-data-integrity',
  'non-automated',
] as const;
export type SpecBehaviorClass = (typeof SPEC_BEHAVIOR_CLASSES)[number];

export const SPEC_LIFECYCLE_STATUSES = [
  'draft',
  'accepted',
  'active',
  'superseded',
  'exempt',
  'retired',
] as const;
export type SpecLifecycleStatus = (typeof SPEC_LIFECYCLE_STATUSES)[number];

export interface SpecClauseWrite {
  harnessSlug?: string;
  planSlug: string;
  specId: string;
  expectedRevision: number;
  sourceValId?: string | null;
  planItemId: string;
  behavior: string;
  behaviorClass: SpecBehaviorClass;
  requiredEvidence?: string[];
  requiredTestLayers?: string[];
  mutationRequired?: boolean;
  lifecycleStatus: SpecLifecycleStatus;
  supersedes?: { specId: string; revision: number } | null;
  exemption?: Record<string, unknown> | null;
  acceptanceRef?: string | null;
  actorId: string;
}

export interface SpecClauseRevision {
  planSlug: string;
  specId: string;
  sourceValId: string | null;
  currentRevision: number;
  revision: number;
  planItemId: string;
  behavior: string;
  behaviorClass: SpecBehaviorClass;
  requiredEvidence: string[];
  requiredTestLayers: string[];
  mutationRequired: boolean;
  lifecycleStatus: SpecLifecycleStatus;
  supersedes: { specId: string; revision: number } | null;
  exemption: Record<string, unknown> | null;
  contentHash: string;
  createdBy: string;
  createdAt: string;
  acceptedBy: string | null;
  acceptedAt: string | null;
  acceptanceRef: string | null;
}

export type SetSpecClauseResult =
  | { status: 'created' | 'revised'; specId: string; revision: number; contentHash: string }
  | { status: 'unchanged'; specId: string; revision: number; contentHash: string }
  | { status: 'conflict'; specId: string; expectedRevision: number; actualRevision: number }
  | { status: 'source_alias_immutable'; specId: string; sourceValId: string | null };

function normalizedSet(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))].sort();
}

function canonicalWrite(input: SpecClauseWrite) {
  return {
    planItemId: input.planItemId,
    behavior: input.behavior.trim(),
    behaviorClass: input.behaviorClass,
    requiredEvidence: normalizedSet(input.requiredEvidence),
    requiredTestLayers: normalizedSet(input.requiredTestLayers),
    mutationRequired: input.mutationRequired ?? false,
    lifecycleStatus: input.lifecycleStatus,
    supersedes: input.supersedes ?? null,
    exemption: input.exemption ?? null,
    acceptanceRef: input.acceptanceRef?.trim() || null,
  };
}

export function specClauseContentHash(input: SpecClauseWrite): string {
  return createHash('sha256').update(JSON.stringify(canonicalWrite(input))).digest('hex');
}

interface IdentityRow {
  source_val_id: string | null;
  current_revision: number;
}

/** Append one immutable revision under an optimistic expectedRevision CAS. */
export async function setSpecClause(input: SpecClauseWrite): Promise<SetSpecClauseResult> {
  const scope = await resolvePlanScope({ harnessSlug: input.harnessSlug });
  const normalized = canonicalWrite(input);
  const contentHash = specClauseContentHash(input);

  return withWorkspace(scope.workspaceId, async (tx) => {
    const lockKey = `${scope.workspaceId}:${scope.harnessSlug}:${input.planSlug}:${input.specId}`;
    await tx`SELECT pg_advisory_xact_lock(hashtext('plan_spec_clause'), hashtext(${lockKey}))`;

    const identities = await tx<IdentityRow[]>`
      SELECT source_val_id, current_revision
        FROM harness_shared.plan_spec_clauses
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${input.planSlug}
         AND spec_id = ${input.specId}
       FOR UPDATE`;
    const identity = identities[0];
    const actualRevision = Number(identity?.current_revision ?? 0);
    if (input.expectedRevision !== actualRevision) {
      return { status: 'conflict', specId: input.specId, expectedRevision: input.expectedRevision, actualRevision };
    }
    if (identity && input.sourceValId !== undefined && (input.sourceValId ?? null) !== identity.source_val_id) {
      return { status: 'source_alias_immutable', specId: input.specId, sourceValId: identity.source_val_id };
    }

    if (identity) {
      const current = await tx<{ content_hash: string }[]>`
        SELECT content_hash
          FROM harness_shared.plan_spec_clause_revisions
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND plan_slug = ${input.planSlug}
           AND spec_id = ${input.specId}
           AND revision = ${actualRevision}`;
      if (current[0]?.content_hash === contentHash) {
        return { status: 'unchanged', specId: input.specId, revision: actualRevision, contentHash };
      }
    } else {
      await tx`
        INSERT INTO harness_shared.plan_spec_clauses (
          workspace_id, harness_slug, plan_slug, spec_id, source_val_id,
          current_revision, created_by
        ) VALUES (
          ${scope.workspaceId}, ${scope.harnessSlug}, ${input.planSlug}, ${input.specId},
          ${input.sourceValId ?? null}, 0, ${input.actorId}
        )`;
    }

    const revision = actualRevision + 1;
    const accepted = normalized.lifecycleStatus === 'accepted' || normalized.lifecycleStatus === 'active';
    const rows = await tx<{ created_at: Date; accepted_at: Date | null }[]>`
      INSERT INTO harness_shared.plan_spec_clause_revisions (
        workspace_id, harness_slug, plan_slug, spec_id, revision, plan_item_id,
        behavior, behavior_class, required_evidence, required_test_layers,
        mutation_required, lifecycle_status, supersedes_spec_id, supersedes_revision,
        exemption, content_hash, created_by, accepted_by, accepted_at, acceptance_ref
      ) VALUES (
        ${scope.workspaceId}, ${scope.harnessSlug}, ${input.planSlug}, ${input.specId}, ${revision},
        ${normalized.planItemId}, ${normalized.behavior}, ${normalized.behaviorClass},
        ${normalized.requiredEvidence}, ${normalized.requiredTestLayers}, ${normalized.mutationRequired},
        ${normalized.lifecycleStatus}, ${normalized.supersedes?.specId ?? null},
        ${normalized.supersedes?.revision ?? null}, ${normalized.exemption}, ${contentHash},
        ${input.actorId}, ${accepted ? input.actorId : null}, ${accepted ? new Date() : null},
        ${normalized.acceptanceRef}
      ) RETURNING created_at, accepted_at`;

    await tx`
      UPDATE harness_shared.plan_spec_clauses
         SET current_revision = ${revision}, updated_at = now()
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${input.planSlug}
         AND spec_id = ${input.specId}`;

    const sourceValId = identity?.source_val_id ?? input.sourceValId ?? null;
    if (sourceValId) {
      await tx`
        INSERT INTO harness_shared.harness_plan_assertions (
          workspace_id, harness_slug, val_id, plan_slug, item_id,
          verify_text, evidence_text, status, requires_test
        ) VALUES (
          ${scope.workspaceId}, ${scope.harnessSlug}, ${sourceValId}, ${input.planSlug},
          ${normalized.planItemId}, ${normalized.behavior}, ${normalized.requiredEvidence.join('; ')},
          'todo', ${normalized.requiredTestLayers.length > 0}
        )
        ON CONFLICT (workspace_id, harness_slug, val_id) DO UPDATE SET
          plan_slug = EXCLUDED.plan_slug,
          item_id = EXCLUDED.item_id,
          verify_text = EXCLUDED.verify_text,
          evidence_text = EXCLUDED.evidence_text,
          requires_test = EXCLUDED.requires_test,
          updated_at = now()`;
    }

    void rows;
    return { status: actualRevision === 0 ? 'created' : 'revised', specId: input.specId, revision, contentHash };
  });
}

interface RevisionRow {
  plan_slug: string;
  spec_id: string;
  source_val_id: string | null;
  current_revision: number;
  revision: number;
  plan_item_id: string;
  behavior: string;
  behavior_class: SpecBehaviorClass;
  required_evidence: string[];
  required_test_layers: string[];
  mutation_required: boolean;
  lifecycle_status: SpecLifecycleStatus;
  supersedes_spec_id: string | null;
  supersedes_revision: number | null;
  exemption: Record<string, unknown> | null;
  content_hash: string;
  created_by: string;
  created_at: Date;
  accepted_by: string | null;
  accepted_at: Date | null;
  acceptance_ref: string | null;
}

export interface ListSpecClausesOptions {
  harnessSlug?: string;
  planSlug: string;
  specIds?: string[];
  sourceValIds?: string[];
  planItemIds?: string[];
  revision?: number;
  includeHistory?: boolean;
}

/** Exact structured read; current-only unless includeHistory or revision is requested. */
export async function listSpecClauses(options: ListSpecClausesOptions): Promise<SpecClauseRevision[]> {
  const scope = await resolvePlanScope({ harnessSlug: options.harnessSlug });
  const rows = await withWorkspace(scope.workspaceId, async (tx) => tx<RevisionRow[]>`
    SELECT c.plan_slug, c.spec_id, c.source_val_id, c.current_revision,
           r.revision, r.plan_item_id, r.behavior, r.behavior_class,
           r.required_evidence, r.required_test_layers, r.mutation_required,
           r.lifecycle_status, r.supersedes_spec_id, r.supersedes_revision,
           r.exemption, r.content_hash, r.created_by, r.created_at,
           r.accepted_by, r.accepted_at, r.acceptance_ref
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
       AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id
     WHERE c.workspace_id = ${scope.workspaceId}
       AND c.harness_slug = ${scope.harnessSlug}
       AND c.plan_slug = ${options.planSlug}
     ORDER BY c.spec_id, r.revision`);

  const specIds = options.specIds ? new Set(options.specIds) : null;
  const valIds = options.sourceValIds ? new Set(options.sourceValIds) : null;
  const itemIds = options.planItemIds ? new Set(options.planItemIds) : null;
  return rows
    .filter((r) => !specIds || specIds.has(r.spec_id))
    .filter((r) => !valIds || (r.source_val_id !== null && valIds.has(r.source_val_id)))
    .filter((r) => !itemIds || itemIds.has(r.plan_item_id))
    .filter((r) => options.revision !== undefined
      ? Number(r.revision) === options.revision
      : options.includeHistory || Number(r.revision) === Number(r.current_revision))
    .map((r) => ({
      planSlug: r.plan_slug,
      specId: r.spec_id,
      sourceValId: r.source_val_id,
      currentRevision: Number(r.current_revision),
      revision: Number(r.revision),
      planItemId: r.plan_item_id,
      behavior: r.behavior,
      behaviorClass: r.behavior_class,
      requiredEvidence: r.required_evidence,
      requiredTestLayers: r.required_test_layers,
      mutationRequired: r.mutation_required,
      lifecycleStatus: r.lifecycle_status,
      supersedes: r.supersedes_spec_id && r.supersedes_revision
        ? { specId: r.supersedes_spec_id, revision: Number(r.supersedes_revision) }
        : null,
      exemption: r.exemption,
      contentHash: r.content_hash,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
      acceptedBy: r.accepted_by,
      acceptedAt: r.accepted_at?.toISOString() ?? null,
      acceptanceRef: r.acceptance_ref,
    }));
}
