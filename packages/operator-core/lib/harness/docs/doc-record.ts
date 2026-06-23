/**
 * doc-record — typed read/write over harness_shared.harness_docs (mig 172).
 *
 * Plan: harness-docs-integration-2026-06-05 (P-002 / D-002 / D-007). PG is the
 * runtime store-of-record for the doc RECORD (metadata + augmented overlay +
 * derived freshness); the doc BODY stays a repo file (git sync authority). This
 * module is the only place that touches the table — every other layer (provenance
 * capture P-004, overlay P-005, manual anchoring P-006, the freshness sweep P-003,
 * the merged read P-007) goes through these helpers.
 *
 * Admin pool (getOrgPg, BYPASSRLS) + explicit workspace_id filter, mirroring the
 * harness_plans access pattern.
 *
 * `source` is kept consistent with the overlay automatically (D-003): a record
 * with a non-null overlay is ALWAYS `augmented`; without one it's `generated`
 * (when it has a generated_from_sha baseline) or `manual`. So a documenter
 * regeneration of an overlaid doc preserves both the overlay AND the augmented
 * source — it never silently downgrades to plain generated.
 */

import { getOrgPg } from '@papercusp/db-org';
import { resolveWorkspaceForHarness } from '../workspace-for-harness';
import type { SubjectRef } from './subject-ref';

export type DocSource = 'generated' | 'manual' | 'augmented';
export type DocStatus = 'fresh' | 'stale' | 'review' | 'untracked' | 'unknown';

export interface HarnessDocRecord {
  workspaceId: string;
  harnessSlug: string;
  docId: string;
  source: DocSource;
  subjectRef: SubjectRef[];
  anchorPaths: string[];
  generatedFromSha: string | null;
  lastVerifiedSha: string | null;
  lastVerifiedAt: string | null;
  overlay: string | null;
  status: DocStatus;
  statusDetail: string | null;
  statusCheckedAt: string | null;
  regenEnqueuedAt: string | null;
  reverifyFlaggedAt: string | null;
  /** Doc-steward dispatches in the CURRENT unhealed episode (reset to 0 on heal).
   *  Drives the backoff + give-up cap in the freshness sweep (mig 386). */
  regenAttempts: number;
  reverifyAttempts: number;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DocRow {
  workspace_id: string;
  harness_slug: string;
  doc_id: string;
  source: string;
  subject_ref: unknown;
  anchor_paths: string[];
  generated_from_sha: string | null;
  last_verified_sha: string | null;
  last_verified_at: Date | string | null;
  overlay: string | null;
  status: string;
  status_detail: string | null;
  status_checked_at: Date | string | null;
  regen_enqueued_at: Date | string | null;
  reverify_flagged_at: Date | string | null;
  regen_attempts: number | null;
  reverify_attempts: number | null;
  title: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const toIso = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

function rowToRecord(r: DocRow): HarnessDocRecord {
  const refs = Array.isArray(r.subject_ref) ? (r.subject_ref as SubjectRef[]) : [];
  return {
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    docId: r.doc_id,
    source: (r.source as DocSource) ?? 'manual',
    subjectRef: refs,
    anchorPaths: r.anchor_paths ?? [],
    generatedFromSha: r.generated_from_sha,
    lastVerifiedSha: r.last_verified_sha,
    lastVerifiedAt: toIso(r.last_verified_at),
    overlay: r.overlay,
    status: (r.status as DocStatus) ?? 'untracked',
    statusDetail: r.status_detail,
    statusCheckedAt: toIso(r.status_checked_at),
    regenEnqueuedAt: toIso(r.regen_enqueued_at),
    reverifyFlaggedAt: toIso(r.reverify_flagged_at),
    regenAttempts: r.regen_attempts ?? 0,
    reverifyAttempts: r.reverify_attempts ?? 0,
    title: r.title,
    createdAt: toIso(r.created_at) ?? '',
    updatedAt: toIso(r.updated_at) ?? '',
  };
}

/** One doc record, or null if none. */
export async function getDocRecord(
  harnessSlug: string,
  docId: string,
  workspaceId?: string,
): Promise<HarnessDocRecord | null> {
  // Derive the workspace from the harness (a harness's docs live in its workspace) —
  // never a silent 'default' for an omitted scope (P-002 docs sub-part / D-003).
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  const rows = await sql<DocRow[]>`
    SELECT * FROM harness_shared.harness_docs
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}
     LIMIT 1`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** All doc records for a harness, keyed by doc_id. */
export async function listDocRecords(
  harnessSlug: string,
  workspaceId?: string,
): Promise<Map<string, HarnessDocRecord>> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  const rows = await sql<DocRow[]>`
    SELECT * FROM harness_shared.harness_docs
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}`;
  const out = new Map<string, HarnessDocRecord>();
  for (const r of rows) out.set(r.doc_id, rowToRecord(r));
  return out;
}

export interface UpsertDocInput {
  harnessSlug: string;
  docId: string;
  workspaceId?: string;
  /** 'manual' or 'generated' — the BASE nature. The stored source upgrades to
   *  'augmented' automatically whenever an overlay is present. */
  source: DocSource;
  subjectRef: SubjectRef[];
  anchorPaths: string[];
  generatedFromSha?: string | null;
  lastVerifiedSha?: string | null;
  lastVerifiedAt?: string | null;
  /** Only set on a fresh insert; an upsert over an existing row NEVER changes the
   *  overlay (use setDocOverlay) so a regeneration preserves the human overlay. */
  overlay?: string | null;
  status?: DocStatus;
  statusDetail?: string | null;
  title?: string | null;
}

/**
 * Insert or update a doc record (PK conflict on workspace+harness+doc_id).
 *
 * Overlay preservation (D-003/P-005): on conflict the overlay is NEVER touched
 * here — a documenter regeneration that re-upserts a generated doc keeps any human
 * overlay intact, and the stored source stays 'augmented' while the overlay lives.
 */
export async function upsertDocRecord(input: UpsertDocInput): Promise<HarnessDocRecord> {
  const ws = await resolveWorkspaceForHarness(input.harnessSlug, input.workspaceId);
  const base: 'manual' | 'generated' = input.source === 'manual' ? 'manual' : 'generated';
  const insertOverlay = input.overlay ?? null;
  const { sql } = getOrgPg();
  const rows = await sql<DocRow[]>`
    INSERT INTO harness_shared.harness_docs
      (workspace_id, harness_slug, doc_id, source, subject_ref, anchor_paths,
       generated_from_sha, last_verified_sha, last_verified_at, overlay,
       status, status_detail, status_checked_at, title)
    VALUES (
      ${ws}, ${input.harnessSlug}, ${input.docId},
      ${insertOverlay !== null ? 'augmented' : base},
      ${JSON.stringify(input.subjectRef ?? [])}::text::jsonb,
      ${input.anchorPaths ?? []}::text[],
      ${input.generatedFromSha ?? null}, ${input.lastVerifiedSha ?? null}, ${input.lastVerifiedAt ?? null},
      ${insertOverlay},
      ${input.status ?? 'untracked'}, ${input.statusDetail ?? null}, now(), ${input.title ?? null}
    )
    ON CONFLICT (workspace_id, harness_slug, doc_id) DO UPDATE SET
      source = CASE WHEN harness_shared.harness_docs.overlay IS NOT NULL THEN 'augmented' ELSE ${base} END,
      subject_ref = EXCLUDED.subject_ref,
      anchor_paths = EXCLUDED.anchor_paths,
      generated_from_sha = EXCLUDED.generated_from_sha,
      last_verified_sha = COALESCE(EXCLUDED.last_verified_sha, harness_shared.harness_docs.last_verified_sha),
      last_verified_at = COALESCE(EXCLUDED.last_verified_at, harness_shared.harness_docs.last_verified_at),
      status = EXCLUDED.status,
      status_detail = EXCLUDED.status_detail,
      status_checked_at = now(),
      title = COALESCE(EXCLUDED.title, harness_shared.harness_docs.title)
    RETURNING *`;
  return rowToRecord(rows[0]);
}

/** Flip the derived freshness cache (the sweep / on-demand recompute write here). */
export async function setDocStatus(
  harnessSlug: string,
  docId: string,
  status: DocStatus,
  statusDetail: string | null = null,
  workspaceId?: string,
): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  // Heal resets the episode bookkeeping (mig 386): when a doc returns to `fresh`
  // (the baseline caught up — a documenter regen advanced generated_from_sha, or a
  // verify advanced last_verified_sha), clear the dispatch latch + attempt counter
  // so a FUTURE drift re-dispatches the doc-steward instead of being suppressed by
  // a stale latch left over from the previous episode (the regen latch was never
  // cleared at all before this — generated docs silently stopped re-dispatching).
  await sql`
    UPDATE harness_shared.harness_docs
       SET status = ${status}, status_detail = ${statusDetail}, status_checked_at = now(),
           regen_enqueued_at = CASE WHEN ${status} = 'fresh' THEN NULL ELSE regen_enqueued_at END,
           reverify_flagged_at = CASE WHEN ${status} = 'fresh' THEN NULL ELSE reverify_flagged_at END,
           regen_attempts = CASE WHEN ${status} = 'fresh' THEN 0 ELSE regen_attempts END,
           reverify_attempts = CASE WHEN ${status} = 'fresh' THEN 0 ELSE reverify_attempts END
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

/** A human verified a manual doc against the current HEAD → fresh + new baseline. */
export async function verifyDoc(
  harnessSlug: string,
  docId: string,
  verifiedSha: string,
  workspaceId?: string,
): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.harness_docs
       SET last_verified_sha = ${verifiedSha}, last_verified_at = now(),
           status = 'fresh', status_detail = NULL, status_checked_at = now(),
           reverify_flagged_at = NULL, reverify_attempts = 0
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

/**
 * Set/replace the augmented overlay (P-005). The stored source follows: with an
 * overlay → 'augmented'; cleared → 'generated' if it has a generated baseline,
 * else 'manual'.
 */
export async function setDocOverlay(
  harnessSlug: string,
  docId: string,
  overlay: string | null,
  workspaceId?: string,
): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.harness_docs
       SET overlay = ${overlay},
           source = CASE
             WHEN ${overlay}::text IS NOT NULL THEN 'augmented'
             WHEN generated_from_sha IS NOT NULL THEN 'generated'
             ELSE 'manual' END
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

/** Record that a regeneration was dispatched (D-004): bump the latch timestamp AND
 *  the per-episode attempt counter (mig 386). The sweep keys its backoff/give-up off
 *  both — `regen_enqueued_at` is the retry clock, `regen_attempts` the cap counter. */
export async function markRegenEnqueued(
  harnessSlug: string,
  docId: string,
  workspaceId?: string,
): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.harness_docs
       SET regen_enqueued_at = now(), regen_attempts = regen_attempts + 1
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

/** Record that a re-verify (doc-steward) dispatch fired (D-004): bump latch + attempt
 *  counter (mig 386), same retry-clock/cap model as markRegenEnqueued. */
export async function markReverifyFlagged(
  harnessSlug: string,
  docId: string,
  workspaceId?: string,
): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.harness_docs
       SET reverify_flagged_at = now(), reverify_attempts = reverify_attempts + 1
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

export async function deleteDocRecord(
  harnessSlug: string,
  docId: string,
  workspaceId?: string,
): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.harness_docs
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}
