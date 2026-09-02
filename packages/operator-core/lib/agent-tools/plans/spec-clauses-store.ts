/** Canonical first-class plan spec clause storage (P-002 / D-001..D-003). */
import { createHash } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import { pgTimestampToIso, pgTimestampToIsoOrNull } from '../../pg-timestamp';
import { resolveSpecScopeSlug } from './adhoc-spec-scope';
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

export const SPEC_LIFECYCLE_STATUSES = ['draft', 'accepted', 'active', 'superseded', 'exempt', 'retired'] as const;
export type SpecLifecycleStatus = (typeof SPEC_LIFECYCLE_STATUSES)[number];

/**
 * D-016: the concrete observation that proves THIS clause violated.
 *
 * Falsifiability was already ENFORCED here (mutationRequired proves the covering
 * test can fail; behaviorClass forces breaking-condition clauses) but never
 * DECLARED — no field said what a violation would actually look like. Declaring it
 * makes adequacy mechanical (a test is adequate iff it can produce this
 * observation) and structurally filters vacuous clauses: no falsifier can be
 * written for "the system is robust".
 */
export interface SpecClauseFalsifier {
  /** What you would SEE if the promise were broken — not a restatement of the promise. */
  observation: string;
  /** How to produce that observation: the probe, mutation, or input that elicits it. */
  probeMethod?: string;
}

/** Write-side shape: JSON callers may spell an absent probeMethod as an explicit null. */
export interface SpecClauseFalsifierWrite {
  observation: string;
  probeMethod?: string | null;
}

export interface SpecClauseWrite {
  harnessSlug?: string;
  /**
   * The plan this clause belongs to. OPTIONAL as of P-022: omit it to author a clause for
   * an ad-hoc work-item that belongs to no plan, and it is scoped to
   * `ADHOC_WORK_ITEM_SPEC_SCOPE` instead (see `adhoc-spec-scope.ts` and D-018 for why the
   * scope is resolved rather than the column made nullable — `plan_slug` is a PRIMARY KEY
   * column in every table of this chain, so it can never hold NULL).
   */
  planSlug?: string;
  specId: string;
  expectedRevision: number;
  sourceValId?: string | null;
  /** In the ad-hoc scope this is the WORK-ITEM id, not a `P-NNN`; the row is created lazily. */
  planItemId: string;
  behavior: string;
  behaviorClass: SpecBehaviorClass;
  requiredEvidence?: string[];
  requiredTestLayers?: string[];
  mutationRequired?: boolean;
  lifecycleStatus: SpecLifecycleStatus;
  supersedes?: { specId: string; revision: number } | null;
  exemption?: Record<string, unknown> | null;
  falsifier?: SpecClauseFalsifierWrite | null;
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
  /** D-016 declaration; NULL means undeclared, which is a gradeable gap — not a passing clause. */
  falsifier: SpecClauseFalsifier | null;
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
  | { status: 'source_alias_immutable'; specId: string; sourceValId: string | null }
  | {
      status: 'source_alias_conflict';
      specId: string;
      sourceValId: string;
      conflictingPlanSlug: string;
      conflictingSpecId: string;
    }
  | { status: 'falsifier_invalid'; specId: string; reason: FalsifierIssue }
  | { status: 'plan_not_found'; specId: string; planSlug: string }
  | { status: 'plan_item_not_found'; specId: string; planItemId: string }
  | { status: 'supersedes_not_found'; specId: string; supersedes: { specId: string; revision: number } };

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value;
}

function normalizedSet(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))].sort();
}

export type FalsifierIssue = 'not_an_object' | 'observation_blank' | 'probe_method_blank';

/**
 * Structured refusal for a MALFORMED declaration — never for an ABSENT one.
 *
 * Undeclared (undefined/null) is legal and reports honestly as a gradeable gap
 * (D-016 assigns concreteness grading to P-004, hard enforcement to P-013). But a
 * caller who supplied an object and got it silently dropped would believe they had
 * declared a falsifier when the row says nothing — the exact "reads as declared
 * while saying nothing" failure the column's blank-vs-NULL rule exists to prevent.
 * The DB CHECK is the backstop; this is the structured answer, in the same idiom as
 * this store's other refusals rather than an opaque 23514.
 */
function falsifierIssueOf(value: SpecClauseWrite['falsifier']): FalsifierIssue | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'not_an_object';
  const observation = typeof value.observation === 'string' ? value.observation.trim() : '';
  if (!observation) return 'observation_blank';
  const probe = value.probeMethod;
  if (probe !== undefined && probe !== null && (typeof probe !== 'string' || !probe.trim())) {
    return 'probe_method_blank';
  }
  return null;
}

function normalizedFalsifier(value: SpecClauseWrite['falsifier']): SpecClauseFalsifier | null {
  if (falsifierIssueOf(value) !== null || !value) return null;
  const observation = value.observation.trim();
  const probeMethod = typeof value.probeMethod === 'string' ? value.probeMethod.trim() : '';
  return probeMethod ? { observation, probeMethod } : { observation };
}

function canonicalWrite(input: SpecClauseWrite) {
  const falsifier = normalizedFalsifier(input.falsifier);
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
    // ABSENT when undeclared, deliberately not `falsifier: null`. A null key would
    // change the canonical JSON of every clause written before D-016, re-hashing the
    // whole corpus so each one's first no-op re-write returns `revised` and appends a
    // spurious revision. Declaring one still moves the hash (absent -> present), which
    // is the point: revising a falsifier appends a NEW immutable revision rather than
    // mutating a standing promise in place.
    ...(falsifier ? { falsifier } : {}),
    acceptanceRef: input.acceptanceRef?.trim() || null,
  };
}

export function specClauseContentHash(input: SpecClauseWrite): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(canonicalWrite(input))))
    .digest('hex');
}

interface IdentityRow {
  source_val_id: string | null;
  current_revision: number;
}

interface AliasIdentityRow {
  plan_slug: string;
  spec_id: string;
}

/** Append one immutable revision under an optimistic expectedRevision CAS. */
export async function setSpecClause(input: SpecClauseWrite): Promise<SetSpecClauseResult> {
  const falsifierIssue = falsifierIssueOf(input.falsifier);
  if (falsifierIssue) {
    return { status: 'falsifier_invalid', specId: input.specId, reason: falsifierIssue };
  }
  const scope = await resolvePlanScope({ harnessSlug: input.harnessSlug });
  const normalized = canonicalWrite(input);
  const falsifier = normalizedFalsifier(input.falsifier);
  const contentHash = specClauseContentHash(input);

  return withWorkspace(scope.workspaceId, async (tx) => {
    // P-022 / D-018: a clause for a work-item that belongs to no plan is authored into the
    // harness's shared ad-hoc spec scope. Resolved BEFORE the lock and the ownership check
    // below, because that check is exactly what the scope has to exist to satisfy.
    const planSlug = await resolveSpecScopeSlug(
      tx,
      scope.workspaceId,
      scope.harnessSlug,
      input.planSlug,
      normalized.planItemId,
    );
    const lockKey = `${scope.workspaceId}:${scope.harnessSlug}:${planSlug}:${input.specId}`;
    await tx`SELECT pg_advisory_xact_lock(hashtext('plan_spec_clause'), hashtext(${lockKey}))`;

    // The optional VAL alias has harness-wide uniqueness. Lock it independently
    // from the spec identity so two different specs racing for one alias resolve
    // to a structured conflict rather than an opaque 23505.
    if (input.sourceValId) {
      const aliasKey = `${scope.workspaceId}:${scope.harnessSlug}:${input.sourceValId}`;
      await tx`SELECT pg_advisory_xact_lock(hashtext('plan_spec_clause_alias'), hashtext(${aliasKey}))`;
    }

    const ownership = await tx<{ plan_exists: boolean; item_exists: boolean }[]>`
      SELECT
        EXISTS (
          SELECT 1 FROM harness_shared.harness_plans
           WHERE workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND plan_slug = ${planSlug}
        ) AS plan_exists,
        EXISTS (
          SELECT 1 FROM harness_shared.plan_items
           WHERE workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND plan_slug = ${planSlug}
             AND item_id = ${normalized.planItemId}
        ) AS item_exists`;
    if (!ownership[0]?.plan_exists) {
      return { status: 'plan_not_found', specId: input.specId, planSlug: planSlug };
    }
    if (!ownership[0]?.item_exists) {
      return { status: 'plan_item_not_found', specId: input.specId, planItemId: normalized.planItemId };
    }

    if (normalized.supersedes) {
      const target = await tx<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM harness_shared.plan_spec_clause_revisions
           WHERE workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND plan_slug = ${planSlug}
             AND spec_id = ${normalized.supersedes.specId}
             AND revision = ${normalized.supersedes.revision}
        ) AS exists`;
      if (!target[0]?.exists) {
        return {
          status: 'supersedes_not_found',
          specId: input.specId,
          supersedes: normalized.supersedes,
        };
      }
    }

    const identities = await tx<IdentityRow[]>`
      SELECT source_val_id, current_revision
        FROM harness_shared.plan_spec_clauses
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${planSlug}
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

    if (!identity && input.sourceValId) {
      const aliases = await tx<AliasIdentityRow[]>`
        SELECT plan_slug, spec_id
          FROM harness_shared.plan_spec_clauses
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND source_val_id = ${input.sourceValId}`;
      if (aliases[0]) {
        return {
          status: 'source_alias_conflict',
          specId: input.specId,
          sourceValId: input.sourceValId,
          conflictingPlanSlug: aliases[0].plan_slug,
          conflictingSpecId: aliases[0].spec_id,
        };
      }
    }

    if (identity) {
      const current = await tx<{ content_hash: string }[]>`
        SELECT content_hash
          FROM harness_shared.plan_spec_clause_revisions
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND plan_slug = ${planSlug}
           AND spec_id = ${input.specId}
           AND revision = ${actualRevision}`;
      if (current[0]?.content_hash === contentHash) {
        return { status: 'unchanged', specId: input.specId, revision: actualRevision, contentHash };
      }
    } else {
      const inserted = await tx<{ spec_id: string }[]>`
        INSERT INTO harness_shared.plan_spec_clauses (
          workspace_id, harness_slug, plan_slug, spec_id, source_val_id,
          current_revision, created_by
        ) VALUES (
          ${scope.workspaceId}, ${scope.harnessSlug}, ${planSlug}, ${input.specId},
          ${input.sourceValId ?? null}, 0, ${input.actorId}
        )
        ON CONFLICT DO NOTHING
        RETURNING spec_id`;
      if (!inserted[0]) {
        const raced = await tx<IdentityRow[]>`
          SELECT source_val_id, current_revision
            FROM harness_shared.plan_spec_clauses
           WHERE workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND plan_slug = ${planSlug}
             AND spec_id = ${input.specId}`;
        if (raced[0]) {
          return {
            status: 'conflict',
            specId: input.specId,
            expectedRevision: input.expectedRevision,
            actualRevision: Number(raced[0].current_revision),
          };
        }
        const aliases = input.sourceValId
          ? await tx<AliasIdentityRow[]>`
              SELECT plan_slug, spec_id
                FROM harness_shared.plan_spec_clauses
               WHERE workspace_id = ${scope.workspaceId}
                 AND harness_slug = ${scope.harnessSlug}
                 AND source_val_id = ${input.sourceValId}`
          : [];
        if (input.sourceValId && aliases[0]) {
          return {
            status: 'source_alias_conflict',
            specId: input.specId,
            sourceValId: input.sourceValId,
            conflictingPlanSlug: aliases[0].plan_slug,
            conflictingSpecId: aliases[0].spec_id,
          };
        }
        throw new Error(`plan_spec_clause_identity_insert_failed:${planSlug}:${input.specId}`);
      }
    }

    const revision = actualRevision + 1;
    const accepted = normalized.lifecycleStatus === 'accepted' || normalized.lifecycleStatus === 'active';
    const exemptionJson = normalized.exemption === null ? null : JSON.stringify(canonicalJson(normalized.exemption));
    const falsifierJson = falsifier === null ? null : JSON.stringify(canonicalJson(falsifier));
    await tx`
      INSERT INTO harness_shared.plan_spec_clause_revisions (
        workspace_id, harness_slug, plan_slug, spec_id, revision, plan_item_id,
        behavior, behavior_class, required_evidence, required_test_layers,
        mutation_required, lifecycle_status, supersedes_spec_id, supersedes_revision,
        exemption, falsifier, content_hash, created_by, accepted_by, accepted_at, acceptance_ref
      ) VALUES (
        ${scope.workspaceId}, ${scope.harnessSlug}, ${planSlug}, ${input.specId}, ${revision},
        ${normalized.planItemId}, ${normalized.behavior}, ${normalized.behaviorClass},
        ${normalized.requiredEvidence}, ${normalized.requiredTestLayers}, ${normalized.mutationRequired},
        ${normalized.lifecycleStatus}, ${normalized.supersedes?.specId ?? null},
        ${normalized.supersedes?.revision ?? null}, ${exemptionJson}::text::jsonb,
        ${falsifierJson}::text::jsonb, ${contentHash},
        ${input.actorId}, ${accepted ? input.actorId : null}, ${accepted ? new Date() : null},
        ${normalized.acceptanceRef}
      )`;

    await tx`
      UPDATE harness_shared.plan_spec_clauses
         SET current_revision = ${revision}, updated_at = now()
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${planSlug}
         AND spec_id = ${input.specId}`;

    const sourceValId = identity?.source_val_id ?? input.sourceValId ?? null;
    if (sourceValId) {
      await tx`
        INSERT INTO harness_shared.harness_plan_assertions (
          workspace_id, harness_slug, val_id, plan_slug, item_id,
          verify_text, evidence_text, status, requires_test
        ) VALUES (
          ${scope.workspaceId}, ${scope.harnessSlug}, ${sourceValId}, ${planSlug},
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
  falsifier: SpecClauseFalsifier | null;
  content_hash: string;
  created_by: string;
  created_at: Date | string;
  accepted_by: string | null;
  accepted_at: Date | string | null;
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
  const rows = await withWorkspace(
    scope.workspaceId,
    async (tx) => tx<RevisionRow[]>`
    SELECT c.plan_slug, c.spec_id, c.source_val_id, c.current_revision,
           r.revision, r.plan_item_id, r.behavior, r.behavior_class,
           r.required_evidence, r.required_test_layers, r.mutation_required,
           r.lifecycle_status, r.supersedes_spec_id, r.supersedes_revision,
           r.exemption, r.falsifier, r.content_hash, r.created_by, r.created_at,
           r.accepted_by, r.accepted_at, r.acceptance_ref
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
       AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id
     WHERE c.workspace_id = ${scope.workspaceId}
       AND c.harness_slug = ${scope.harnessSlug}
       AND c.plan_slug = ${options.planSlug}
     ORDER BY c.spec_id, r.revision`,
  );

  const specIds = options.specIds ? new Set(options.specIds) : null;
  const valIds = options.sourceValIds ? new Set(options.sourceValIds) : null;
  const itemIds = options.planItemIds ? new Set(options.planItemIds) : null;
  return rows
    .filter((r) => !specIds || specIds.has(r.spec_id))
    .filter((r) => !valIds || (r.source_val_id !== null && valIds.has(r.source_val_id)))
    .filter((r) => !itemIds || itemIds.has(r.plan_item_id))
    .filter((r) =>
      options.revision !== undefined
        ? Number(r.revision) === options.revision
        : options.includeHistory || Number(r.revision) === Number(r.current_revision),
    )
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
      supersedes:
        r.supersedes_spec_id && r.supersedes_revision
          ? { specId: r.supersedes_spec_id, revision: Number(r.supersedes_revision) }
          : null,
      exemption: r.exemption,
      falsifier: r.falsifier ?? null,
      contentHash: r.content_hash,
      createdBy: r.created_by,
      createdAt: pgTimestampToIso(r.created_at),
      acceptedBy: r.accepted_by,
      acceptedAt: pgTimestampToIsoOrNull(r.accepted_at),
      acceptanceRef: r.acceptance_ref,
    }));
}
