/**
 * plan-audits — the code-truth audit record and its citation resolver
 * (plan-completion-audit-and-acceptance-verdict-2026-08-13 P-002).
 *
 * WHY THIS EXISTS -------------------------------------------------------------
 * `evaluatePlanAcceptanceGate` verifies the ceremony around a plan's completion:
 * that an acceptance rubric exists, that some grading rates every criterion, and
 * that the grader is not the rubric's author. It never reads what the ratings SAY,
 * never checks the plan's items, and never reads the code. An agent filed the
 * diagnosis on 2026-08-12 (EI-20219912008114544): "a gate that checks completeness
 * is not checking correctness."
 *
 * The audit is the missing half — the implementer traces every plan item to the code
 * that implements it and CITES it, before authoring the acceptance rubric (plan D-004).
 *
 * WHY THE CITATIONS MUST RESOLVE ----------------------------------------------
 * The audit is a SELF-audit (D-004): the implementer checks their own work. That
 * removes the independence leg entirely, so the guard cannot rest on conscientiousness
 * — it rests on this module. A citation that does not resolve against the real tree is
 * REFUSED at write time, and re-resolved again by the gate at ship time because the
 * tree moves in between. That is what makes an audit falsifiable rather than an
 * attestation, which is the whole difference between this and a filled-in form.
 *
 * NOT REUSED, DELIBERATELY: `memory/audit-anchors.ts` already classifies file
 * references, and at first glance `classifyFileAnchor` is the same job. It is not.
 * That classifier is deliberately LENIENT — it accepts a path that does not exist if
 * the basename is unique repo-wide, and skips anything "external by nature" (`/…`,
 * `tmp/…`, `~/…`) — because its purpose is auditing years-old memory anchors without
 * crying wolf. Every one of those leniencies is a hole here: accepting a
 * near-miss path is precisely the rubber stamp this gate exists to catch. What IS
 * borrowed is its shape — a pure core with `exists`/`readFile` injected, so the
 * resolver tests without touching a real tree.
 *
 * STATED LIMIT: this raises the cost of a rubber stamp; it does not make one
 * impossible. Fabricated paths die here, and mass-`none` citation dies at grading
 * (plan P-010 puts the none-ratio in front of the independent grader). An auditor
 * who cites real files that do not implement the item defeats both. Do not describe
 * this module as proving an audit was honest — it proves the citations point at
 * files that exist, which is a strictly weaker and still useful claim.
 */
import { getOrgPg } from '@papercusp/db-org';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeWorkspaceId } from './workspace-registry';
// The monorepo-root walk-up lives in the docs tool helper only because that is where
// it was first needed; it is imported rather than re-derived so there stays exactly
// ONE implementation of "where is the repo root" rather than two that can disagree.
import { REPO_ROOT } from './agent-tools/docs/_repo-paths';

// ── the record ────────────────────────────────────────────────────────────────

/** Per-item audit verdict. Per plan D-002 NONE of these refuses a ship on its own —
 *  they RECORD. The ship-blocking question is the item's own status, not this. */
export const AUDIT_VERDICTS = ['implemented', 'not-code', 'partial', 'missing', 'dropped'] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

/** Citation kinds. Per plan D-008, **only `code`/`test` constitute VERIFICATION** — they
 *  resolve against the real tree and are the sole evidence that an item was built. `doc`
 *  and `none` are explicit declarations of NON-verification: they record where a non-source
 *  deliverable lives, or why none exists, and both are counted so the ratio is visible to
 *  the independent grader (P-010) rather than absorbed into a verified-looking total.
 *
 *  `workitem` was REMOVED here (D-008). A work-item is a record of INTENT, so citing one as
 *  proof that code exists is circular — exactly the "documentation or memory" the owner's
 *  founding instruction excludes. It survives only on `AuditFinding.ref`, where pointing at
 *  a filed out-of-scope bug is the correct use. */
export const CITATION_KINDS = ['code', 'test', 'doc', 'none'] as const;
export type CitationKind = (typeof CITATION_KINDS)[number];

/** The kinds that count as verification against the code. Everything not in this set is
 *  unverified BY CONSTRUCTION — keep this as the single definition so a future kind cannot
 *  become evidence merely by being added to CITATION_KINDS. */
export const VERIFYING_CITATION_KINDS: ReadonlySet<CitationKind> = new Set<CitationKind>(['code', 'test']);

export function isVerifyingCitation(c: AuditCitation): boolean {
  return VERIFYING_CITATION_KINDS.has(c.kind);
}

export interface AuditCitation {
  kind: CitationKind;
  /** Repo-relative path — required for `code`/`test`, optional for `doc` (a doc that IS a
   *  tree file is resolved like any other path; a PG-canonical `/internal/docs/...` doc has
   *  no path and carries `ref` + `reason` instead). */
  path?: string;
  /** Optional line number; validated against the file's actual length. */
  line?: number;
  /** Optional symbol that must literally appear in the cited file. */
  symbol?: string;
  /** A doc id — for `doc` citations that name a PG-canonical doc rather than a tree file. */
  ref?: string;
  /** REQUIRED for `none`, and for a `doc` cited by `ref` alone: why this item has no
   *  code-resolvable artifact. Parity is deliberate — before D-008 `none` demanded a reason
   *  while a doc ref demanded only a non-empty string, so the honest escape cost MORE than
   *  the dodge. */
  reason?: string;
}

export interface AuditItemEntry {
  itemId: string;
  verdict: AuditVerdict;
  citations: AuditCitation[];
  /** REQUIRED when verdict is `dropped` — the intentional-departure reason (D-002). */
  note?: string;
}

export interface AuditFinding {
  summary: string;
  severity?: string;
  /** `filed` REQUIRES `ref` — a finding is never both un-fixed and un-recorded. */
  disposition: 'fixed' | 'filed';
  ref?: string;
}

export interface PlanAudit {
  planSlug: string;
  harnessSlug: string;
  auditSeq: number;
  createdBy: string;
  createdAt: string;
  auditedSha: string | null;
  items: AuditItemEntry[];
  findings: AuditFinding[];
  summary: string | null;
}

// ── citation resolution (pure core) ───────────────────────────────────────────

export type CitationResolution =
  | { ok: true }
  | { ok: false; reason: CitationFailureReason; detail?: string };

export type CitationFailureReason =
  | 'path_missing'
  | 'path_absolute'
  | 'path_escapes_repo'
  | 'file_not_found'
  | 'not_a_file'
  | 'line_out_of_range'
  | 'symbol_not_found'
  | 'reason_missing'
  | 'ref_missing';

export interface CitationDeps {
  /** Repo-relative → does a regular file exist there? */
  statFile: (rel: string) => { isFile: boolean } | null;
  /** Repo-relative → file contents, or null when unreadable. */
  readFile: (rel: string) => string | null;
}

/**
 * Resolve ONE citation. Pure: fs access is injected.
 *
 * Strictness is the point (see the module header). A `code`/`test` citation passes
 * only when the exact repo-relative path names a real file, any `line` is inside that
 * file, and any `symbol` literally appears in it. There is no basename fallback and
 * no "external path" skip — a citation that needs either of those is not evidence.
 */
export function resolveCitation(citation: AuditCitation, deps: CitationDeps): CitationResolution {
  if (citation.kind === 'none') {
    return citation.reason && citation.reason.trim().length > 0
      ? { ok: true }
      : { ok: false, reason: 'reason_missing' };
  }

  // `doc` (D-008). A doc that IS a tree file resolves exactly like any other path — there
  // was never a reason to exempt it, and the pre-D-008 behaviour (accept any non-empty
  // string) made a doc ref a one-character bypass of the whole audit. A PG-canonical doc
  // (`/internal/docs/...`) has no tree path, so it must carry BOTH a ref and a reason — the
  // same bar `none` pays. Note this only governs whether the citation is well-formed:
  // `doc` never counts as verification either way (see VERIFYING_CITATION_KINDS).
  if (citation.kind === 'doc' && !(citation.path && citation.path.trim().length > 0)) {
    if (!citation.ref || citation.ref.trim().length === 0) return { ok: false, reason: 'ref_missing' };
    return citation.reason && citation.reason.trim().length > 0
      ? { ok: true }
      : { ok: false, reason: 'reason_missing' };
  }

  // code | test — and a `doc` that names a tree file. The resolving kinds.
  const rel = citation.path?.trim();
  if (!rel) return { ok: false, reason: 'path_missing' };
  if (rel.startsWith('/') || rel.startsWith('~')) return { ok: false, reason: 'path_absolute' };
  // Reject traversal on the SEGMENTS, not by substring: a substring test both misses
  // `a/../../b` shapes and false-positives on a legitimate `..foo` filename.
  if (rel.split('/').some((seg) => seg === '..')) return { ok: false, reason: 'path_escapes_repo' };

  const stat = deps.statFile(rel);
  if (!stat) return { ok: false, reason: 'file_not_found', detail: rel };
  if (!stat.isFile) return { ok: false, reason: 'not_a_file', detail: rel };

  if (citation.line != null || citation.symbol != null) {
    const body = deps.readFile(rel);
    if (body == null) return { ok: false, reason: 'file_not_found', detail: rel };
    if (citation.line != null) {
      const lines = body.split('\n').length;
      if (citation.line < 1 || citation.line > lines) {
        return { ok: false, reason: 'line_out_of_range', detail: `${rel}:${citation.line} (file has ${lines} lines)` };
      }
    }
    if (citation.symbol != null && !body.includes(citation.symbol)) {
      return { ok: false, reason: 'symbol_not_found', detail: `${citation.symbol} not in ${rel}` };
    }
  }

  return { ok: true };
}

/** Real-filesystem deps rooted at the monorepo. */
export function repoCitationDeps(repoRoot: string = REPO_ROOT): CitationDeps {
  const within = (rel: string): string | null => {
    const abs = path.resolve(repoRoot, rel);
    // Second traversal guard, on the RESOLVED path: catches symlink-free `..`
    // survivors and any shape the segment check above did not anticipate.
    const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
    return abs === repoRoot || abs.startsWith(rootWithSep) ? abs : null;
  };
  return {
    statFile: (rel) => {
      const abs = within(rel);
      if (!abs) return null;
      try {
        return { isFile: fs.statSync(abs).isFile() };
      } catch {
        return null;
      }
    },
    readFile: (rel) => {
      const abs = within(rel);
      if (!abs) return null;
      try {
        return fs.readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

// ── coverage ──────────────────────────────────────────────────────────────────

export interface AuditCoverage {
  /** Items the audit covers. */
  auditedItems: number;
  /** THE headline number (D-008): items carrying at least one RESOLVING `code`/`test`
   *  citation — i.e. actually verified against the tree. This is the figure P-010's
   *  independent grader spot-checks, and the one no volume of doc refs can inflate.
   *  Before D-008 the reported figure was `citedItems`, which counted a `doc` ref whose
   *  only check was that it was a non-empty string. */
  verifiedItems: number;
  /** verifiedItems / auditedItems, 2dp. Null when there is nothing to divide. */
  verifiedRatio: number | null;
  /** Item ids carrying NO verifying citation — named, not just counted, so the grader can
   *  go straight to them instead of re-deriving the set. */
  unverifiedItemIds: string[];
  /** Of the audited items, how many carry at least one citation of ANY kind. Retained for
   *  continuity, but deliberately NOT the headline: a `doc` citation makes an item cited
   *  without making it verified. */
  citedItems: number;
  /** Of those, how many are cited `none` — the escape hatch (D-004's known soft spot). */
  noneItems: number;
  /** noneItems / auditedItems, rounded to 2dp. Reported so the ratio is a number the
   *  independent grader can read, not a vibe. Null when there is nothing to divide. */
  noneRatio: number | null;
  /** Items whose deliverable is declared non-source. METERED as of D-008: this is the
   *  widest escape hatch in the design — wider than `none` — and before D-008 it was
   *  counted nowhere at all, so an audit marking every item `not-code` reported a clean
   *  sheet. Surfaced beside the unverified counts for exactly that reason. */
  notCodeItems: string[];
  /** Items whose verdict records incomplete work — informational (D-002). */
  unresolvedVerdicts: string[];
  /** Items intentionally departed from, with their reasons (D-002). */
  droppedItems: { itemId: string; reason: string }[];
}

export function summarizeCoverage(items: AuditItemEntry[]): AuditCoverage {
  const audited = items.length;
  let cited = 0;
  let none = 0;
  let verified = 0;
  const unverifiedIds: string[] = [];
  const notCode: string[] = [];
  const unresolved: string[] = [];
  const dropped: { itemId: string; reason: string }[] = [];
  for (const it of items) {
    const kinds = it.citations.map((c) => c.kind);
    // Verification is decided by CITATION KIND, never by the verdict the auditor typed —
    // the verdict is the claim, the resolving code citation is the evidence for it.
    if (it.citations.some(isVerifyingCitation)) verified += 1;
    else unverifiedIds.push(it.itemId);
    if (kinds.some((k) => k !== 'none')) cited += 1;
    if (kinds.length > 0 && kinds.every((k) => k === 'none')) none += 1;
    if (it.verdict === 'not-code') notCode.push(it.itemId);
    if (it.verdict === 'partial' || it.verdict === 'missing') unresolved.push(it.itemId);
    if (it.verdict === 'dropped') dropped.push({ itemId: it.itemId, reason: it.note ?? '' });
  }
  return {
    auditedItems: audited,
    verifiedItems: verified,
    verifiedRatio: audited > 0 ? Math.round((verified / audited) * 100) / 100 : null,
    unverifiedItemIds: unverifiedIds,
    citedItems: cited,
    noneItems: none,
    noneRatio: audited > 0 ? Math.round((none / audited) * 100) / 100 : null,
    notCodeItems: notCode,
    unresolvedVerdicts: unresolved,
    droppedItems: dropped,
  };
}

// ── store ─────────────────────────────────────────────────────────────────────

interface PlanAuditRow {
  plan_slug: string;
  harness_slug: string;
  audit_seq: number;
  created_by: string;
  created_at: string;
  audited_sha: string | null;
  items: AuditItemEntry[] | null;
  findings: AuditFinding[] | null;
  summary: string | null;
}

function rowToAudit(row: PlanAuditRow): PlanAudit {
  return {
    planSlug: row.plan_slug,
    harnessSlug: row.harness_slug,
    auditSeq: row.audit_seq,
    createdBy: row.created_by,
    createdAt: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
    auditedSha: row.audited_sha,
    items: Array.isArray(row.items) ? row.items : [],
    findings: Array.isArray(row.findings) ? row.findings : [],
    summary: row.summary,
  };
}

/**
 * The gate's read: the most recent audit PASS for a plan. Earlier passes are history
 * and are never rewritten, so "latest" is always the operative one.
 *
 * Fails toward null on an infrastructure error, which the gate reads as "unaudited"
 * — a refusal. That is the safe direction: a database blip must not let an unaudited
 * plan through, and the refusal is recoverable by re-running the audit.
 */
export async function getLatestPlanAudit(planSlug: string): Promise<PlanAudit | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<PlanAuditRow[]>`
      SELECT plan_slug, harness_slug, audit_seq, created_by, created_at, audited_sha,
             items, findings, summary
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${activeWorkspaceId()}
         AND plan_slug = ${planSlug}
       ORDER BY audit_seq DESC
       LIMIT 1`;
    const row = rows.find((r) => r.plan_slug === planSlug);
    return row ? rowToAudit(row) : null;
  } catch {
    return null;
  }
}

/** A plan item as the audit and the gate need it: its id and its status. */
export interface PlanItemStatus {
  itemId: string;
  status: string;
}

/**
 * The plan's items, read from the `plan_items` INDEX rather than by re-parsing the
 * plan body. Two reasons: the index already carries the status (which the gate's
 * unfinished-items check needs), and a full parse is expensive here — plan bodies
 * reach 90KB+ (EI-20200393414409502). The index is rebuilt from the body on every
 * plan write by `plan-index-rows.ts`, so it cannot drift behind the source.
 *
 * Fails toward an EMPTY list. Callers must treat empty as "could not read the items"
 * and never as "the plan has no items" — validating an audit against an empty list
 * would accept every itemId, which is the opposite of this module's job.
 */
export async function getPlanItemStatuses(planSlug: string): Promise<PlanItemStatus[]> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ item_id: string; status: string }[]>`
      SELECT item_id, status
        FROM harness_shared.plan_items
       WHERE workspace_id = ${activeWorkspaceId()}
         AND plan_slug = ${planSlug}
       ORDER BY seq`;
    return rows.map((r) => ({ itemId: r.item_id, status: r.status }));
  } catch {
    return [];
  }
}

/** Item statuses that mean "this work is not finished and was not consciously
 *  abandoned". `dropped` is absent on purpose — it is a recorded decision (D-002),
 *  and `done` is the finished case. */
export const UNFINISHED_ITEM_STATUSES = ['todo', 'wip', 'blocked', 'needs-human'] as const;

export interface RecordAuditInput {
  planSlug: string;
  harnessSlug: string;
  createdBy: string;
  auditedSha?: string | null;
  items: AuditItemEntry[];
  findings?: AuditFinding[];
  summary?: string | null;
}

/**
 * Append an audit pass. `audit_seq` is allocated in the INSERT itself
 * (`MAX(audit_seq)+1` over the same plan) rather than read-then-written, so two
 * concurrent audits of one plan cannot both compute the same sequence number. If
 * they race anyway the primary key rejects the loser, which is a retryable error
 * rather than a silently overwritten audit.
 */
export async function recordPlanAudit(input: RecordAuditInput): Promise<PlanAudit> {
  const { sql } = getOrgPg();
  const rows = await sql<PlanAuditRow[]>`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audited_sha, items, findings, summary)
    SELECT ${activeWorkspaceId()}, ${input.harnessSlug}, ${input.planSlug},
           COALESCE(MAX(a.audit_seq), 0) + 1,
           ${input.createdBy}, ${input.auditedSha ?? null},
           -- jsonb is bound as an explicit JSON.stringify + cast: sql.json() THROWS on the
           -- getOrgPg client (EI-607) and a bare object does not bind.
           ${JSON.stringify(input.items)}::jsonb,
           ${JSON.stringify(input.findings ?? [])}::jsonb,
           ${input.summary ?? null}
      FROM harness_shared.plan_audits a
     WHERE a.workspace_id = ${activeWorkspaceId()}
       AND a.plan_slug = ${input.planSlug}
    RETURNING plan_slug, harness_slug, audit_seq, created_by, created_at, audited_sha,
              items, findings, summary`;
  return rowToAudit(rows[0]);
}
