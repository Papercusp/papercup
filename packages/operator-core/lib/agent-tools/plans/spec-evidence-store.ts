/** Exact work-item/spec-revision coverage and immutable evidence bindings (P-005). */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { withWorkspace } from '@papercusp/db-org';
import { pgTimestampToIso } from '../../pg-timestamp';
import { planItemRef } from '../../issue-blocks-merge';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { ADHOC_WORK_ITEM_SPEC_SCOPE, resolveSpecScopeSlug } from './adhoc-spec-scope';
import type { SpecClauseSql } from './spec-clauses-store';
import { resolvePlanScope } from './source';

export { ADHOC_WORK_ITEM_SPEC_SCOPE };

export const SPEC_EVIDENCE_KINDS = [
  'test',
  'fixture',
  'coverage-census',
  'mutation',
  'counterexample',
  'check',
  'manual',
  'operational',
] as const;
export type SpecEvidenceKind = (typeof SPEC_EVIDENCE_KINDS)[number];

const evidenceFingerprintSchema = z.string().trim().min(1).max(256);
const repoMeasurementPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.startsWith('./') &&
      !value.includes('\\') &&
      !value.split('/').some((part) => part === '' || part === '.' || part === '..'),
    'measurement paths must be normalized repo-relative POSIX file paths',
  );

export const repoFilesEvidenceMeasurementSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('repo-files'),
    sourcePaths: z.array(repoMeasurementPathSchema).min(1).max(32),
    testPaths: z.array(repoMeasurementPathSchema).min(1).max(32).optional(),
  })
  .strict();

export type RepoFilesEvidenceMeasurement = z.infer<typeof repoFilesEvidenceMeasurementSchema>;

export interface MeasuredRepoEvidenceFingerprints {
  sourceFingerprint: string;
  testFingerprint: string | null;
}

const MAX_REPO_MEASUREMENT_BYTES = 8 * 1024 * 1024;

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function fingerprintRepoFileSet(repoRoot: string, declaredPaths: readonly string[]): Promise<string> {
  const root = await realpath(repoRoot);
  const paths = [...new Set(declaredPaths)].sort();
  const entries: Array<{ path: string; sha256: string }> = [];
  let totalBytes = 0;
  for (const path of paths) {
    const candidate = resolve(root, path);
    if (!containedBy(root, candidate)) throw new Error(`repo_measurement_path_outside_root:${path}`);
    const canonical = await realpath(candidate);
    if (!containedBy(root, canonical)) throw new Error(`repo_measurement_symlink_outside_root:${path}`);
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error(`repo_measurement_not_file:${path}`);
    totalBytes += info.size;
    if (totalBytes > MAX_REPO_MEASUREMENT_BYTES) {
      throw new Error(`repo_measurement_too_large:${totalBytes}>${MAX_REPO_MEASUREMENT_BYTES}`);
    }
    const content = await readFile(canonical);
    entries.push({ path, sha256: createHash('sha256').update(content).digest('hex') });
  }
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return `sha256-file-set-v1:${digest}`;
}

/** Recompute a bounded repository-backed evidence tuple from the current harness tree. */
export async function measureRepoFilesEvidenceAtRoot(
  repoRoot: string,
  measurement: RepoFilesEvidenceMeasurement,
): Promise<MeasuredRepoEvidenceFingerprints> {
  const parsed = repoFilesEvidenceMeasurementSchema.parse(measurement);
  const [sourceFingerprint, testFingerprint] = await Promise.all([
    fingerprintRepoFileSet(repoRoot, parsed.sourcePaths),
    parsed.testPaths ? fingerprintRepoFileSet(repoRoot, parsed.testPaths) : Promise.resolve(null),
  ]);
  return { sourceFingerprint, testFingerprint };
}

async function resolveMeasurementRoot(workspaceId: string, harnessSlug: string): Promise<string> {
  const registry = await loadHarnessRegistry(workspaceId);
  const root = resolveHarnessContentPath(registry, harnessSlug);
  if (!root) throw new Error(`repo_measurement_harness_root_unavailable:${harnessSlug}`);
  return root;
}

/** Resolve the canonical harness checkout and measure the declared file sets there. */
export async function measureRepoFilesEvidence(
  workspaceId: string,
  harnessSlug: string,
  measurement: RepoFilesEvidenceMeasurement,
): Promise<MeasuredRepoEvidenceFingerprints> {
  return measureRepoFilesEvidenceAtRoot(await resolveMeasurementRoot(workspaceId, harnessSlug), measurement);
}

function measurementFromDetails(details: Record<string, unknown>): RepoFilesEvidenceMeasurement | null {
  const parsed = repoFilesEvidenceMeasurementSchema.safeParse(details.currentMeasurement);
  return parsed.success ? parsed.data : null;
}
/** Shared wire contract for an explicit comparison with currently measured proof. */
export const evidenceCurrentInputSchema = z.object({
  evidenceKind: z.enum(SPEC_EVIDENCE_KINDS),
  evidenceRef: z.string().trim().min(1).max(2000),
  sourceFingerprint: evidenceFingerprintSchema,
  testFingerprint: evidenceFingerprintSchema.nullable().optional(),
  fixtureFingerprint: evidenceFingerprintSchema.nullable().optional(),
  rubricFingerprint: evidenceFingerprintSchema.nullable().optional(),
  environmentFingerprint: evidenceFingerprintSchema.nullable().optional(),
});

export interface EvidenceFingerprints {
  sourceFingerprint: string;
  testFingerprint?: string | null;
  fixtureFingerprint?: string | null;
  rubricFingerprint?: string | null;
  environmentFingerprint?: string | null;
}

export interface BindSpecEvidenceInput extends EvidenceFingerprints {
  harnessSlug?: string;
  /**
   * The plan whose spec clause this evidence binds to. OPTIONAL as of P-022: omit it for
   * an ad-hoc work-item that belongs to no plan, and the binding is scoped to
   * {@link ADHOC_WORK_ITEM_SPEC_SCOPE} instead.
   *
   * D-018 records why this is resolved rather than made nullable: `plan_slug` is a PRIMARY
   * KEY column in all four tables of the spec chain and carries a composite FK that
   * terminates at `harness_plans`, so it can never hold NULL. The blocker was never the
   * column — it was that the API forced a caller with no plan to invent one.
  */
  planSlug?: string;
  workItemId: string;
  specId?: string;
  sourceValId?: string;
  specRevision?: number;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
  coverageEvidenceRef?: number | null;
  testRunId?: number | null;
  details?: Record<string, unknown>;
  observedAt?: string;
  actorId: string;
}

export type BindSpecEvidenceResult =
  | {
      status: 'created' | 'unchanged';
      id: number;
      workItemId: string;
      planSlug: string;
      specId: string;
      sourceValId: string | null;
      specRevision: number;
      specFingerprint: string;
      bindingFingerprint: string;
    }
  | { status: 'work_item_not_found'; workItemId: string }
  | { status: 'spec_not_found'; specId?: string; sourceValId?: string }
  | { status: 'spec_revision_not_found'; specId: string; specRevision: number }
  | { status: 'coverage_evidence_not_found'; coverageEvidenceRef: number }
  | { status: 'test_run_not_found'; testRunId: number };

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

const nullableTrimmed = (value: string | null | undefined): string | null => value?.trim() || null;

interface CanonicalBinding {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
  sourceFingerprint: string;
  testFingerprint: string | null;
  fixtureFingerprint: string | null;
  rubricFingerprint: string | null;
  environmentFingerprint: string | null;
  coverageEvidenceRef: number | null;
  testRunId: number | null;
  details: Record<string, unknown>;
}

export function specEvidenceBindingFingerprint(input: CanonicalBinding): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(input)))
    .digest('hex');
}

interface SpecIdentityRow {
  spec_id: string;
  source_val_id: string | null;
  current_revision: number;
}

interface SpecRevisionRow {
  content_hash: string;
}

/** Resolve the selector and append one idempotent exact evidence binding. */
export async function bindSpecEvidence(input: BindSpecEvidenceInput): Promise<BindSpecEvidenceResult> {
  const scope = await resolvePlanScope({ harnessSlug: input.harnessSlug });
  return withWorkspace(scope.workspaceId, async (tx) => {
    // P-022 / D-018: a caller with no plan gets the harness's shared ad-hoc spec scope
    // rather than being forced to invent a plan slug. Everything downstream then runs
    // unchanged, which is the point: no PK, FK, index or freshness invariant moves.
    const planSlug = await resolveSpecScopeSlug(tx, scope.workspaceId, scope.harnessSlug, input.planSlug);
    const lockKey = `${scope.workspaceId}:${scope.harnessSlug}:${input.workItemId}:${planSlug}:${input.specId ?? input.sourceValId}`;
    await tx`SELECT pg_advisory_xact_lock(hashtext('spec_evidence_binding'), hashtext(${lockKey}))`;

    const workItems = await tx<{ feature_id: string }[]>`
      SELECT feature_id
        FROM harness_shared.work_items
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND feature_id = ${input.workItemId}`;
    if (!workItems[0]) return { status: 'work_item_not_found', workItemId: input.workItemId };

    const identities = await tx<SpecIdentityRow[]>`
      SELECT spec_id, source_val_id, current_revision
        FROM harness_shared.plan_spec_clauses
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${planSlug}
         AND (${input.specId ?? null}::text IS NULL OR spec_id = ${input.specId ?? null})
         AND (${input.sourceValId ?? null}::text IS NULL OR source_val_id = ${input.sourceValId ?? null})`;
    const identity = identities[0];
    if (!identity) {
      return {
        status: 'spec_not_found',
        ...(input.specId ? { specId: input.specId } : {}),
        ...(input.sourceValId ? { sourceValId: input.sourceValId } : {}),
      };
    }

    const specRevision = input.specRevision ?? Number(identity.current_revision);
    const revisions = await tx<SpecRevisionRow[]>`
      SELECT content_hash
        FROM harness_shared.plan_spec_clause_revisions
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${planSlug}
         AND spec_id = ${identity.spec_id}
         AND revision = ${specRevision}`;
    const revision = revisions[0];
    if (!revision) return { status: 'spec_revision_not_found', specId: identity.spec_id, specRevision };

    if (input.coverageEvidenceRef != null) {
      const rows = await tx<{ id: number }[]>`
        SELECT e.id
          FROM harness_shared.coverage_evidence e
          JOIN harness_shared.testing_surfaces s ON s.id = e.surface_ref
         WHERE e.id = ${input.coverageEvidenceRef}
           AND s.workspace_id = ${scope.workspaceId}
           AND s.harness_slug = ${scope.harnessSlug}`;
      if (!rows[0]) {
        return { status: 'coverage_evidence_not_found', coverageEvidenceRef: input.coverageEvidenceRef };
      }
    }
    if (input.testRunId != null) {
      const rows = await tx<{ id: number }[]>`
        SELECT id FROM harness_shared.test_runs
         WHERE id = ${input.testRunId}
           AND workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}`;
      if (!rows[0]) return { status: 'test_run_not_found', testRunId: input.testRunId };
    }

    const canonical: CanonicalBinding = {
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
      workItemId: input.workItemId,
      planSlug: planSlug,
      specId: identity.spec_id,
      specRevision,
      specFingerprint: revision.content_hash,
      evidenceKind: input.evidenceKind,
      evidenceRef: input.evidenceRef.trim(),
      sourceFingerprint: input.sourceFingerprint.trim(),
      testFingerprint: nullableTrimmed(input.testFingerprint),
      fixtureFingerprint: nullableTrimmed(input.fixtureFingerprint),
      rubricFingerprint: nullableTrimmed(input.rubricFingerprint),
      environmentFingerprint: nullableTrimmed(input.environmentFingerprint),
      coverageEvidenceRef: input.coverageEvidenceRef ?? null,
      testRunId: input.testRunId ?? null,
      details: (canonicalJson(input.details ?? {}) ?? {}) as Record<string, unknown>,
    };
    const bindingFingerprint = specEvidenceBindingFingerprint(canonical);

    await tx`
      INSERT INTO harness_shared.work_item_spec_revision_edges (
        workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
        spec_revision, spec_fingerprint, created_by
      ) VALUES (
        ${scope.workspaceId}, ${scope.harnessSlug}, ${input.workItemId}, ${planSlug},
        ${identity.spec_id}, ${specRevision}, ${revision.content_hash}, ${input.actorId}
      ) ON CONFLICT DO NOTHING`;

    const observedAt = input.observedAt ? new Date(input.observedAt) : new Date();
    const inserted = await tx<{ id: number }[]>`
      INSERT INTO harness_shared.spec_evidence_bindings (
        workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
        spec_revision, spec_fingerprint, evidence_kind, evidence_ref,
        source_fingerprint, test_fingerprint, fixture_fingerprint,
        rubric_fingerprint, environment_fingerprint, coverage_evidence_ref,
        test_run_id, details, observed_at, binding_fingerprint, created_by
      ) VALUES (
        ${scope.workspaceId}, ${scope.harnessSlug}, ${input.workItemId}, ${planSlug},
        ${identity.spec_id}, ${specRevision}, ${revision.content_hash}, ${input.evidenceKind},
        ${canonical.evidenceRef}, ${canonical.sourceFingerprint}, ${canonical.testFingerprint},
        ${canonical.fixtureFingerprint}, ${canonical.rubricFingerprint},
        ${canonical.environmentFingerprint}, ${canonical.coverageEvidenceRef},
        ${canonical.testRunId}, ${JSON.stringify(canonical.details)}::text::jsonb,
        ${observedAt}, ${bindingFingerprint}, ${input.actorId}
      ) ON CONFLICT (
        workspace_id, harness_slug, work_item_id,
        plan_slug, spec_id, spec_revision, binding_fingerprint
      ) DO NOTHING
      RETURNING id`;

    const existing =
      inserted[0] ??
      (
        await tx<{ id: number }[]>`
      SELECT id FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND work_item_id = ${input.workItemId}
         AND plan_slug = ${planSlug}
         AND spec_id = ${identity.spec_id}
         AND spec_revision = ${specRevision}
         AND binding_fingerprint = ${bindingFingerprint}`
      )[0];
    if (!existing) throw new Error(`spec_evidence_binding_insert_failed:${bindingFingerprint}`);

    return {
      status: inserted[0] ? 'created' : 'unchanged',
      id: Number(existing.id),
      workItemId: input.workItemId,
      planSlug: planSlug,
      specId: identity.spec_id,
      sourceValId: identity.source_val_id,
      specRevision,
      specFingerprint: revision.content_hash,
      bindingFingerprint,
    };
  });
}

export type FingerprintState = 'current' | 'stale' | 'unknown' | 'not-applicable';
export interface EvidenceCurrentInput extends EvidenceFingerprints {
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
}

/**
 * Provenance of the comparison used to classify a binding. Public tool inputs are
 * necessarily caller-attested: the caller supplies both fingerprints and the
 * comparison request. Only an internal server-measured path may establish a fresh
 * verdict.
 */
export type EvidenceCurrentnessProvenance =
  | 'server-measured'
  | 'partially-server-measured'
  | 'attested-current'
  | 'not-supplied';

type OpaqueFingerprintDimension = 'fixture' | 'rubric' | 'environment';

/** Trust metadata for the current-fingerprint tuple used by the classifier. */
interface CurrentnessClassificationOptions {
  provenance?: 'server-measured';
  /** Applicable non-repository dimensions supplied by the caller beside server measurements. */
  attestedDimensions?: OpaqueFingerprintDimension[];
}

/**
 * A scorecard referenced as proof can still be a provisional working note.
 * Keep the source card's identity and stamp alongside the boolean flag so an
 * adequacy reader can audit the dependency without a second work-item lookup.
 */
export interface ProvisionalScorecardProof {
  issueId: string;
  stampedAt: string;
  violatableKeys: string[];
}

export interface EvidenceCurrentness {
  overall: Exclude<FingerprintState, 'not-applicable'>;
  dimensions: {
    spec: Exclude<FingerprintState, 'unknown' | 'not-applicable'>;
    source: Exclude<FingerprintState, 'not-applicable'>;
    test: FingerprintState;
    fixture: FingerprintState;
    rubric: FingerprintState;
    environment: FingerprintState;
    coverageEvidence: FingerprintState;
    testRun: FingerprintState;
  };
  staleReasons: string[];
  unknownReasons: string[];
  /**
   * Whether the CALLER actually supplied a current-fingerprint input for this row.
   *
   * WHY THIS EXISTS. `unknown` is produced by `compareFingerprint(stored, undefined)`,
   * i.e. by the caller not asking — not by anything uncertain about the evidence. A
   * reader that supplies no `current` therefore gets `unknown` on every row with a
   * stored fingerprint, and `source_fingerprint` is NOT NULL, so that is EVERY row.
   * Consumers which gate on uncertainty must distinguish "asked and got a gap" from
   * "never asked"; without this flag the two are indistinguishable and a gate reading
   * `unknown` as doubt becomes a constant refusal (WI-2146375).
   */
  comparisonSupplied: boolean;
  /**
   * Caller-supplied matching fingerprints are explicitly attested-current and are
   * capped at aggregate `unknown`; equality alone is not an independent measurement.
   */
  /** Optional only for legacy hand-built/internal fixtures; the classifier always emits it. */
  provenance?: EvidenceCurrentnessProvenance;
}

interface CurrentnessRow {
  spec_is_current: boolean;
  source_fingerprint: string;
  test_fingerprint: string | null;
  fixture_fingerprint: string | null;
  rubric_fingerprint: string | null;
  environment_fingerprint: string | null;
  coverage_evidence_ref: number | null;
  coverage_evidence_present: boolean;
  test_run_id: number | null;
  test_run_present: boolean;
}

function compareFingerprint(stored: string | null, current: string | null | undefined): FingerprintState {
  if (stored === null) return 'not-applicable';
  if (current == null) return 'unknown';
  return stored === current ? 'current' : 'stale';
}

/** Pure, four-state currentness classifier; no drifting boolean is persisted. */
export function classifySpecEvidenceCurrentness(
  row: CurrentnessRow,
  current?: EvidenceCurrentInput,
  options: CurrentnessClassificationOptions = {},
): EvidenceCurrentness {
  const dimensions: EvidenceCurrentness['dimensions'] = {
    spec: row.spec_is_current ? 'current' : 'stale',
    source: compareFingerprint(row.source_fingerprint, current?.sourceFingerprint) as 'current' | 'stale' | 'unknown',
    test: compareFingerprint(row.test_fingerprint, current?.testFingerprint),
    fixture: compareFingerprint(row.fixture_fingerprint, current?.fixtureFingerprint),
    rubric: compareFingerprint(row.rubric_fingerprint, current?.rubricFingerprint),
    environment: compareFingerprint(row.environment_fingerprint, current?.environmentFingerprint),
    coverageEvidence:
      row.coverage_evidence_ref === null ? 'not-applicable' : row.coverage_evidence_present ? 'current' : 'stale',
    testRun: row.test_run_id === null ? 'not-applicable' : row.test_run_present ? 'current' : 'stale',
  };
  const staleReasons = Object.entries(dimensions)
    .filter(([, state]) => state === 'stale')
    .map(([dimension]) => `${dimension}-stale`);
  const unknownReasons = Object.entries(dimensions)
    .filter(([, state]) => state === 'unknown')
    .map(([dimension]) => `${dimension}-current-fingerprint-not-supplied`);
  const attestedDimensions = [...new Set(options.attestedDimensions ?? [])].sort();
  const provenance: EvidenceCurrentnessProvenance =
    current === undefined
      ? 'not-supplied'
      : options.provenance === 'server-measured' && attestedDimensions.length > 0
        ? 'partially-server-measured'
        : options.provenance ?? 'attested-current';
  const attestedCurrentGuard =
    (provenance === 'attested-current' || provenance === 'partially-server-measured') && staleReasons.length === 0
      ? [
          provenance === 'partially-server-measured'
            ? `current-fingerprints-partially-attested-not-independently-measured:${attestedDimensions.join(',')}`
            : 'current-fingerprints-attested-not-independently-measured',
        ]
      : [];
  const guardedUnknownReasons = [...unknownReasons, ...attestedCurrentGuard];
  return {
    overall: staleReasons.length > 0 ? 'stale' : guardedUnknownReasons.length > 0 ? 'unknown' : 'current',
    dimensions,
    staleReasons,
    unknownReasons: guardedUnknownReasons,
    comparisonSupplied: current != null,
    provenance,
  };
}

interface EvidenceRow extends CurrentnessRow {
  id: number;
  work_item_id: string;
  plan_slug: string;
  spec_id: string;
  source_val_id: string | null;
  spec_revision: number;
  current_revision: number;
  spec_fingerprint: string;
  evidence_kind: SpecEvidenceKind;
  evidence_ref: string;
  details: Record<string, unknown>;
  observed_at: Date | string;
  binding_fingerprint: string;
  created_by: string;
  created_at: Date | string;
  provisionalProofBase?: boolean;
  provisionalScorecard?: ProvisionalScorecardProof;
}

function scorecardIssueIdFromEvidenceRef(evidenceRef: string): string | null {
  const match = /^scorecard:([^#\s]+)(?:#.*)?$/.exec(evidenceRef.trim());
  return match?.[1] ?? null;
}

function parseProvisionalScorecardProof(issueId: string, value: unknown): ProvisionalScorecardProof | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const violatableKeys = Array.isArray(raw.violatableKeys)
    ? raw.violatableKeys.filter((key): key is string => typeof key === 'string' && key.trim() !== '')
    : [];
  if (violatableKeys.length === 0 || typeof raw.stampedAt !== 'string' || raw.stampedAt.trim() === '') return null;
  return { issueId, stampedAt: raw.stampedAt, violatableKeys };
}

export interface ListSpecEvidenceOptions {
  harnessSlug?: string;
  /**
   * The plan namespaces to read evidence from — an ARRAY, not a single slug, since P-013.
   *
   * WHY IT HAD TO WIDEN. D-012/D-013 made a work item's contract span plan namespaces: an
   * edge can name a clause in a plan the item is not stamped with. Once the completion
   * gate ENFORCES those cross-namespace clauses (P-013), a single-plan evidence read makes
   * every one of them find ZERO rows and refuse SPURIOUSLY — the gate would demand proof it
   * had just made itself unable to see. So the enforced clause set and the evidence read
   * must be scoped by the SAME set of namespaces, always.
   *
   * It is one query with `plan_slug = ANY(...)`, deliberately, not an N-plan fan-out: the
   * 1000-row safety limit callers apply is a limit on the WHOLE selection, and N separate
   * capped queries cannot honour one shared cap.
   *
   * An EMPTY array selects nothing, which is the honest reading of "no eligible namespace".
   */
  planSlugs: string[];
  workItemIds?: string[];
  specIds?: string[];
  sourceValIds?: string[];
  evidenceKinds?: SpecEvidenceKind[];
  evidenceRefs?: string[];
  current?: EvidenceCurrentInput[];
  currentness?: Array<'current' | 'stale' | 'unknown'>;
  limit?: number;
}

export interface WorkItemSpecRevisionEdge {
  workItemId: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
}

export interface EnsureWorkItemSpecRevisionEdgesInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  planItemIds: readonly string[];
  workItemId: string;
  actorId: string;
}

async function writeWorkItemSpecRevisionEdges(
  input: EnsureWorkItemSpecRevisionEdgesInput,
  tx: SpecClauseSql,
): Promise<WorkItemSpecRevisionEdge[]> {
  const planItemIds = [...new Set(input.planItemIds.map((id) => id.trim()).filter(Boolean))];
  if (planItemIds.length === 0) return [];

  await tx`
    INSERT INTO harness_shared.work_item_spec_revision_edges (
      workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
      spec_revision, spec_fingerprint, created_by
    )
    SELECT c.workspace_id, c.harness_slug, ${input.workItemId}, c.plan_slug,
           c.spec_id, c.current_revision, r.content_hash, ${input.actorId}
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = c.workspace_id
       AND r.harness_slug = c.harness_slug
       AND r.plan_slug = c.plan_slug
       AND r.spec_id = c.spec_id
       AND r.revision = c.current_revision
     WHERE c.workspace_id = ${input.workspaceId}
       AND c.harness_slug = ${input.harnessSlug}
       AND c.plan_slug = ${input.planSlug}
       AND r.plan_item_id = ANY(${planItemIds}::text[])
    ON CONFLICT DO NOTHING`;

  const rows = await tx<{
    work_item_id: string;
    plan_slug: string;
    spec_id: string;
    spec_revision: number | string;
    spec_fingerprint: string;
  }[]>`
    SELECT work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint
      FROM harness_shared.work_item_spec_revision_edges
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${input.harnessSlug}
       AND work_item_id = ${input.workItemId}
       AND plan_slug = ${input.planSlug}
     ORDER BY spec_id, spec_revision`;
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    planSlug: row.plan_slug,
    specId: row.spec_id,
    specRevision: Number(row.spec_revision),
    specFingerprint: row.spec_fingerprint,
  }));
}

/**
 * Attach a promoted work-item to every current spec revision owned by its plan
 * item.  Promotion is the first moment the canonical work-item id exists, so
 * this is the join that turns activation's BAR/spec projection into an
 * executable behavior contract.  The edge is append-only: a later clause
 * revision gets a new edge, while old edges remain auditable and are reported
 * stale by the resolver.
 */
export async function ensureWorkItemSpecRevisionEdges(
  input: EnsureWorkItemSpecRevisionEdgesInput,
): Promise<WorkItemSpecRevisionEdge[]> {
  return withWorkspace(input.workspaceId, async (tx) => {
    return writeWorkItemSpecRevisionEdges(input, tx as unknown as SpecClauseSql);
  });
}

/**
 * Attach current clause revisions to every already-existing work-item that
 * names one of the supplied plan items. Activation can run after promotion,
 * so this repair must cover terminal rows as well as live rows and must not
 * mint a replacement work-item. All provenance legs are read in the same
 * caller-supplied transaction as the BAR/spec writes.
 */
export async function ensureExistingWorkItemSpecRevisionEdgesInTransaction(
  input: Omit<EnsureWorkItemSpecRevisionEdgesInput, 'workItemId'>,
  tx: SpecClauseSql,
): Promise<WorkItemSpecRevisionEdge[]> {
  const planItemIds = [...new Set(input.planItemIds.map((id) => id.trim()).filter(Boolean))];
  if (planItemIds.length === 0) return [];

  // The feature-family coord plane historically lives in `default`, while
  // issue-family links follow the active workspace when COORD_PER_WORKSPACE is
  // enabled. Read both without changing the scheduler or claim specification.
  const coordWorkspaceIds = [...new Set([input.workspaceId, DEFAULT_COORD_WORKSPACE])];
  const planItemRefs = planItemIds.map((itemId) => planItemRef(input.planSlug, itemId));
  const rows = await tx<{ work_item_id: string; plan_item_id: string }[]>`
    WITH provenance AS (
      SELECT wi.feature_id AS work_item_id,
             source_item.item_id AS plan_item_id
        FROM harness_shared.work_items wi
        CROSS JOIN LATERAL unnest(COALESCE(wi.source_plan_item_ids, ARRAY[]::text[]))
          AS source_item(item_id)
       WHERE wi.workspace_id = ANY(${coordWorkspaceIds}::text[])
         AND wi.harness_slug = ${input.harnessSlug}
         AND wi.source_plan_slug = ${input.planSlug}
      UNION
      SELECT wi.feature_id AS work_item_id,
             wi.payload->'plan_item'->>'item_id' AS plan_item_id
        FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ANY(${coordWorkspaceIds}::text[])
         AND wi.harness_slug = ${input.harnessSlug}
         AND wi.payload->'plan_item'->>'plan_slug' = ${input.planSlug}
      UNION
      SELECT wi.feature_id AS work_item_id,
             split_part(l.dst_ref, '#', 2) AS plan_item_id
        FROM harness_shared.coord_links l
        JOIN harness_shared.work_items wi
          ON wi.workspace_id = l.workspace_id
         AND wi.harness_slug = ${input.harnessSlug}
         AND (
           (l.src_kind = 'issue' AND wi.feature_id = l.src_ref)
           OR (
             l.src_kind = 'feature'
             AND wi.feature_id = split_part(l.src_ref, '#', 2)
             AND wi.harness_slug = split_part(l.src_ref, '#', 1)
           )
         )
       WHERE l.workspace_id = ANY(${coordWorkspaceIds}::text[])
         AND l.rel = ANY(${['implements', 'relates']}::text[])
         AND l.dst_kind = 'plan_item'
         AND l.dst_ref = ANY(${planItemRefs}::text[])
    )
    SELECT DISTINCT work_item_id, plan_item_id
      FROM provenance
     WHERE plan_item_id = ANY(${planItemIds}::text[])
     ORDER BY work_item_id, plan_item_id`;

  const planItemsByWorkItem = new Map<string, string[]>();
  for (const row of rows) {
    const ids = planItemsByWorkItem.get(row.work_item_id) ?? [];
    if (!ids.includes(row.plan_item_id)) ids.push(row.plan_item_id);
    planItemsByWorkItem.set(row.work_item_id, ids);
  }

  const edges: WorkItemSpecRevisionEdge[] = [];
  for (const [workItemId, workItemPlanItemIds] of planItemsByWorkItem) {
    edges.push(...await writeWorkItemSpecRevisionEdges({
      ...input,
      planItemIds: workItemPlanItemIds,
      workItemId,
    }, tx));
  }
  return edges;
}

/** Read the explicit many-to-many coverage edges for one work item. */
export async function listWorkItemSpecRevisionEdges(options: {
  harnessSlug?: string;
  /**
   * OMIT to read every namespace. D-013: a work item may link to clauses in any
   * plan namespace regardless of its own source-plan provenance, so the universal
   * resolver needs the unscoped read. Widened here rather than added as a sibling
   * reader — two readers over one edge table is how the two drift apart.
   */
  planSlug?: string;
  workItemId: string;
}): Promise<WorkItemSpecRevisionEdge[]> {
  const scope = await resolvePlanScope({ harnessSlug: options.harnessSlug });
  const planSlug = options.planSlug;
  const rows = await withWorkspace(
    scope.workspaceId,
    async (tx) => tx<{
      work_item_id: string;
      plan_slug: string;
      spec_id: string;
      spec_revision: number;
      spec_fingerprint: string;
    }[]>`
      SELECT work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint
        FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND work_item_id = ${options.workItemId}
         ${planSlug === undefined ? tx`` : tx`AND plan_slug = ${planSlug}`}
       ORDER BY plan_slug, spec_id, spec_revision`,
  );
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    planSlug: row.plan_slug,
    specId: row.spec_id,
    specRevision: Number(row.spec_revision),
    specFingerprint: row.spec_fingerprint,
  }));
}

export async function listSpecEvidence(options: ListSpecEvidenceOptions) {
  // No namespace selected can never match a row, so say so without a round-trip. Kept
  // explicit rather than leaning on `= ANY('{}')`: a reader must not have to know that
  // Postgres happens to return nothing, and the alternative reading — an empty filter
  // meaning "every plan" — is the exact silent-widening this whole plan exists to remove.
  if (options.planSlugs.length === 0) return [];
  const scope = await resolvePlanScope({ harnessSlug: options.harnessSlug });
  const planSlugs = options.planSlugs;
  const workItemIds = options.workItemIds ?? [];
  const specIds = options.specIds ?? [];
  const sourceValIds = options.sourceValIds ?? [];
  const evidenceKinds = options.evidenceKinds ?? [];
  const evidenceRefs = options.evidenceRefs ?? [];
  const limit = options.limit ?? 200;
  const rows = await withWorkspace(
    scope.workspaceId,
    async (tx) => {
      const rows = await tx<EvidenceRow[]>`
    SELECT b.id, b.work_item_id, b.plan_slug, b.spec_id, c.source_val_id,
           b.spec_revision, c.current_revision, b.spec_fingerprint,
           b.evidence_kind, b.evidence_ref, b.source_fingerprint,
           b.test_fingerprint, b.fixture_fingerprint, b.rubric_fingerprint,
           b.environment_fingerprint, b.coverage_evidence_ref, b.test_run_id,
           b.details, b.observed_at, b.binding_fingerprint, b.created_by, b.created_at,
           (b.spec_revision = c.current_revision AND b.spec_fingerprint = r.content_hash) AS spec_is_current,
           (b.coverage_evidence_ref IS NOT NULL AND EXISTS (
              SELECT 1 FROM harness_shared.coverage_evidence ce
              JOIN harness_shared.testing_surfaces s ON s.id = ce.surface_ref
             WHERE ce.id = b.coverage_evidence_ref
               AND s.workspace_id = b.workspace_id AND s.harness_slug = b.harness_slug
           )) AS coverage_evidence_present,
           (b.test_run_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM harness_shared.test_runs tr
               WHERE tr.id = b.test_run_id
                 AND tr.workspace_id = b.workspace_id AND tr.harness_slug = b.harness_slug
           )) AS test_run_present
      FROM harness_shared.spec_evidence_bindings b
      JOIN harness_shared.plan_spec_clauses c
        ON c.workspace_id = b.workspace_id AND c.harness_slug = b.harness_slug
       AND c.plan_slug = b.plan_slug AND c.spec_id = b.spec_id
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = b.workspace_id AND r.harness_slug = b.harness_slug
       AND r.plan_slug = b.plan_slug AND r.spec_id = b.spec_id
       AND r.revision = b.spec_revision
     WHERE b.workspace_id = ${scope.workspaceId}
       AND b.harness_slug = ${scope.harnessSlug}
       AND b.plan_slug = ANY(${planSlugs}::text[])
       AND (${workItemIds.length} = 0 OR b.work_item_id = ANY(${workItemIds}::text[]))
       AND (${specIds.length} = 0 OR b.spec_id = ANY(${specIds}::text[]))
       AND (${sourceValIds.length} = 0 OR c.source_val_id = ANY(${sourceValIds}::text[]))
       AND (${evidenceKinds.length} = 0 OR b.evidence_kind = ANY(${evidenceKinds}::text[]))
       AND (${evidenceRefs.length} = 0 OR b.evidence_ref = ANY(${evidenceRefs}::text[]))
     ORDER BY b.observed_at DESC, b.id DESC
      LIMIT ${limit}`;
      const scorecardIds = [
        ...new Set(
          rows
            .map((row) => scorecardIssueIdFromEvidenceRef(row.evidence_ref))
            .filter((issueId): issueId is string => issueId !== null),
        ),
      ];
      if (scorecardIds.length === 0) return rows;

      const scorecards = await tx<{ feature_id: string; provisional: unknown }[]>`
        SELECT feature_id, payload -> 'observation' -> 'provisional' AS provisional
          FROM harness_shared.work_items
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND feature_id = ANY(${scorecardIds}::text[])
           AND payload -> 'observation' -> 'provisional' IS NOT NULL`;
      const provisionalById = new Map<string, ProvisionalScorecardProof>();
      for (const scorecard of scorecards) {
        const proof = parseProvisionalScorecardProof(scorecard.feature_id, scorecard.provisional);
        if (proof) provisionalById.set(scorecard.feature_id, proof);
      }
      return rows.map((row) => {
        const issueId = scorecardIssueIdFromEvidenceRef(row.evidence_ref);
        const provisionalScorecard = issueId ? provisionalById.get(issueId) : undefined;
        return provisionalScorecard
          ? { ...row, provisionalProofBase: true, provisionalScorecard }
          : row;
      });
    },
  );

  const currentByRef = new Map((options.current ?? []).map((c) => [`${c.evidenceKind}\0${c.evidenceRef}`, c]));
  const measurementRoot = rows.some((row) => measurementFromDetails(row.details))
    ? resolveMeasurementRoot(scope.workspaceId, scope.harnessSlug)
    : null;
  const serverMeasurements = await Promise.all(
    rows.map(async (row) => {
      const recipe = measurementFromDetails(row.details);
      if (!recipe) return null;
      try {
        const measured = await measureRepoFilesEvidenceAtRoot(await measurementRoot!, recipe);
        return {
          status: 'measured' as const,
          current: {
            evidenceKind: row.evidence_kind,
            evidenceRef: row.evidence_ref,
            ...measured,
          } satisfies EvidenceCurrentInput,
        };
      } catch (error: unknown) {
        return {
          status: 'unavailable' as const,
          reason: (error instanceof Error ? error.message : String(error)).slice(0, 240),
        };
      }
    }),
  );
  const classified = rows.map((row, index) => {
    const measured = serverMeasurements[index];
    const callerCurrent = currentByRef.get(`${row.evidence_kind}\0${row.evidence_ref}`);
    const attestedDimensions: OpaqueFingerprintDimension[] =
      measured?.status === 'measured'
        ? [
            ...(row.fixture_fingerprint !== null && callerCurrent?.fixtureFingerprint != null
              ? (['fixture'] as const)
              : []),
            ...(row.rubric_fingerprint !== null && callerCurrent?.rubricFingerprint != null
              ? (['rubric'] as const)
              : []),
            ...(row.environment_fingerprint !== null && callerCurrent?.environmentFingerprint != null
              ? (['environment'] as const)
              : []),
          ]
        : [];
    const current =
      measured?.status === 'measured'
        ? { ...callerCurrent, ...measured.current }
        : callerCurrent;
    const currentness = classifySpecEvidenceCurrentness(
      row,
      current,
      measured?.status === 'measured' ? { provenance: 'server-measured', attestedDimensions } : {},
    );
    if (measured?.status === 'unavailable' && currentness.overall === 'unknown') {
      currentness.unknownReasons = [...currentness.unknownReasons, `server-measurement-unavailable:${measured.reason}`];
    }
    return {
      id: Number(row.id),
      workItemId: row.work_item_id,
      planSlug: row.plan_slug,
      specId: row.spec_id,
      sourceValId: row.source_val_id,
      specRevision: Number(row.spec_revision),
      currentRevision: Number(row.current_revision),
      specFingerprint: row.spec_fingerprint,
      evidenceKind: row.evidence_kind,
      evidenceRef: row.evidence_ref,
      fingerprints: {
        sourceFingerprint: row.source_fingerprint,
        testFingerprint: row.test_fingerprint,
        fixtureFingerprint: row.fixture_fingerprint,
        rubricFingerprint: row.rubric_fingerprint,
        environmentFingerprint: row.environment_fingerprint,
      },
      coverageEvidenceRef: row.coverage_evidence_ref === null ? null : Number(row.coverage_evidence_ref),
      testRunId: row.test_run_id === null ? null : Number(row.test_run_id),
      details: row.provisionalProofBase
        ? {
            ...row.details,
            provisionalProofBase: true,
            ...(row.provisionalScorecard ? { provisionalScorecard: row.provisionalScorecard } : {}),
          }
        : row.details,
      ...(row.provisionalProofBase ? { provisionalProofBase: true } : {}),
      ...(row.provisionalScorecard ? { provisionalScorecard: row.provisionalScorecard } : {}),
      observedAt: pgTimestampToIso(row.observed_at),
      bindingFingerprint: row.binding_fingerprint,
      createdBy: row.created_by,
      createdAt: pgTimestampToIso(row.created_at),
      ...(measured
        ? {
            serverMeasurement:
              measured.status === 'measured'
                ? {
                    status: measured.status,
                    measuredDimensions: [
                      'source',
                      ...(measured.current.testFingerprint === null ? [] : ['test']),
                    ],
                    ...(attestedDimensions.length > 0 ? { attestedDimensions } : {}),
                  }
                : measured,
          }
        : {}),
      currentness,
    };
  });
  const allowed = options.currentness ? new Set(options.currentness) : null;
  return allowed ? classified.filter((row) => allowed.has(row.currentness.overall)) : classified;
}
