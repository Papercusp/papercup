/**
 * candidates — the fleet→pack candidate staging area
 * (self-improvement-consume-edges-2026-06-12 P-032, brief B-11; auto-adopt
 * reversal owner-auto-adopt-fleet-lessons-2026-07-19 / WI-5414).
 *
 * The recurrence-escalation cross-scope promotion (P-052 lite) notices a
 * friction signature recurring across ≥2 DISTINCT scopes — cross-Hive pain
 * that belongs in the shared knowledge layer. This module is the missing edge
 * from that observation into the knowledge-pack system:
 *
 *   stage    one CANDIDATE row per signature (PG, migration 239; GLOBAL since 377)
 *            with full provenance — deduped structurally (UNIQUE signature — a
 *            learning is a workspace-agnostic capability, data-scoping-audit P-002,
 *            so a dismissed lesson never re-nags) and capped (pending ≤
 *            {@link pendingCandidateCap}), like the lite promotion itself.
 *   list     the Learnings view + knowledge_packs:candidates read.
 *   review   {@link reviewCandidateForAutoAdopt} — the AUTOMATED review (WI-5414
 *            reverses the old owner-gate contract: "the whole point of the
 *            learnings tab is that the things there do NOT need human
 *            supervision"). Reuses the EXISTING knowledge-pack sweep-scoring
 *            machinery (memory/conflict-check.ts + the same LLM-judge pattern
 *            manage.ts's install/upgrade review and sweepHiveConflicts already
 *            run) — the candidate's draft is judged against the fleet-lessons
 *            pack's OWN current items; a reported contradiction fails review.
 *   decide   adopt or dismiss. Adoption materializes the item into the
 *            `fleet-lessons` pack under the installed packs root and bumps the
 *            pack's patch version — it NEVER touches a hive pool directly.
 *            {@link autoAdoptPendingCandidates} runs the review then calls this
 *            with a MACHINE `by` identity ({@link AUTO_ADOPT_REVIEWER}) on the
 *            improvement-triage cadence — a passing review auto-adopts, a
 *            failing one auto-dismisses with the verdict recorded as the
 *            decision note. The owner can still adopt/dismiss manually at any
 *            time (a race with the sweep is harmless: decide() only acts on a
 *            still-`pending` row). Hives then adopt the new pack item through
 *            the EXISTING install/upgrade conflict review (knowledge-packs
 *            D-003) — which already has its OWN no-human path
 *            (knowledge_packs:upgrade { acceptDefaults: true }), so a hive that
 *            wants hands-off fleet-lessons updates already can without any
 *            further change here.
 *
 * PG layer mirrors scout/routed-ledger.ts (getOrgPg + harness_shared table);
 * the pack-write helpers are exported pure-ish (injectable root) so tests pin
 * them against a temp dir with zero PG.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { installedKnowledgePacksRoot } from './load-packs';
import {
  APPLIES_TO_SHAPES,
  LEARNING_KINDS,
  memoryTextOf,
  parseManifest,
  type AppliesTo,
  type LearningKind,
  type KnowledgePackManifest,
} from './pack-format';
import type { LlmJudge } from '../memory/conflict-check';

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

export interface KnowledgePackCandidate {
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

function rowToCandidate(r: CandidateRow): KnowledgePackCandidate {
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
export async function stageKnowledgePackCandidate(
  input: StageCandidateInput,
): Promise<StageCandidateResult> {
  const { sql } = getOrgPg();

  // Pending cap + structural dedup are GLOBAL now (learnings are workspace-agnostic
  // capabilities, P-002) — the queue is fleet-wide, the signature unique fleet-wide.
  const [{ count }] = await sql<[{ count: string }]>`
    SELECT count(*)::text AS count FROM harness_shared.knowledge_pack_candidates
    WHERE status = 'pending'`;
  if (Number(count) >= pendingCandidateCap()) return { staged: false, reason: 'pending-cap' };

  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.knowledge_pack_candidates
      (signature, title, draft_text, kind, scopes, recurrence_count,
       source_item_ids, created_by)
    VALUES
      (${input.signature}, ${input.title}, ${input.draftText},
       ${input.kind ?? 'feedback'}, ${JSON.stringify(input.scopes)}::text::jsonb,
       ${input.recurrenceCount}, ${JSON.stringify(input.sourceItemIds ?? [])}::text::jsonb,
       ${input.createdBy ?? 'recurrence-escalation'})
    ON CONFLICT ON CONSTRAINT knowledge_pack_candidates_signature_uniq DO NOTHING
    RETURNING id`;
  if (rows.length === 0) return { staged: false, reason: 'duplicate-signature' };

  invalidate(['knowledgePacks.candidates']);
  return { staged: true, id: rows[0]!.id };
}

/* ────────────────────────────────────────────────────────────────────────
 * List
 * ──────────────────────────────────────────────────────────────────────── */

export async function listKnowledgePackCandidates(
  opts: { status?: CandidateStatus; decidedBy?: string; limit?: number } = {},
): Promise<KnowledgePackCandidate[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const clauses = [
    ...(opts.status ? [sql`status = ${opts.status}`] : []),
    // `decidedBy` narrows to one decider's calls (e.g. the auto-adopt sweep's
    // machine identity) — the recent-auto-adoptions strip's read (WI-5414).
    ...(opts.decidedBy ? [sql`decided_by = ${opts.decidedBy}`] : []),
  ];
  const where = clauses.length > 0 ? sql`WHERE ${clauses.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;
  const rows = await sql<CandidateRow[]>`
    SELECT * FROM harness_shared.knowledge_pack_candidates
    ${where}
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  return rows.map(rowToCandidate);
}

/* ────────────────────────────────────────────────────────────────────────
 * Pack materialization (pure-ish fs helpers — injectable root for tests)
 * ──────────────────────────────────────────────────────────────────────── */

const FLEET_LESSONS_MANIFEST: KnowledgePackManifest = {
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

function renderManifest(m: KnowledgePackManifest): string {
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
  const dir = join(io.packsRoot ?? installedKnowledgePacksRoot(), FLEET_LESSONS_PACK_ID);
  await fs.mkdir(dir, { recursive: true });

  let manifest: KnowledgePackManifest = FLEET_LESSONS_MANIFEST;
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
  /** The adopting workspace — used ONLY for the transfer bar (its lessons are
   *  workspace-scoped); the candidate itself is global (P-002). Defaults to the
   *  active workspace. */
  workspaceId?: string;
  /** Test override of the installed packs root. */
  packsRoot?: string;
  /** Test override of the transfer bar (lib/transfer/pack-bar). */
  transferBar?: (q: {
    workspaceId: string;
    candidateId: string;
    signature: string;
  }) => Promise<{ blocked: boolean; detail?: string }>;
}

export type DecideCandidateResult =
  | { ok: true; action: 'dismiss'; id: string }
  | { ok: true; action: 'adopt'; id: string; packId: string; packItemId: string; packVersion: string }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'pack_write_failed' | 'transfer_bar'; error?: string };

/**
 * The owner's decision on one pending candidate. Adoption writes the pack
 * item FIRST, then flips the row — a failed pack write leaves the candidate
 * pending (retryable), never a half-adopted ghost.
 *
 * Adoption also consults the TRANSFER BAR (self-learning-frontier P-022 /
 * D-006: "knowledge-pack candidates inherit the passing-transfer-test bar"):
 * with the papercusp-transfer-harness flag armed, a candidate whose matched
 * transfer lesson FAILED its student-transfer test (or was retired) refuses
 * with reason 'transfer_bar' — the candidate stays pending, so the owner can
 * re-decide after a fix or dismiss. Flag dark (today) ⇒ byte-identical
 * behavior; the bar itself fails open on IO trouble.
 */
export async function decideKnowledgePackCandidate(
  input: DecideCandidateInput,
): Promise<DecideCandidateResult> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();

  const rows = await sql<CandidateRow[]>`
    SELECT * FROM harness_shared.knowledge_pack_candidates
    WHERE id = ${input.id}`;
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };
  const candidate = rowToCandidate(row);

  if (input.action === 'dismiss') {
    await sql`
      UPDATE harness_shared.knowledge_pack_candidates
      SET status = 'dismissed', decided_at = now(), decided_by = ${input.by},
          decision_note = ${input.note ?? null}
      WHERE id = ${input.id} AND status = 'pending'`;
    invalidate(['knowledgePacks.candidates']);
    return { ok: true, action: 'dismiss', id: input.id };
  }

  // D-006 transfer bar — proven-failed lessons don't enter the fleet pack.
  // Lazy import keeps the candidates module loadable in flags/PG-free tests
  // that never adopt; the bar itself is flag-gated + fail-open.
  const bar =
    input.transferBar ??
    (async (q: { workspaceId: string; candidateId: string; signature: string }) =>
      (await import('../transfer/pack-bar')).packCandidateTransferBar(q));
  const barVerdict = await bar({ workspaceId: ws, candidateId: input.id, signature: candidate.signature });
  if (barVerdict.blocked) {
    return { ok: false, reason: 'transfer_bar', ...(barVerdict.detail ? { error: barVerdict.detail } : {}) };
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
    UPDATE harness_shared.knowledge_pack_candidates
    SET status = 'adopted', decided_at = now(), decided_by = ${input.by},
        decision_note = ${input.note ?? null},
        pack_id = ${written.packId}, pack_item_id = ${written.packItemId}
    WHERE id = ${input.id} AND status = 'pending'`;

  // The version bump makes `updateAvailable` light up on every hive carrying
  // the pack (learning.hive computes it from the catalog) — the existing
  // upgrade review is the adoption path into pools.
  invalidate(['knowledgePacks.candidates', 'knowledgePacks.list', 'learning.hive']);
  return { ok: true, action: 'adopt', id: input.id, ...written };
}

/* ────────────────────────────────────────────────────────────────────────
 * Automated review + auto-adopt (WI-5414 — owner reversal of the owner-gate
 * contract: "the fleet lesson candidates should be auto adopted ... if we
 * still want a 'review' step, that should be an AUTOMATED review step, we
 * already have many mechanisms for this we use for other types of learnings")
 * ──────────────────────────────────────────────────────────────────────── */

/** The machine `by` identity stamped on every auto-decided candidate. */
export const AUTO_ADOPT_REVIEWER = 'fleet-candidate-auto-review';

/** Default cap on candidates auto-reviewed per sweep tick. */
export const AUTO_ADOPT_MAX_PER_RUN = 10;

export interface AutoReviewVerdict {
  verdict: 'pass' | 'fail';
  reason: string;
}

function lazyConflictJudge(): LlmJudge {
  // Lazy — mirrors manage.ts's realJudge(): pulling the Anthropic client at
  // module load would tax every importer of this module.
  return async (input) => {
    const { createAnthropicJudge } = await import('../memory/anthropic-judge');
    return createAnthropicJudge()(input);
  };
}

/**
 * The automated review: reuses the SAME conflict-check machinery the
 * install/upgrade review + sweepHiveConflicts already run (manage.ts) —
 * here judged against the fleet-lessons pack's OWN current items (the pack
 * itself is the dedup surface; there is no hive pool at this point). A
 * reported contradiction fails the review; an empty pack, no neighbors, or a
 * degraded/errored judge call all PASS — checkConflicts fails OPEN (same
 * posture as memory:remember's own dedup: this is hygiene, not a human gate).
 */
export async function reviewCandidateForAutoAdopt(
  candidate: Pick<KnowledgePackCandidate, 'title' | 'draftText'>,
  opts: { packsRoot?: string; judge?: LlmJudge } = {},
): Promise<AutoReviewVerdict> {
  const { loadKnowledgePack } = await import('./load-packs');
  const { checkConflicts } = await import('../memory/conflict-check');
  const loaded = await loadKnowledgePack(
    FLEET_LESSONS_PACK_ID,
    opts.packsRoot ? { roots: [{ dir: opts.packsRoot, source: 'installed' }] } : undefined,
  ).catch(() => null);
  const existing = loaded?.pack.items ?? [];
  if (existing.length === 0) {
    return { verdict: 'pass', reason: 'fleet-lessons pack is empty — nothing to conflict with (knowledge-pack sweep scoring)' };
  }

  const neighbors = existing.map((i) => ({ id: i.id, text: memoryTextOf(i) }));
  const judge = opts.judge ?? lazyConflictJudge();
  const report = await checkConflicts({ newText: candidate.draftText, neighbors, judge });
  if (report.conflicts.length > 0) {
    const summary = report.conflicts.map((c) => c.summary).join('; ');
    return {
      verdict: 'fail',
      reason: `conflicts with existing fleet-lessons item(s) (knowledge-pack sweep scoring): ${summary}`,
    };
  }
  return { verdict: 'pass', reason: 'no conflict with existing fleet-lessons content (knowledge-pack sweep scoring)' };
}

export interface AutoAdoptSweepResult {
  reviewed: number;
  adopted: number;
  dismissed: number;
  /** A decide() call that didn't succeed (e.g. the D-006 transfer bar refused
   *  an adopt) — the candidate stays pending and the next tick retries it. */
  failed: number;
}

/** Injectable seam (unit tests pin this without PG/LLM). */
export interface AutoAdoptDeps {
  list?: typeof listKnowledgePackCandidates;
  decide?: typeof decideKnowledgePackCandidate;
  review?: typeof reviewCandidateForAutoAdopt;
}

/**
 * Sweep every PENDING candidate (however it was staged, and whichever tick it
 * arrived on) through the automated review, then auto-decide via
 * {@link decideKnowledgePackCandidate} with the {@link AUTO_ADOPT_REVIEWER}
 * machine identity — a passing review adopts, a failing one dismisses with the
 * verdict recorded as the decision note. Run on the improvement-triage cadence
 * (see harness/routines/improvement-actions.ts); best-effort per candidate —
 * one failure never stops the sweep, and a candidate whose decide() call
 * itself fails (e.g. the transfer bar) simply stays pending for the next tick.
 */
export async function autoAdoptPendingCandidates(
  opts: { maxPerRun?: number; packsRoot?: string; workspaceId?: string } = {},
  deps: AutoAdoptDeps = {},
): Promise<AutoAdoptSweepResult> {
  const list = deps.list ?? listKnowledgePackCandidates;
  const decide = deps.decide ?? decideKnowledgePackCandidate;
  const review = deps.review ?? reviewCandidateForAutoAdopt;
  const maxPerRun = Math.max(0, opts.maxPerRun ?? AUTO_ADOPT_MAX_PER_RUN);
  const result: AutoAdoptSweepResult = { reviewed: 0, adopted: 0, dismissed: 0, failed: 0 };
  if (maxPerRun === 0) return result;

  const pending = (await list({ status: 'pending', limit: maxPerRun })).slice(0, maxPerRun);
  for (const candidate of pending) {
    result.reviewed += 1;
    let verdict: AutoReviewVerdict;
    try {
      verdict = await review(candidate, opts.packsRoot ? { packsRoot: opts.packsRoot } : {});
    } catch (e) {
      // The review is hygiene, never load-bearing (checkConflicts already
      // fails open on a judge error) — a harder failure (e.g. pack fs I/O)
      // still must not strand the candidate mid-sweep; degrade to pass.
      verdict = {
        verdict: 'pass',
        reason: `automated review errored, defaulting to pass: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const note = `Automated review (${AUTO_ADOPT_REVIEWER}): ${verdict.reason}`;
    const res = await decide({
      id: candidate.id,
      action: verdict.verdict === 'fail' ? 'dismiss' : 'adopt',
      by: AUTO_ADOPT_REVIEWER,
      note,
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      ...(verdict.verdict === 'pass' && opts.packsRoot ? { packsRoot: opts.packsRoot } : {}),
    });
    if (!res.ok) {
      result.failed += 1;
    } else if (res.action === 'adopt') {
      result.adopted += 1;
    } else {
      result.dismissed += 1;
    }
  }
  return result;
}
