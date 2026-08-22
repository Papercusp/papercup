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
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeWorkspaceId } from './workspace-registry';
import {
  loadHarnessRegistry,
  resolveHarnessContentPath,
  type HarnessRegistry,
} from './harness-registry';
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
  /** Git-compatible blob hash of the cited file's bytes at audit time. Written by
   *  `plans:audit` for every `code`/`test` citation; never accepted on the wire from
   *  the auditor. D-007 compares this with the current blob so a rewritten file is
   *  stale even when its path and symbol still resolve. */
  blobSha?: string;
}

export interface AuditItemEntry {
  itemId: string;
  verdict: AuditVerdict;
  citations: AuditCitation[];
  /** REQUIRED when verdict is `dropped` — the intentional-departure reason (D-002). */
  note?: string;
  /** Per-item provenance (D-006). Optional only for legacy rows written before the
   *  per-item shape landed; every new `plans:audit` write supplies all three fields. */
  auditedSha?: string | null;
  auditedAt?: string;
  itemTextHash?: string;
  /** Immediate audit pass this unchanged entry was mechanically carried from. The
   *  original auditedSha/auditedAt remain untouched, so carrying cannot re-stamp work
   *  the auditor did not inspect. */
  carriedFrom?: number;
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
  /**
   * Repo-relative → the absolute root(s) a miss was actually searched under.
   *
   * A `file_not_found` that names only the path the caller wrote is ambiguous in the
   * one way that costs real time: it cannot distinguish "you wrote the wrong path
   * shape" from "you are resolving against a root you did not expect". Those two have
   * OPPOSITE fixes, and this tool has two roots (the monorepo + admitted siblings, or
   * an explicitly-scoped harness's own tree), so the reader cannot infer which applied.
   * Optional so injected/pure test deps stay a two-field object.
   */
  describeRoots?: (rel: string) => string | null;
  /** Repo-relative → Git-compatible blob hash of the file's current bytes. Optional
   *  only so small injected resolver tests remain a two-function fixture. */
  blobSha?: (rel: string) => string | null;
}

/** Git's SHA-1 object id for a blob, without writing it into the object database. */
export function gitBlobSha(body: string | Buffer): string {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

/** Fingerprint only citations that constitute code verification. */
export function citationBlobSha(citation: AuditCitation, deps: CitationDeps): string | null {
  if (!isVerifyingCitation(citation)) return null;
  const rel = citation.path?.trim();
  if (!rel) return null;
  const direct = deps.blobSha?.(rel);
  if (direct) return direct;
  const body = deps.readFile(rel);
  return body == null ? null : gitBlobSha(body);
}

/** `file_not_found` detail: the path the caller wrote, plus where we actually looked. */
function missDetail(rel: string, deps: CitationDeps): string {
  const roots = deps.describeRoots?.(rel);
  return roots ? `${rel} (searched ${roots})` : rel;
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
  if (!stat) return { ok: false, reason: 'file_not_found', detail: missDetail(rel, deps) };
  if (!stat.isFile) return { ok: false, reason: 'not_a_file', detail: rel };

  if (citation.line != null || citation.symbol != null) {
    const body = deps.readFile(rel);
    if (body == null) return { ok: false, reason: 'file_not_found', detail: missDetail(rel, deps) };
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

/**
 * Sibling repositories a plan's citations may legitimately reach.
 *
 * This workspace hosts several INDEPENDENT repos beside the monorepo (sidestage,
 * greenfield-*), and a plan filed under one harness routinely delivers its code into
 * one of them. Rooting citation resolution at REPO_ROOT alone made those plans
 * structurally UNAUDITABLE: the repo-relative path did not exist, the
 * workspace-prefixed shape did not exist either, `..` was refused by both traversal
 * guards, and an absolute path is schema-refused — so no expressible citation could
 * resolve and the ship gate could never be satisfied honestly. That is
 * EI-20430092702151575, which blocked sidestage-seller-dockview-2026-08-14 with all
 * 12 items complete and independently graded.
 *
 * ADMISSION RULE: a direct child of the workspace root whose `.git` is a DIRECTORY.
 * That is precisely "an independent repository", and it EXCLUDES the release and
 * checkpoint worktrees — whose `.git` is a pointer FILE — because those are deploy
 * artifacts of THIS repo and must never stand as evidence for it. Measured on this
 * box: `sidestage/.git` is a directory, while `papercup-release/.git` and
 * `papercup-checkpoint/.git` are worktree pointer files.
 *
 * Citations into a sibling are written workspace-relative (`sidestage/apps/web/...`),
 * which is the shape an operator reaches for first. Containment is still enforced
 * per-root, so the strictness the module header describes is unchanged: a citation
 * passes only when it names a real file under an allowed root.
 */
export function independentSiblingRepos(repoRoot: string): ReadonlySet<string> {
  const workspaceRoot = path.dirname(repoRoot);
  const names = new Set<string>();
  let realRepo = repoRoot;
  try {
    realRepo = fs.realpathSync(repoRoot);
  } catch {
    /* keep the literal root */
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const abs = path.join(workspaceRoot, entry.name);
    try {
      // `papercup` is a symlink to the monorepo — realpath dedupes it so the repo
      // can never re-enter as its own sibling under a second name.
      if (fs.realpathSync(abs) === realRepo) continue;
      if (!fs.statSync(path.join(abs, '.git')).isDirectory()) continue;
    } catch {
      continue;
    }
    names.add(entry.name);
  }
  return names;
}

/** Real-filesystem deps rooted at the monorepo, plus independent sibling repos. */
export function repoCitationDeps(repoRoot: string = REPO_ROOT): CitationDeps {
  const workspaceRoot = path.dirname(repoRoot);
  let siblings: ReadonlySet<string> | null = null;

  const contained = (root: string, rel: string): string | null => {
    const abs = path.resolve(root, rel);
    // Second traversal guard, on the RESOLVED path: catches symlink-free `..`
    // survivors and any shape the segment check above did not anticipate.
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    return abs === root || abs.startsWith(rootWithSep) ? abs : null;
  };

  const within = (rel: string): string | null => {
    const inRepo = contained(repoRoot, rel);
    // In-repo always wins, so a sibling can never shadow a real monorepo file.
    if (inRepo !== null && fs.existsSync(inRepo)) return inRepo;
    const first = rel.split('/')[0];
    if (first) {
      // Computed lazily: the overwhelmingly common in-repo citation pays no scan.
      siblings ??= independentSiblingRepos(repoRoot);
      if (siblings.has(first)) {
        const inWorkspace = contained(workspaceRoot, rel);
        if (inWorkspace !== null) return inWorkspace;
      }
    }
    // A genuine miss still reports against the repo, so `file_not_found` names the
    // path the caller actually wrote rather than a sibling guess.
    return inRepo;
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
    blobSha: (rel) => {
      const abs = within(rel);
      if (!abs) return null;
      try {
        return gitBlobSha(fs.readFileSync(abs));
      } catch {
        return null;
      }
    },
    // Report the roots this rel was ACTUALLY tried under, not the admitted-sibling
    // catalogue: naming every sibling would bury the one root that matters. The repo
    // root is always consulted; the workspace root only when the first segment names
    // an admitted sibling, which is exactly when the `sibling/...` prefix is the fix.
    describeRoots: (rel) => {
      const roots = [repoRoot];
      const first = rel.split('/')[0];
      if (first) {
        siblings ??= independentSiblingRepos(repoRoot);
        if (siblings.has(first)) roots.push(path.join(workspaceRoot, first));
      }
      return roots.join(', ');
    },
  };
}

/** Resolve the canonical source root for an explicitly-scoped harness.
 *
 * A harness registry path outranks a same-slug workspace sibling: the latter may be
 * an old clone while the live staging hive is rooted under ~/.papercusp/hives. Keeping
 * this pure seam separate makes that precedence testable without reading PG. */
export function harnessCitationRepoRoot(
  reg: Pick<HarnessRegistry, 'projects'>,
  harnessSlug: string,
): string | null {
  return resolveHarnessContentPath(reg, harnessSlug) ?? null;
}

/** Citation context shared by audit-write and ship-time revalidation.
 * An explicit but unregistered harness fails closed instead of silently validating
 * against Papercusp's own checkout. */
export async function repoCitationContextForHarness(
  harnessSlug: string | null | undefined,
): Promise<{ repoRoot: string; deps: CitationDeps } | null> {
  if (!harnessSlug || harnessSlug === '*') {
    return { repoRoot: REPO_ROOT, deps: repoCitationDeps(REPO_ROOT) };
  }
  try {
    const reg = await loadHarnessRegistry();
    const repoRoot = harnessCitationRepoRoot(reg, harnessSlug);
    return repoRoot ? { repoRoot, deps: repoCitationDeps(repoRoot) } : null;
  } catch {
    return null;
  }
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
export interface PlanAuditReadScope {
  /** Concrete workspace carrying the plan. Falls back to the ambient request scope. */
  workspaceId?: string;
  /**
   * ⚠ NOT the plan's owning Hive-home slug (`resolvePlanScope`'s collapsed
   * `harnessSlug`) — do not pass `row.harnessSlug` from a `plans:get`-shaped
   * plan row here (EI-21124863090048444). `harness_slug` on `plan_audits` is the
   * CITATION-CONTEXT harness `plans:audit` ran from (so `repoCitationContextForHarness`
   * can re-resolve citations at ship time), which for a Hive with member/sub-harnesses
   * routinely differs from the plan's own Hive home. A strict-equality filter here
   * silently drops a real audit row whenever the two disagree. `recordPlanAudit`'s
   * own audit_seq computation and `getEffectiveItemAudits` both already scope purely
   * by (workspaceId, planSlug) — leave this unset unless you are DELIBERATELY
   * narrowing to one citation-context harness (a rare, explicit need, not the default
   * "read the plan's latest audit" case).
   */
  harnessSlug?: string;
}

export async function getLatestPlanAudit(
  planSlug: string,
  scope: PlanAuditReadScope = {},
): Promise<PlanAudit | null> {
  try {
    const { sql } = getOrgPg();
    const workspaceId = scope.workspaceId ?? activeWorkspaceId();
    const harnessSlug = scope.harnessSlug?.trim() || null;
    const rows = await sql<PlanAuditRow[]>`
      SELECT plan_slug, harness_slug, audit_seq, created_by, created_at, audited_sha,
             items, findings, summary
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${workspaceId}
         AND plan_slug = ${planSlug}
         AND (${harnessSlug}::text IS NULL OR harness_slug = ${harnessSlug})
       ORDER BY audit_seq DESC
       LIMIT 1`;
    const row = rows.find(
      (r) => r.plan_slug === planSlug && (!harnessSlug || r.harness_slug === harnessSlug),
    );
    return row ? rowToAudit(row) : null;
  } catch {
    return null;
  }
}

export interface EffectiveItemAudit {
  entry: AuditItemEntry;
  /** The pass row in which this effective copy currently lives. A later carry writes
   *  this value into carriedFrom, forming an auditable chain without changing the
   *  entry's original auditedSha/auditedAt. */
  auditSeq: number;
}

/** Pure newest-first fold used by the database read and by the regression guard. */
export function foldEffectiveItemAudits(
  passes: ReadonlyArray<{ auditSeq: number; items: AuditItemEntry[] }>,
): EffectiveItemAudit[] {
  const seen = new Set<string>();
  const effective: EffectiveItemAudit[] = [];
  for (const pass of passes) {
    for (const entry of pass.items) {
      if (!entry?.itemId || seen.has(entry.itemId)) continue;
      seen.add(entry.itemId);
      effective.push({ entry, auditSeq: pass.auditSeq });
    }
  }
  return effective;
}

/**
 * Resolve the latest entry for every item across ALL passes (D-006). Newest pass
 * first, first itemId wins. This deliberately does not assume a pass is a full-plan
 * snapshot: early rows and interrupted/concurrent writers may contain only a subset.
 */
export async function getEffectiveItemAudits(planSlug: string): Promise<EffectiveItemAudit[]> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<PlanAuditRow[]>`
      SELECT plan_slug, harness_slug, audit_seq, created_by, created_at, audited_sha,
             items, findings, summary
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${activeWorkspaceId()}
         AND plan_slug = ${planSlug}
       ORDER BY audit_seq DESC`;
    return foldEffectiveItemAudits(
      rows.map((row) => ({ auditSeq: row.audit_seq, items: Array.isArray(row.items) ? row.items : [] })),
    );
  } catch {
    return [];
  }
}

/** A plan item as the audit and the gate need it: its id and its status. */
export interface PlanItemStatus {
  itemId: string;
  status: string;
  itemText: string;
}

/** Stable fingerprint of the exact plan-item requirement text audited. */
export function planItemTextHash(itemText: string): string {
  return createHash('sha256').update(itemText).digest('hex');
}

/**
 * Build the item array for a new pass. Submitted items receive fresh provenance;
 * unlisted items are copied by the verb with their original provenance intact and
 * an immediate carriedFrom link. Removed items are not resurrected.
 *
 * This is the mechanical anti-rubber-stamp rail from D-006: callers may audit a
 * subset, but they cannot make an uninspected item inherit the pass's new sha/time.
 */
export function prepareAuditPassEntries(input: {
  planItems: PlanItemStatus[];
  submitted: AuditItemEntry[];
  previous: EffectiveItemAudit[];
  auditedSha: string | null;
  auditedAt: string;
}): AuditItemEntry[] {
  const submitted = new Map(input.submitted.map((entry) => [entry.itemId, entry]));
  const previous = new Map(input.previous.map((item) => [item.entry.itemId, item]));
  const merged: AuditItemEntry[] = [];

  for (const planItem of input.planItems) {
    const fresh = submitted.get(planItem.itemId);
    if (fresh) {
      const { carriedFrom: _carriedFrom, auditedSha: _sha, auditedAt: _at, itemTextHash: _text, ...entry } = fresh;
      merged.push({
        ...entry,
        auditedSha: input.auditedSha,
        auditedAt: input.auditedAt,
        itemTextHash: planItemTextHash(planItem.itemText),
      });
      continue;
    }

    const prior = previous.get(planItem.itemId);
    if (prior) merged.push({ ...prior.entry, carriedFrom: prior.auditSeq });
  }

  return merged;
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
    const rows = await sql<{ item_id: string; status: string; item_text: string }[]>`
      SELECT item_id, status, item_text
        FROM harness_shared.plan_items
       WHERE workspace_id = ${activeWorkspaceId()}
         AND plan_slug = ${planSlug}
       ORDER BY seq`;
    return rows.map((r) => ({ itemId: r.item_id, status: r.status, itemText: r.item_text }));
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

export interface AuditEntryValidationProblem {
  itemId: string;
  code:
    | 'missing_audited_sha'
    | 'invalid_audited_sha'
    | 'missing_audited_at'
    | 'invalid_audited_at'
    | 'missing_item_text_hash'
    | 'invalid_item_text_hash'
    | 'missing_blob_sha'
    | 'invalid_blob_sha';
  detail: string;
}

/**
 * Validate the shape that is about to be persisted.
 *
 * `plans:audit` is the normal producer and stamps these fields before calling the
 * store, but `recordPlanAudit` is also an internal write boundary. Keeping the
 * invariant here prevents another caller (or a stale deployed writer) from creating
 * a fresh row that looks current while carrying legacy-shaped entries. Existing
 * legacy entries are allowed only when `prepareAuditPassEntries` marks them with
 * `carriedFrom`; they retain their original, intentionally incomplete provenance.
 */
export function validatePersistedAuditEntries(items: AuditItemEntry[]): AuditEntryValidationProblem[] {
  const problems: AuditEntryValidationProblem[] = [];
  const hasOwn = (entry: AuditItemEntry, key: keyof AuditItemEntry): boolean =>
    Object.prototype.hasOwnProperty.call(entry, key);

  for (const item of items) {
    const hasProvenance = hasOwn(item, 'auditedSha') || hasOwn(item, 'auditedAt') || hasOwn(item, 'itemTextHash');
    const isLegacyCarry = !hasProvenance && Number.isInteger(item.carriedFrom) && (item.carriedFrom ?? 0) > 0;
    if (!isLegacyCarry) {
      if (!hasOwn(item, 'auditedSha')) {
        problems.push({
          itemId: item.itemId,
          code: 'missing_audited_sha',
          detail: `item '${item.itemId}' has no auditedSha provenance`,
        });
      } else if (item.auditedSha !== null && (typeof item.auditedSha !== 'string' || item.auditedSha.length < 7)) {
        problems.push({
          itemId: item.itemId,
          code: 'invalid_audited_sha',
          detail: `item '${item.itemId}' has an invalid auditedSha provenance value`,
        });
      }
      if (!hasOwn(item, 'auditedAt')) {
        problems.push({
          itemId: item.itemId,
          code: 'missing_audited_at',
          detail: `item '${item.itemId}' has no auditedAt provenance`,
        });
      } else if (typeof item.auditedAt !== 'string' || Number.isNaN(Date.parse(item.auditedAt))) {
        problems.push({
          itemId: item.itemId,
          code: 'invalid_audited_at',
          detail: `item '${item.itemId}' has an invalid auditedAt provenance value`,
        });
      }
      if (!hasOwn(item, 'itemTextHash')) {
        problems.push({
          itemId: item.itemId,
          code: 'missing_item_text_hash',
          detail: `item '${item.itemId}' has no itemTextHash provenance`,
        });
      } else if (typeof item.itemTextHash !== 'string' || !/^[0-9a-f]{64}$/i.test(item.itemTextHash)) {
        problems.push({
          itemId: item.itemId,
          code: 'invalid_item_text_hash',
          detail: `item '${item.itemId}' has an invalid itemTextHash provenance value`,
        });
      }
    }

    if (isLegacyCarry) continue;
    for (const citation of item.citations) {
      if (!isVerifyingCitation(citation)) continue;
      if (!citation.blobSha) {
        problems.push({
          itemId: item.itemId,
          code: 'missing_blob_sha',
          detail: `item '${item.itemId}' has a ${citation.kind} citation without blobSha`,
        });
      } else if (!/^[0-9a-f]{40}$/i.test(citation.blobSha)) {
        problems.push({
          itemId: item.itemId,
          code: 'invalid_blob_sha',
          detail: `item '${item.itemId}' has a ${citation.kind} citation with an invalid blobSha`,
        });
      }
    }
  }
  return problems;
}

/**
 * Append an audit pass. `audit_seq` is allocated in the INSERT itself
 * (`MAX(audit_seq)+1` over the same plan) rather than read-then-written, so two
 * concurrent audits of one plan cannot both compute the same sequence number. If
 * they race anyway the primary key rejects the loser, which is a retryable error
 * rather than a silently overwritten audit.
 */
export async function recordPlanAudit(input: RecordAuditInput): Promise<PlanAudit> {
  const provenanceProblems = validatePersistedAuditEntries(input.items);
  if (provenanceProblems.length > 0) {
    throw new Error(
      `plan audit provenance invalid: ${provenanceProblems.map((problem) => problem.detail).join('; ')}`,
    );
  }
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
