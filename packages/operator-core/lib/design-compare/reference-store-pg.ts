/**
 * The Postgres binding for the ratified-reference store.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-003).
 *
 * Deliberately thin. Every rule — validation, monotonicity, supersession,
 * staleness — lives in `reference-store.ts` and is unit-tested without a
 * database; this file only moves rows. The one thing it adds is the guarantee
 * the domain layer cannot provide on its own: the primary key
 * `(harness_slug, id)` on `harness_shared.harness_design_artifacts` refuses a
 * duplicate revision even when two agents read the same state and both decide
 * the same revision is next.
 *
 * It writes NO new table and defines NO DDL (storage policy: migrations only).
 * `kind='ratified_reference'` and `kind='compare_result'` were admitted by
 * migration 948.
 *
 * ─── WHAT IS AND IS NOT MUTATED ──────────────────────────────────────────────
 * `payload` is written once by `insert` and never updated. `setLifecycle`
 * touches `metadata` alone, and re-derives the WHOLE projection from the stored
 * payload rather than patching two fields, so metadata can never end up
 * describing a payload it has drifted from. That re-derivation is the reason
 * `setLifecycle` reads before it writes.
 */
import type {
  ReferenceScope,
  ReferenceStorePort,
  StoredEvidence,
  StoredEvidenceRef,
  StoredEvidenceRow,
  StoredReference,
  StoredReferenceRow,
} from './reference-store';
import {
  COMPARE_RESULT_ARTIFACT_KIND,
  RATIFIED_REFERENCE_ARTIFACT_KIND,
  ReferenceStoreError,
  environmentCaseKey,
  projectMetadata,
} from './reference-store';
import type { CompareResult } from './contract';
import type { RatifiedReference } from './ratification';

/**
 * The minimum surface this store needs from a `postgres` client — a tagged
 * template that returns rows. Typing it structurally keeps the module free of a
 * driver import, which is what lets a test bind a transaction handle directly.
 */
export type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

export interface PgReferenceStoreOptions {
  readonly sql: SqlTag;
  /** Wall clock, injectable so a test can assert the stored timestamp. */
  readonly now?: () => number;
}

interface ArtifactRow {
  id: string;
  harness_slug: string;
  feature_id: string;
  payload: StoredReference | string;
  created_ts: string | number;
}

interface EvidenceRow {
  id: string;
  payload: Record<string, unknown> | string;
}

interface EvidenceResultRow {
  id: string;
  harness_slug: string;
  feature_id: string;
  /**
   * The `CompareResult` itself, at the payload ROOT — not wrapped. That is the
   * shape `listEvidence`'s `payload->'reference'->>'referenceId'` filter has
   * always assumed, and `harness_slug` / `feature_id` are already columns, so a
   * wrapper would store them twice and put the reader's filter one hop wrong.
   */
  payload: CompareResult | string;
  created_ts: string | number;
}

function readJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function toRow(row: ArtifactRow): StoredReferenceRow {
  const payload = readJson<StoredReference>(row.payload);
  return {
    ...payload,
    artifactId: row.id,
    createdTs: Number(row.created_ts),
  };
}

/**
 * Read a stored `CompareResult` payload down to the two fields staleness needs.
 *
 * Tolerant on purpose: evidence written by an older schema version, or by a
 * path that stored a partial record, must still be VISIBLE to a staleness
 * query. Dropping an unparseable row would silently shrink the set of evidence
 * a revision is reported to have invalidated — which reads as "this revision
 * cost you nothing", the most reassuring possible wrong answer. A row we cannot
 * read a revision from is given `NaN`, which never equals the active revision
 * and is therefore always reported stale.
 */
function toEvidenceRef(row: EvidenceRow): StoredEvidenceRef {
  const payload = readJson<Record<string, unknown>>(row.payload);
  const reference = (payload.reference ?? {}) as Record<string, unknown>;
  return {
    artifactId: row.id,
    referenceId: typeof reference.referenceId === 'string' ? reference.referenceId : '',
    referenceRevision: typeof reference.revision === 'number' ? reference.revision : Number.NaN,
    capturedAt: typeof payload.capturedAt === 'string' ? payload.capturedAt : '',
  };
}

export function createPgReferenceStore(options: PgReferenceStoreOptions): ReferenceStorePort {
  const { sql } = options;
  const now = options.now ?? (() => Date.now());

  return {
    async listRevisions(scope: ReferenceScope): Promise<readonly StoredReferenceRow[]> {
      const rows = await sql<ArtifactRow>`
        SELECT id, harness_slug, feature_id, payload, created_ts
          FROM harness_shared.harness_design_artifacts
         WHERE harness_slug = ${scope.harnessSlug}
           AND feature_id   = ${scope.featureId}
           AND kind         = ${RATIFIED_REFERENCE_ARTIFACT_KIND}
           AND metadata->>'referenceId' = ${scope.referenceId}
         ORDER BY (metadata->>'revision')::int ASC
      `;
      return rows.map(toRow);
    },

    async insert(row: StoredReference & { readonly artifactId: string }): Promise<void> {
      const metadata = projectMetadata(row);
      try {
        await sql`
          INSERT INTO harness_shared.harness_design_artifacts
                 (id, harness_slug, feature_id, kind, payload, metadata, created_ts)
          VALUES (${row.artifactId}, ${row.harnessSlug}, ${row.featureId},
                  ${RATIFIED_REFERENCE_ARTIFACT_KIND},
                  ${JSON.stringify(row)}::jsonb, ${JSON.stringify(metadata)}::jsonb,
                  ${now()})
        `;
      } catch (error) {
        // The primary key is the concurrency guarantee (see the header). A
        // collision means a peer ratified this exact revision first, which is a
        // refusal the caller must see as one — not a 500.
        if (isUniqueViolation(error)) {
          throw new ReferenceStoreError(
            `revision already exists: artifact '${row.artifactId}' was written by another ratification first`,
            'revision-conflict',
          );
        }
        throw error;
      }
    },

    async setLifecycle(
      scope: ReferenceScope,
      artifactId: string,
      lifecycle: {
        readonly state: RatifiedReference['state'];
        readonly supersededByRevision?: number;
      },
    ): Promise<void> {
      const rows = await sql<ArtifactRow>`
        SELECT id, harness_slug, feature_id, payload, created_ts
          FROM harness_shared.harness_design_artifacts
         WHERE harness_slug = ${scope.harnessSlug}
           AND id           = ${artifactId}
           AND kind         = ${RATIFIED_REFERENCE_ARTIFACT_KIND}
      `;
      const existing = rows[0];
      if (!existing) {
        throw new ReferenceStoreError(
          `artifact '${artifactId}' not found for harness '${scope.harnessSlug}'`,
          'not-ratified',
        );
      }

      const stored = toRow(existing);
      // Re-derive the WHOLE projection from the untouched payload, so metadata
      // cannot drift from what it describes.
      const nextReference: RatifiedReference = {
        ...stored.reference,
        state: lifecycle.state,
        ...(lifecycle.supersededByRevision !== undefined
          ? { supersededByRevision: lifecycle.supersededByRevision }
          : {}),
      };
      const metadata = projectMetadata({ ...stored, reference: nextReference });

      // `payload` is deliberately absent from this UPDATE. Provenance is
      // written once; only the lifecycle projection moves.
      await sql`
        UPDATE harness_shared.harness_design_artifacts
           SET metadata = ${JSON.stringify(metadata)}::jsonb
         WHERE harness_slug = ${scope.harnessSlug}
           AND id           = ${artifactId}
      `;
    },

    async listEvidence(scope: ReferenceScope): Promise<readonly StoredEvidenceRef[]> {
      const rows = await sql<EvidenceRow>`
        SELECT id, payload
          FROM harness_shared.harness_design_artifacts
         WHERE harness_slug = ${scope.harnessSlug}
           AND feature_id   = ${scope.featureId}
           AND kind         = ${COMPARE_RESULT_ARTIFACT_KIND}
           AND payload->'reference'->>'referenceId' = ${scope.referenceId}
         ORDER BY created_ts ASC
      `;
      return rows.map(toEvidenceRef);
    },

    async insertEvidence(row: StoredEvidence & { readonly artifactId: string }): Promise<void> {
      const metadata = projectEvidenceMetadata(row.result);
      // Upsert, NOT the insert-or-conflict that `insert` uses. The id is derived
      // from the comparison's inputs (`evidenceArtifactId`), so a collision here
      // means the same comparison was run again — which supersedes its own
      // previous answer rather than racing another writer for a slot.
      //
      // `created_ts` is deliberately absent from the UPDATE: the row's identity
      // is the comparison, and a re-run must not reorder it against its peers.
      await sql`
        INSERT INTO harness_shared.harness_design_artifacts
               (id, harness_slug, feature_id, kind, payload, metadata, created_ts)
        VALUES (${row.artifactId}, ${row.harnessSlug}, ${row.featureId},
                ${COMPARE_RESULT_ARTIFACT_KIND},
                ${JSON.stringify(row.result)}::jsonb, ${JSON.stringify(metadata)}::jsonb,
                ${now()})
        ON CONFLICT (harness_slug, id) DO UPDATE
           SET payload  = EXCLUDED.payload,
               metadata = EXCLUDED.metadata
      `;
    },

    async listEvidenceResults(scope: ReferenceScope): Promise<readonly StoredEvidenceRow[]> {
      const rows = await sql<EvidenceResultRow>`
        SELECT id, harness_slug, feature_id, payload, created_ts
          FROM harness_shared.harness_design_artifacts
         WHERE harness_slug = ${scope.harnessSlug}
           AND feature_id   = ${scope.featureId}
           AND kind         = ${COMPARE_RESULT_ARTIFACT_KIND}
           AND payload->'reference'->>'referenceId' = ${scope.referenceId}
         ORDER BY created_ts ASC
      `;
      return rows.map((r) => ({
        result: readJson<CompareResult>(r.payload),
        harnessSlug: r.harness_slug,
        featureId: r.feature_id,
        artifactId: r.id,
        createdTs: Number(r.created_ts),
      }));
    },
  };
}

/**
 * The queryable projection for one evidence row.
 *
 * Same discipline as `projectMetadata`: every field is DERIVED from the payload
 * in exactly one place, so a filter on verdict or revision can never disagree
 * with the result it filtered to. `verdict` and `invalidReason` are projected
 * because "show me the failing evidence for this feature" is the query a review
 * surface actually runs, and making it decode every jsonb payload to answer
 * would be the drift-prone alternative.
 */
function projectEvidenceMetadata(result: CompareResult): Record<string, unknown> {
  return {
    schemaVersion: result.schemaVersion,
    referenceId: result.reference.referenceId,
    revision: result.reference.revision,
    referenceClass: result.reference.referenceClass,
    verdict: result.verdict,
    invalidReason: result.invalidReason ?? null,
    targetId: result.target.targetId,
    targetKind: result.target.targetKind,
    implementationRevision: result.target.implementationRevision,
    engine: result.engine.engine,
    engineVersion: result.engine.engineVersion,
    policyVersion: result.policy.policyVersion,
    diffRatio: result.diffRatio ?? null,
    capturedAt: result.capturedAt,
    environmentCaseKey: environmentCaseKey(result.environment),
  };
}

/** Postgres `unique_violation`. Matched on SQLSTATE, never on message text. */
function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === '23505';
}

/**
 * Read a stored reference's LIFECYCLE without loading its payload.
 *
 * The projection exists so this is one indexed jsonb read rather than a decode
 * of every revision's provenance. Exposed because P-006's plugin read wants
 * exactly this and nothing more.
 */
export async function readReferenceLifecycle(
  sql: SqlTag,
  scope: ReferenceScope,
): Promise<readonly { revision: number; state: string; supersededByRevision: number | null }[]> {
  const rows = await sql<{ metadata: Record<string, unknown> | string }>`
    SELECT metadata
      FROM harness_shared.harness_design_artifacts
     WHERE harness_slug = ${scope.harnessSlug}
       AND feature_id   = ${scope.featureId}
       AND kind         = ${RATIFIED_REFERENCE_ARTIFACT_KIND}
       AND metadata->>'referenceId' = ${scope.referenceId}
     ORDER BY (metadata->>'revision')::int ASC
  `;
  return rows.map((row) => {
    const metadata = readJson<Record<string, unknown>>(row.metadata);
    return {
      revision: Number(metadata.revision),
      state: String(metadata.state),
      supersededByRevision:
        typeof metadata.supersededByRevision === 'number' ? metadata.supersededByRevision : null,
    };
  });
}
