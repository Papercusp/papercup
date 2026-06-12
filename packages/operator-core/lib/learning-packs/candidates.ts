/**
 * candidates — the fleet→pack candidate staging area
 * (self-improvement-consume-edges-2026-06-12 P-032, brief B-11).
 *
 * The recurrence-escalation cross-scope promotion (P-052 lite) notices a
 * friction signature recurring across ≥2 DISTINCT scopes — cross-Hive pain
 * that belongs in the shared knowledge layer. This module is the missing edge
 * from that observation into the learning-pack system:
 *
 *   stage    one CANDIDATE row per signature (PG, migration 239) with full
 *            provenance — deduped structurally (UNIQUE workspace+signature,
 *            so a dismissed lesson never re-nags) and capped (pending ≤
 *            {@link pendingCandidateCap}), like the lite promotion itself.
 *   list     the Learnings view + learning_packs:candidates read.
 *   decide   the OWNER adopts or dismisses. Adoption materializes the item
 *            into the `fleet-lessons` pack under the installed packs root and
 *            bumps the pack's patch version — it NEVER touches a hive pool.
 *            Hives then adopt the new item through the EXISTING
 *            install/upgrade conflict review (learning-packs D-003), which is
 *            exactly the never-auto-published contract: a candidate becomes
 *            recallable wisdom only after two deliberate human acts.
 *
 * PG layer mirrors scout/routed-ledger.ts (getOrgPg + harness_shared table);
 * the pack-write helpers are exported pure-ish (injectable root) so tests pin
 * them against a temp dir with zero PG.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { installedLearningPacksRoot } from './load-packs';
import {
  APPLIES_TO_SHAPES,
  LEARNING_KINDS,
  parseManifest,
  type AppliesTo,
  type LearningKind,
  type LearningPackManifest,
} from './pack-format';

/** The owner-curated pack adoption writes into (created on first adoption). */
export const FLEET_LESSONS_PACK_ID = 'fleet-lessons';

/** Default pending-candidate cap — staging refuses past it (queue, not landfill). */
export const MAX_PENDING_CANDIDATES = 20;

/** Env-tunable pending cap (PAPERCUSP_LEARNING_CANDIDATE_CAP). */
export function pendingCandidateCap(): number {
  const raw = Number(process.env.PAPERCUSP_LEARNING_CANDIDATE_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MAX_PENDING_CANDIDATES;
}

export type CandidateStatus = 'pending' | 'adopted' | 'dismissed';

export interface LearningPackCandidate {
  id: string;
  signature: string;
  title: string;
  draftText: string;
  kind: LearningKind;
  appliesTo: AppliesTo[];
  /** Distinct scopes ('operator' | 'harness:<slug>') the signature recurred across. */
  scopes: string[];
  recurrenceCount: number;
  /** Improvement-item ids (EI/WI) the recurrence was observed on. */
  sourceItemIds: string[];
  status: CandidateStatus;
  createdBy: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  packId?: string;
  packItemId?: string;
}

interface CandidateRow {
  id: string;
  signature: string;
  title: string;
  draft_text: string;
  kind: string;
  applies_to: unknown;
  scopes: unknown;
  recurrence_count: number;
  source_item_ids: unknown;
  status: string;
  created_by: string;
  created_at: Date | string;
  decided_at: Date | string | null;
  decided_by: string | null;
  decision_note: string | null;
  pack_id: string | null;
  pack_item_id: string | null;
}

function tsToIso(v: Date | string | null): string | undefined {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function rowToCandidate(r: CandidateRow): LearningPackCandidate {
  const kind = (LEARNING_KINDS as readonly string[]).includes(r.kind) ? (r.kind as LearningKind) : 'feedback';
  const appliesTo = strArray(r.applies_to).filter((s): s is AppliesTo =>
    (APPLIES_TO_SHAPES as readonly string[]).includes(s),
  );
  return {
    id: r.id,
    signature: r.signature,
    title: r.title,
    draftText: r.draft_text,
    kind,
    appliesTo: appliesTo.length > 0 ? appliesTo : ['any'],
    scopes: strArray(r.scopes),
    recurrenceCount: r.recurrence_count,
    sourceItemIds: strArray(r.source_item_ids),
    status: (['pending', 'adopted', 'dismissed'] as const).find((s) => s === r.status) ?? 'pending',
    createdBy: r.created_by,
    createdAt: tsToIso(r.created_at) ?? new Date(0).toISOString(),
    ...(tsToIso(r.decided_at) ? { decidedAt: tsToIso(r.decided_at) } : {}),
    ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
    ...(r.decision_note ? { decisionNote: r.decision_note } : {}),
    ...(r.pack_id ? { packId: r.pack_id } : {}),
    ...(r.pack_item_id ? { packItemId: r.pack_item_id } : {}),
  };
}

function invalidate(names: string[]): void {
  void import('../sync-sse')
    .then((m) => names.forEach((n) => m.notifySyncInvalidate(n)))
    .catch(() => {});
}

/* ────────────────────────────────────────────────────────────────────────
 * Stage (the recurrence-escalation write)
 * ──────────────────────────────────────────────────────────────────────── */

export interface StageCandidateInput {
  signature: string;
  title: string;
  /** The draft learning body — a starting point the owner reviews/edits. */
  draftText: string;
  scopes: string[];
  recurrenceCount: number;
  sourceItemIds?: string[];
  kind?: LearningKind;
  createdBy?: string;
  workspaceId?: string;
}

export type StageCandidateResult =
  | { staged: true; id: string }
  | { staged: false; reason: 'duplicate-signature' | 'pending-cap' };

/**
 * File one candidate. Idempotent per signature (ON CONFLICT DO NOTHING on the
 * structural dedup constraint — re-planning the same recurring signature every
 * triage tick is a no-op); refuses past the pending cap so the owner's review
 * queue stays a queue.
 */
export async function stageLearningPackCandidate(
  input: StageCandidateInput,
): Promise<StageCandidateResult> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();

  const [{ count }] = await sql<[{ count: string }]>`
    SELECT count(*)::text AS count FROM harness_shared.learning_pack_candidates
    WHERE workspace_id = ${ws} AND status = 'pending'`;
  if (Number(count) >= pendingCandidateCap()) return { staged: false, reason: 'pending-cap' };

  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.learning_pack_candidates
      (workspace_id, signature, title, draft_text, kind, scopes, recurrence_count,
       source_item_ids, created_by)
    VALUES
      (${ws}, ${input.signature}, ${input.title}, ${input.draftText},
       ${input.kind ?? 'feedback'}, ${JSON.stringify(input.scopes)}::text::jsonb,
       ${input.recurrenceCount}, ${JSON.stringify(input.sourceItemIds ?? [])}::text::jsonb,
       ${input.createdBy ?? 'recurrence-escalation'})
    ON CONFLICT ON CONSTRAINT learning_pack_candidates_signature_uniq DO NOTHING
    RETURNING id`;
  if (rows.length === 0) return { staged: false, reason: 'duplicate-signature' };

  invalidate(['learningPacks.candidates']);
  return { staged: true, id: rows[0]!.id };
}

/* ────────────────────────────────────────────────────────────────────────
 * List
 * ──────────────────────────────────────────────────────────────────────── */

export async function listLearningPackCandidates(
  opts: { status?: CandidateStatus; limit?: number; workspaceId?: string } = {},
): Promise<LearningPackCandidate[]> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await sql<CandidateRow[]>`
    SELECT * FROM harness_shared.learning_pack_candidates
    WHERE workspace_id = ${ws}
      ${opts.status ? sql`AND status = ${opts.status}` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  return rows.map(rowToCandidate);
}

/* ────────────────────────────────────────────────────────────────────────
 * Pack materialization (pure-ish fs helpers — injectable root for tests)
 * ──────────────────────────────────────────────────────────────────────── */

const FLEET_LESSONS_MANIFEST: LearningPackManifest = {
  id: FLEET_LESSONS_PACK_ID,
  title: 'Fleet lessons',
  description:
    'Cross-hive recurring lessons the owner adopted from the fleet’s recurrence-escalation candidates.',
  version: '0.0.0', // bumped to 0.0.1 by the first adoption
  author: 'papercusp-fleet',
};

/** Kebab-case an item id from the title, unique against `taken` (suffix -2, -3, …). */
export function candidateItemId(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'fleet-lesson';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
}

/** Bump the patch component of a three-part semver. */
export function bumpPatchVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return '0.0.1';
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** Single-line, double-quoted frontmatter value parseFrontmatter round-trips. */
function fmValue(s: string): string {
  return `"${s.replace(/\s+/g, ' ').replace(/"/g, "'").trim()}"`;
}

/**
 * Render the `<item-id>.md` learning file for an adopted candidate. The body
 * is the (possibly owner-edited) draft text plus a provenance footer — packs
 * are curated artifacts; the footer says where this lesson was earned.
 */
export function renderCandidateLearningFile(opts: {
  itemId: string;
  title: string;
  text: string;
  kind: LearningKind;
  appliesTo: AppliesTo[];
  signature: string;
  scopes: string[];
  recurrenceCount: number;
  sourceItemIds: string[];
}): string {
  const appliesTo = opts.appliesTo.length > 0 ? opts.appliesTo : ['any'];
  const provenance =
    `Provenance: recurred ${opts.recurrenceCount}× across ${opts.scopes.join(', ')} ` +
    `(signature \`${opts.signature}\`` +
    (opts.sourceItemIds.length > 0 ? `; items ${opts.sourceItemIds.join(', ')}` : '') +
    ') — adopted from the fleet candidate queue.';
  return [
    '---',
    `id: ${opts.itemId}`,
    `title: ${fmValue(opts.title)}`,
    `kind: ${opts.kind}`,
    `applies_to: [${appliesTo.join(', ')}]`,
    '---',
    opts.text.trim(),
    '',
    provenance,
    '',
  ].join('\n');
}

function renderManifest(m: LearningPackManifest): string {
  return [
    `id: ${m.id}`,
    `title: ${fmValue(m.title)}`,
    `description: ${fmValue(m.description)}`,
    `version: ${fmValue(m.version)}`,
    ...(m.author ? [`author: ${fmValue(m.author)}`] : []),
    '',
  ].join('\n');
}

/**
 * Write one adopted candidate into the fleet-lessons pack dir (creating the
 * pack on first adoption) and bump the manifest patch version — so every hive
 * with the pack installed sees `updateAvailable` and adopts the new item
 * through the existing upgrade conflict review.
 */
export async function materializeCandidateIntoPack(
  opts: {
    title: string;
    text: string;
    kind: LearningKind;
    appliesTo: AppliesTo[];
    signature: string;
    scopes: string[];
    recurrenceCount: number;
    sourceItemIds: string[];
  },
  io: { packsRoot?: string } = {},
): Promise<{ packId: string; packItemId: string; packVersion: string }> {
  const dir = join(io.packsRoot ?? installedLearningPacksRoot(), FLEET_LESSONS_PACK_ID);
  await fs.mkdir(dir, { recursive: true });

  let manifest: LearningPackManifest = FLEET_LESSONS_MANIFEST;
  try {
    const raw = await fs.readFile(join(dir, 'manifest.yaml'), 'utf8');
    const parsed = parseManifest(raw);
    if (parsed.manifest) manifest = parsed.manifest;
  } catch {
    /* first adoption — the default manifest above */
  }

  const taken = new Set(
    (await fs.readdir(dir).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, '')),
  );
  const itemId = candidateItemId(opts.title, taken);
  const version = bumpPatchVersion(manifest.version);

  await fs.writeFile(
    join(dir, `${itemId}.md`),
    renderCandidateLearningFile({ ...opts, itemId }),
    'utf8',
  );
  await fs.writeFile(join(dir, 'manifest.yaml'), renderManifest({ ...manifest, version }), 'utf8');

  return { packId: FLEET_LESSONS_PACK_ID, packItemId: itemId, packVersion: version };
}

/* ────────────────────────────────────────────────────────────────────────
 * Decide (the owner's adopt / dismiss)
 * ──────────────────────────────────────────────────────────────────────── */

export interface DecideCandidateInput {
  id: string;
  action: 'adopt' | 'dismiss';
  by: string;
  note?: string;
  /** Owner edits applied at adoption (the draft is a starting point). */
  title?: string;
  text?: string;
  kind?: LearningKind;
  appliesTo?: AppliesTo[];
  workspaceId?: string;
  /** Test override of the installed packs root. */
  packsRoot?: string;
}

export type DecideCandidateResult =
  | { ok: true; action: 'dismiss'; id: string }
  | { ok: true; action: 'adopt'; id: string; packId: string; packItemId: string; packVersion: string }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'pack_write_failed'; error?: string };

/**
 * The owner's decision on one pending candidate. Adoption writes the pack
 * item FIRST, then flips the row — a failed pack write leaves the candidate
 * pending (retryable), never a half-adopted ghost.
 */
export async function decideLearningPackCandidate(
  input: DecideCandidateInput,
): Promise<DecideCandidateResult> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();

  const rows = await sql<CandidateRow[]>`
    SELECT * FROM harness_shared.learning_pack_candidates
    WHERE workspace_id = ${ws} AND id = ${input.id}`;
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };
  const candidate = rowToCandidate(row);

  if (input.action === 'dismiss') {
    await sql`
      UPDATE harness_shared.learning_pack_candidates
      SET status = 'dismissed', decided_at = now(), decided_by = ${input.by},
          decision_note = ${input.note ?? null}
      WHERE workspace_id = ${ws} AND id = ${input.id} AND status = 'pending'`;
    invalidate(['learningPacks.candidates']);
    return { ok: true, action: 'dismiss', id: input.id };
  }

  let written: { packId: string; packItemId: string; packVersion: string };
  try {
    written = await materializeCandidateIntoPack(
      {
        title: input.title?.trim() || candidate.title,
        text: input.text?.trim() || candidate.draftText,
        kind: input.kind ?? candidate.kind,
        appliesTo: input.appliesTo ?? candidate.appliesTo,
        signature: candidate.signature,
        scopes: candidate.scopes,
        recurrenceCount: candidate.recurrenceCount,
        sourceItemIds: candidate.sourceItemIds,
      },
      { ...(input.packsRoot ? { packsRoot: input.packsRoot } : {}) },
    );
  } catch (e) {
    return {
      ok: false,
      reason: 'pack_write_failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  await sql`
    UPDATE harness_shared.learning_pack_candidates
    SET status = 'adopted', decided_at = now(), decided_by = ${input.by},
        decision_note = ${input.note ?? null},
        pack_id = ${written.packId}, pack_item_id = ${written.packItemId}
    WHERE workspace_id = ${ws} AND id = ${input.id} AND status = 'pending'`;

  // The version bump makes `updateAvailable` light up on every hive carrying
  // the pack (learning.hive computes it from the catalog) — the existing
  // upgrade review is the adoption path into pools.
  invalidate(['learningPacks.candidates', 'learningPacks.list', 'learning.hive']);
  return { ok: true, action: 'adopt', id: input.id, ...written };
}
