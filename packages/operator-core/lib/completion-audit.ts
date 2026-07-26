/**
 * completion-audit — the ONE predicate both work-item families use to answer
 * "was this unit actually verified, or did it just assert done?" (EI-10867).
 *
 * ## The bug this exists to prevent
 *
 * `work_items:list { audit: 'no-evidence' }` is the DRAIN leader's stale-done
 * spot-audit — the check that is supposed to catch a unit closed on a bare
 * assertion. It keyed on `terminal_completion_ref IS NULL`.
 *
 * But `terminal_completion_ref` is not evidence. It is the completion-integrity
 * gate's OWN bookkeeping: `setWorkItemState` / `setIssueState` REJECT any terminal
 * transition that does not carry a `completionRef`, and `work_items:complete`
 * auto-fills it from `completion.summary`. So for every item closed through the
 * sanctioned path the column is non-null BY CONSTRUCTION — regardless of whether
 * the agent ever said how (or whether) it verified anything.
 *
 * The audit was therefore structurally incapable of returning the thing it is named
 * for. Measured on the live store when this was found: of 5,979 terminal rows
 * carrying a completion ref, 4,119 (69%) had NO structured verification evidence at
 * all, and the audit reported every one of them as clean. The leader who ran it saw
 * an empty list and concluded the fleet's completions were sound. A completion-
 * integrity check with a 69% false-negative rate is worse than none: it launders
 * unverified work as audited.
 *
 * The root cause is a classic write/read split-brain: the WRITERS agreed on
 * `payload._completionEvidence` (declared twice, privately, in work-items.ts and
 * issues-engineer.ts) while the READER keyed on a different column entirely. Nothing
 * forced them to agree. Now one module owns the key AND the predicate, and both
 * families import it — so a write and an audit cannot drift apart again.
 */

import { getOrgPg } from '@papercusp/db-org';
import { TERMINAL_COMPLETION_EVIDENCE_KEY, type CompletionVerificationEvidence } from './coord-lifecycle/records';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * The completion-integrity audits. Two DISTINCT defects — keep both:
 *
 *  - `no-evidence` — terminal, but no structured verification evidence
 *    (`payload._completionEvidence` absent). The unit asserted done without ever
 *    stating HOW it was verified. This is the stale-done close, and the common case.
 *
 *  - `no-completion-record` — terminal with `terminal_completion_ref IS NULL` AND
 *    `authority IS NULL`: a bare `set_state` close that bypassed the completion path
 *    altogether (this was the OLD `no-evidence` predicate). Rarer, and mostly pre-gate
 *    legacy rows — but a real and separate defect, so it keeps its own name instead of
 *    being silently dropped.
 *
 *    The `authority IS NULL` conjunct is P-004
 *    (agent-protocol-authority-semantics-2026-07-26). `work_items:complete` used to
 *    auto-fill `terminal_completion_ref` from `completion.summary` on every close; P-004
 *    DELETED that auto-fill and stamps an authority judgement instead. So from P-004
 *    onward a perfectly well-formed completion has a NULL ref, and a ref-only predicate
 *    would have flagged EVERY new close as "bypassed the completion path" — turning this
 *    audit into a fleet-wide false-alarm generator against exactly the rows that went
 *    through the gate most rigorously. A row carrying an authority judgement HAS a
 *    completion record, by definition: the judgement is what the gate produced.
 *
 *  - `no-completion-record-suspicious` (EI-18676290701611705) — the ACTIONABLE subset
 *    of `no-completion-record`: a bare-ref terminal row credited to someone who is NOT
 *    one of the small, audited `skipCompletionGate` system identities. A NULL ref is
 *    EXPECTED and benign for those five (the whole design point — see each bypass
 *    site's own doc comment); by construction, every OTHER caller already went through
 *    the completion-integrity gate, which REJECTS an empty completionRef on a terminal
 *    transition. So this combination — terminal, no ref, NOT a recognized system bypass
 *    — should be structurally impossible. Its existence (EI-18673480587329034: a MAJOR,
 *    human-verified bug closed by a real agent with both `completion` and
 *    `terminal_completion_ref` empty, and no matching bypass identity) means an
 *    undiscovered write path slipped past the gate — this audit is how a leader finds
 *    the NEXT one instead of hand-verifying source for every plain `no-completion-record`
 *    hit (most of which are the benign, expected system dedup flips).
 *
 *  - `geometry-unverified` (WI-5891, the P-014/WI-5874 audit follow-up) — a terminal row
 *    whose `filesChanged` touches a layout-bearing file ({@link touchesLayoutBearingFiles}:
 *    `*.css`/`*.tsx`/`*.jsx`) while `verifiedHow` is `'unit'` or ABSENT. This is the
 *    detection-only sibling of {@link isBackedLiveDroveUiClaim}'s hard completion-boundary
 *    reject: WI-5874/P-001 shipped a real, visible WebKitGTK layout regression closed
 *    with `verifiedHow:'live-drove-ui'` citing only two vitest runs and no screenshot —
 *    structure-passing, pixel-failing. This bucket names that exact shape so a leader
 *    audit (`work_items:list { audit: 'geometry-unverified' }`) surfaces it going
 *    forward, the same way `no-evidence` surfaces a bare-assertion close today.
 *
 *  - `intermittent-underevidenced` (EI-18716652701919665) — a terminal row whose title is
 *    classified intermittent/flaky/racy ({@link looksLikeIntermittentClassification}) AND
 *    carries STRUCTURED completion evidence (so `no-evidence` does NOT already catch it) AND
 *    that evidence states neither a failure rate/root-cause nor cites a deterministic
 *    regression test ({@link hasIntermittentFailureRateEvidence}). This is an EVIDENCE-SHAPE
 *    defect, not a bareness one: WI-5673 (live-federation-gate content-matrix) closed with a
 *    fully structured, honest completion — `verifiedHow:'integration'`, testResult "2
 *    consecutive runs, 10/10 both times" — and passed the ordinary `no-evidence` bar cleanly.
 *    It then reopened 5 days later, now failing 4/4 with a wider blast radius. For a bug whose
 *    own title says "intermittently", N consecutive passes is a SAMPLE that cannot falsify
 *    "we happened to sample the passing branch N times" unless a per-run failure rate (or an
 *    actual root cause + deterministic repro test) is stated. This bucket names that gap so a
 *    leader audit (`work_items:list { audit: 'intermittent-underevidenced' }`) surfaces it,
 *    the same way `geometry-unverified` surfaces an evidence-shape mismatch for layout bugs.
 */
export const COMPLETION_AUDITS = [
  'no-evidence',
  'no-completion-record',
  'no-completion-record-suspicious',
  'geometry-unverified',
  'intermittent-underevidenced',
] as const;
export type CompletionAudit = (typeof COMPLETION_AUDITS)[number];

/**
 * The exact `by` identities the audited `skipCompletionGate` bypasses stamp — kept here,
 * beside the predicate that reads them, so the two can never drift apart (the module's
 * own discipline for `_completionEvidence` applied to this key too). One entry per
 * skipCompletionGate:true call site (grep the repo for that literal to keep this list
 * exhaustive when a new bypass is added):
 *  - 'watchdog-auto-close' (harness/improvements/auto-close.ts)
 *  - 'improvement-hygiene' (harness/improvements/hygiene.ts)
 *  - 'watchdog-orphan-superseded' (harness/improvements/orphaned-dispatch.ts)
 *  - 'hive-bee-exit' (fleet/bee-completion-reconcile.ts)
 *  - 'autonomy-revert' (autonomy/tripwire/revert-executor.ts)
 */
export const KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES: readonly string[] = [
  'watchdog-auto-close',
  'improvement-hygiene',
  'watchdog-orphan-superseded',
  'hive-bee-exit',
  'autonomy-revert',
];

/**
 * EI-18677799334390930: the `by` identity `plan-items/reconcile-linked-work-items.ts`
 * stamps when it terminal-closes a work-item by MIRRORING its linked plan-item's
 * done/dropped status (NOT `skipCompletionGate` — it satisfies the ordinary by+
 * completionRef gate with a synthetic ref). Declared here, in the module that owns
 * the audit predicate, and imported by the reconciler — never re-typed as a bare
 * string in either place — so the write and the read can't drift apart (the exact
 * discipline this module's header describes for `_completionEvidence`).
 *
 * A reconcile-sourced close is BY CONSTRUCTION never independently verified: it only
 * ever mirrors an ADJACENT plan item's terminal status onto this work-item, which is
 * exactly how a mis-flip (the wrong plan item flipped `done`) silently marks a live
 * defect "fixed" with a completionRef that reads as genuine prose (see the module doc
 * above + `auditPredicateSql`'s `no-evidence` branch, which always flags this actor
 * regardless of whether a `_completionEvidence` key is ever added).
 */
export const RECONCILER_SYSTEM_ACTOR = 'system:plan-item-reconcile' as const;

/**
 * WI-5891 — layout/geometry-bearing file extensions for the `geometry-unverified`
 * audit bucket. A `.css` file is unambiguously layout-bearing; `.tsx`/`.jsx` are
 * included too because `filesChanged` carries only PATHS (no diff content to check
 * for an actual `className`/`style` edit more precisely) — deliberately biased
 * toward flagging a touched component file rather than missing a real geometry
 * change. This is the OPPOSITE bias from {@link looksLikeCitedProseEvidence} (which
 * leans toward NOT flagging): an audit DETECTION bucket is cheap to over-flag (a
 * wasted read) but expensive to under-flag (a shipped pixel regression), so the two
 * heuristics in this module correctly point in opposite directions for their
 * respective jobs.
 */
const LAYOUT_BEARING_FILE_RE = /\.(?:css|tsx|jsx)$/i;

/** Pure — does this changed-file list touch a layout/geometry-bearing file? */
export function touchesLayoutBearingFiles(filesChanged: readonly string[] | null | undefined): boolean {
  if (!filesChanged?.length) return false;
  return filesChanged.some((f) => LAYOUT_BEARING_FILE_RE.test(f.trim()));
}

/** `verifiedHow` values that count as a genuine pixel/behavior check for a layout-bearing
 *  change. Everything else (`'unit'`, or the field absent) leaves the change's actual
 *  geometry unverified — the `geometry-unverified` audit fires exactly on that gap. */
const GEOMETRY_VERIFIED_HOW_VALUES = ['integration', 'live-drove-ui', 'manual', 'already-passing'] as const;

/** The `geometry-unverified` WHERE fragment, parameterized on the two jsonb-path
 *  expressions the two callers below alias differently (unaliased vs `ei.`). */
function geometryUnverifiedWhereSql(sql: OrgSql, filesChangedExpr: unknown, verifiedHowExpr: unknown) {
  return sql`(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(${filesChangedExpr as string}, '[]'::jsonb)) AS f
       WHERE f ~* '\\.(css|tsx|jsx)$'
    )
    AND NOT (COALESCE(${verifiedHowExpr as string}, '') = ANY(${GEOMETRY_VERIFIED_HOW_VALUES as unknown as string[]}))
  )`;
}

/**
 * EI-18716652701919665 — title patterns that classify a work-item as a known-intermittent
 * bug. Word-bounded so e.g. "flaky" doesn't also match inside an unrelated word.
 */
const INTERMITTENT_TITLE_RE = /\b(?:intermittent(?:ly)?|flaky|flake|racy|race condition|nondeterministic|non-deterministic)\b/i;

/** Pure — does this title (or other short classification text) mark the underlying bug as
 *  intermittent/flaky/racy? Used by both the SQL bucket and any JS-side caller. */
export function looksLikeIntermittentClassification(title: string | null | undefined): boolean {
  if (!title) return false;
  return INTERMITTENT_TITLE_RE.test(title);
}

/**
 * EI-18716652701919665 — phrases that count as REAL evidence for an intermittent bug: a
 * stated failure rate/percentage, an explicit reference to having measured flakiness, or
 * language indicating an actual root cause + deterministic regression test were found
 * (which makes the bug no longer merely "sampled passing," but understood and pinned).
 * Deliberately narrow/textual, same bias as {@link touchesLayoutBearingFiles}: cheap to
 * over-flag (a wasted read) but expensive to under-flag (a still-flaky bug closed again on
 * another lucky streak).
 */
const INTERMITTENT_EVIDENCE_RE =
  /(\d+(?:\.\d+)?\s*%|failure rate|flake rate|flakiness|historically|root cause|regression test|deterministic repro|observed[^\n]{0,40}fail)/i;

/** Pure — does this completion evidence text (testResult/testsRun) state a failure rate or
 *  root cause, rather than just reporting a streak of consecutive passes? */
export function hasIntermittentFailureRateEvidence(text: string | null | undefined): boolean {
  if (!text) return false;
  return INTERMITTENT_EVIDENCE_RE.test(text);
}

// Postgres ARE equivalents of the two JS regexes above — kept textually parallel so the SQL
// bucket and the pure JS helpers can't silently diverge; `\y` is Postgres's word-boundary atom.
const INTERMITTENT_TITLE_SQL_RE =
  '\\y(intermittent(ly)?|flaky|flake|racy|race condition|nondeterministic|non-deterministic)\\y';
const INTERMITTENT_EVIDENCE_SQL_RE =
  '(\\d+(\\.\\d+)?\\s*%|failure rate|flake rate|flakiness|historically|root cause|regression test|deterministic repro|observed.{0,40}fail)';

/** The `intermittent-underevidenced` WHERE fragment, parameterized on the title + the two
 *  evidence-text jsonb-path expressions the two callers below alias differently (unaliased
 *  vs `ei.`). Only fires when structured evidence EXISTS (testResult/testsRun non-NULL) but
 *  is the wrong SHAPE — a row with no evidence at all is the `no-evidence` bucket's job. */
function intermittentUnderevidencedWhereSql(sql: OrgSql, titleExpr: unknown, testResultExpr: unknown, testsRunExpr: unknown) {
  return sql`(
    ${titleExpr as string} ~* ${INTERMITTENT_TITLE_SQL_RE}
    AND (${testResultExpr as string} IS NOT NULL OR ${testsRunExpr as string} IS NOT NULL)
    AND NOT (
      COALESCE(${testResultExpr as string}, '') ~* ${INTERMITTENT_EVIDENCE_SQL_RE}
      OR COALESCE(${testsRunExpr as string}, '') ~* ${INTERMITTENT_EVIDENCE_SQL_RE}
    )
  )`;
}

/**
 * The audit's WHERE fragment. Callers AND it with their own terminal-state predicate
 * (the two families spell their state column differently — `status` vs `state`).
 *
 * `payload ? key` is the jsonb key-existence operator; both payload columns are jsonb
 * (verified against information_schema), and a NULL payload correctly fails the test,
 * so a row that never carried a payload reads as "no evidence" rather than dropping
 * out of the audit.
 */
export function auditPredicateSql(sql: OrgSql, audit: CompletionAudit) {
  if (audit === 'no-completion-record') return sql`terminal_completion_ref IS NULL AND authority IS NULL`;
  if (audit === 'no-completion-record-suspicious') {
    return sql`terminal_completion_ref IS NULL AND authority IS NULL AND (terminal_owner IS NULL OR NOT (terminal_owner = ANY(${KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES as string[]})))`;
  }
  if (audit === 'geometry-unverified') {
    return geometryUnverifiedWhereSql(
      sql,
      sql.unsafe(`payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->'filesChanged'`),
      sql.unsafe(`payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'verifiedHow'`),
    );
  }
  if (audit === 'intermittent-underevidenced') {
    return intermittentUnderevidencedWhereSql(
      sql,
      sql.unsafe('title'),
      sql.unsafe(`payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'testResult'`),
      sql.unsafe(`payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'testsRun'`),
    );
  }
  // EI-18677799334390930: a reconcile-sourced close (RECONCILER_SYSTEM_ACTOR) is ALWAYS
  // flagged here, independent of the `_completionEvidence` key check — it never carries
  // independent verification by construction (it only mirrors an adjacent plan item's
  // status), so this can't be silently defeated by a future caller adding a well-meaning
  // but misleading evidence stamp to that write path.
  return sql`(NOT (COALESCE(payload, '{}'::jsonb) ? ${TERMINAL_COMPLETION_EVIDENCE_KEY}) OR terminal_owner = ${RECONCILER_SYSTEM_ACTOR})`;
}

/** Same fragment, for a query that aliases the table (e.g. `ei.payload`). */
export function auditPredicateSqlFor(sql: OrgSql, audit: CompletionAudit, alias: string) {
  const col = sql.unsafe(`${alias}.payload`);
  const ref = sql.unsafe(`${alias}.terminal_completion_ref`);
  const owner = sql.unsafe(`${alias}.terminal_owner`);
  const authority = sql.unsafe(`${alias}.authority`);
  if (audit === 'no-completion-record') return sql`${ref} IS NULL AND ${authority} IS NULL`;
  if (audit === 'no-completion-record-suspicious') {
    return sql`${ref} IS NULL AND ${authority} IS NULL AND (${owner} IS NULL OR NOT (${owner} = ANY(${KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES as string[]})))`;
  }
  if (audit === 'geometry-unverified') {
    return geometryUnverifiedWhereSql(
      sql,
      sql.unsafe(`${alias}.payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->'filesChanged'`),
      sql.unsafe(`${alias}.payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'verifiedHow'`),
    );
  }
  if (audit === 'intermittent-underevidenced') {
    return intermittentUnderevidencedWhereSql(
      sql,
      sql.unsafe(`${alias}.title`),
      sql.unsafe(`${alias}.payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'testResult'`),
      sql.unsafe(`${alias}.payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'testsRun'`),
    );
  }
  // EI-18677799334390930: same always-flag rule as auditPredicateSql above.
  return sql`(NOT (COALESCE(${col}, '{}'::jsonb) ? ${TERMINAL_COMPLETION_EVIDENCE_KEY}) OR ${owner} = ${RECONCILER_SYSTEM_ACTOR})`;
}

/**
 * EI-13424 — `no-evidence`'s OWN false-positive rate.
 *
 * The predicate above is exact and cheap (it must stay that way — see the module
 * doc), but it answers a narrower question than its name implies: "does this row
 * carry the STRUCTURED `_completionEvidence` key", not "was this work actually
 * verified". `work_items:complete`'s free-text `completion.summary` is exactly where
 * an agent naturally writes real verification detail instead of the structured
 * fields — a cited commit sha, a specific file:line, an observed tool call + its
 * result, a measured test-count ratio, a drillId/session id. Three such completions
 * were nearly RE-OPENED by a DRAIN leader mechanically following the "re-open bare
 * assertions" mandate on every `no-evidence` hit, because the audit has no way to
 * tell "never said how" apart from "said how, in prose".
 *
 * This is a SEPARATE, best-effort SIGNAL — not a replacement for the SQL predicate,
 * and not itself proof of verification. A caller (the DRAIN leader's spot-audit, or
 * any consumer of `work_items:list { audit }`) checks it on each returned row BEFORE
 * acting: `looksLikeCitedProseEvidence(row.terminalCompletionRef)` true means the
 * ref itself cites something a fabricated one-line "done" would not contain, and the
 * row deserves a read before a reopen, not a mechanical one.
 *
 * Deliberately biased toward NOT flagging a ref as evidenced: the harm this exists to
 * prevent is over-detecting BARENESS on well-evidenced prose (the false positive that
 * burns fleet time re-doing verified work and erodes trust in the audit) — so both the
 * length floor and the citation-pattern requirement lean toward the direction that is
 * safe to get wrong here (an under-flagged genuinely-bare close stays correctly
 * flagged with no evidence signal; it is not silently waved through by this function —
 * it is still a `no-evidence` audit hit either way, just without the extra signal).
 */
export const PROSE_EVIDENCE_MIN_LENGTH = 100;

const PROSE_EVIDENCE_PATTERNS: readonly RegExp[] = [
  // A file:line / file(line — a specific source location, e.g. "run.ts:204" or "foo.tsx(12,".
  /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|sql|md|mdx|json|yml|yaml)[:(]\d+/i,
  // A tool call, colon-form, e.g. "session:carry-drill(" or "events:status { event }".
  /\b[a-z][a-z_]*(?::[a-z][a-z_-]*)+\s*[({]/i,
  // A measured test-count ratio, e.g. "9/9 green" or "26/26 passed".
  /\b\d{1,4}\s*\/\s*\d{1,4}\b/,
  // A uuid / drillId.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  // A commit sha (7+ hex chars) — long enough that a plain word collision is very rare.
  /\b[0-9a-f]{7,40}\b/i,
  // An ISO timestamp, e.g. "2026-07-17T03:2".
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
];

/**
 * Does this completion ref look like it cites verifiable evidence, despite carrying
 * no structured `_completionEvidence`? Pure, synchronous, no I/O — see the doc above
 * for what this is (a caller-facing signal) and is NOT (proof, or a replacement for
 * the SQL predicate).
 */
export function looksLikeCitedProseEvidence(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const text = ref.trim();
  if (text.length < PROSE_EVIDENCE_MIN_LENGTH) return false;
  return PROSE_EVIDENCE_PATTERNS.some((re) => re.test(text));
}

/**
 * WI-5891 — the COMPLETION-BOUNDARY hard gate the fleet leader's P-014 audit asked
 * for, as the enforceable half of the WI-5874/P-001 incident: `verifiedHow:
 * 'live-drove-ui'` was claimed while citing only two vitest runs, with no screenshot
 * artifact anywhere on the host — unit tests verify STRUCTURE, and this bug was
 * structure-passing, pixel-failing. A doc paragraph asking agents to remember to
 * screenshot next time does not bind (proven the same hour it was written); this
 * does, because `work_items:complete` calls it before it lets a close land.
 *
 * Unlike every other check in this module (and everything else in
 * `work_items:complete`, EI-24's "record-and-warn, never hard-reject" discipline),
 * THIS one is a genuine reject: a `live-drove-ui` claim that cites nothing real is
 * refused, not just flagged. That is a deliberate, narrow exception — scoped to
 * exactly one closed enum value making one specific, checkable factual claim ("I
 * drove the running UI"), not a general tightening of the completion contract.
 *
 * "Cites something real" is checked against the free-text fields an agent naturally
 * writes an artifact reference into (`testsRun`, `testResult`) and `filesChanged` (a
 * screenshot saved alongside the change) — see {@link citesScreenshotArtifact} for the
 * patterns. Pure + synchronous so the gate and its own unit test can never drift.
 */
const SCREENSHOT_ARTIFACT_PATTERNS: readonly RegExp[] = [
  // An image artifact path — a screenshot/capture output file.
  /[\w./-]+\.(?:png|jpe?g|webp|gif)\b/i,
  // A tauri-agent-tools invocation recorded in the run (capture/screenshot/check subcommands
  // — see /internal/docs/testing/agent-e2e), e.g. "tauri-agent-tools capture --out shot.png".
  /\btauri-agent-tools\b[^\n]{0,80}\b(?:capture|screenshot|check)\b/i,
  // A bare "screenshot"/"capture" mention paired with an image path in the same clause.
  /\b(?:screenshot|capture)\b[^\n]{0,80}\.(?:png|jpe?g|webp|gif)\b/i,
];

/** Does this piece of completion text cite a real screenshot/capture artifact? */
export function citesScreenshotArtifact(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  return SCREENSHOT_ARTIFACT_PATTERNS.some((re) => re.test(t));
}

/**
 * Is a `verifiedHow: 'live-drove-ui'` claim BACKED by a real artifact citation?
 * Returns `true` (nothing to enforce) for every OTHER `verifiedHow` value, including
 * absent — this gate is scoped narrowly to the one enum member making the specific
 * factual claim "I drove the running UI and looked at it".
 */
export function isBackedLiveDroveUiClaim(evidence: CompletionVerificationEvidence | null | undefined): boolean {
  if (!evidence || evidence.verifiedHow !== 'live-drove-ui') return true;
  if (citesScreenshotArtifact(evidence.testsRun)) return true;
  if (citesScreenshotArtifact(evidence.testResult)) return true;
  if (evidence.filesChanged?.some((f) => citesScreenshotArtifact(f))) return true;
  return false;
}

/**
 * EI-18676290701611705 — the synthetic `terminal_completion_ref` ANY `skipCompletionGate`
 * bypass stamps when the caller supplied none. `skipCompletionGate` exists for a small,
 * TRUSTED set of non-completion transitions (watchdog auto-close, hygiene sweep,
 * orphaned-dispatch reconciliation, a tripwire revert, a bee-exit reconcile) that must
 * NOT claim a genuine completion — by design they call `setWorkItemState`/`setIssueState`
 * with `completionRef` omitted. Before this, that meant the column was written NULL, so
 * the `no-completion-record` audit (`terminal_completion_ref IS NULL`) could fire on a
 * MAJOR, human-filed bug that closed through one of these paths, with nothing left to
 * distinguish "a sanctioned system bypass" from "a bare assertion no one investigated" —
 * exactly the ambiguity a DRAIN leader hit on EI-18673480587329034 (a real, verified fix,
 * closed with both `completion` and `terminal_completion_ref` empty).
 *
 * This is deliberately NOT prose evidence — it names the bypass + the closing actor + a
 * timestamp, so the audit can never again find a bare-NULL ref for a sanctioned system
 * write, while `looksLikeCitedProseEvidence` still correctly reads it as non-evidence
 * (it carries none of the file:line / test-ratio / sha / uuid citation patterns) — a
 * reader can tell at a glance "system bypass, not a real fix" rather than mistaking it
 * for genuine verification.
 */
export function skipGateCompletionRef(by: string | null | undefined): string {
  return (
    `[SYSTEM-BYPASS] non-completion state transition by '${by ?? 'unknown'}' at ${new Date().toISOString()}` +
    ' (skipCompletionGate — not a genuine completion; see work-item-completion-integrity-2026-07-01 WI-1403)'
  );
}

/**
 * Resolve the completionRef to actually WRITE for a terminal transition: the caller's own
 * ref when non-empty, else — ONLY when `skipCompletionGate` is set — the synthetic marker
 * above, so a sanctioned bypass never leaves the column truly empty. Returns the input
 * unchanged (including null/undefined) when the gate is NOT bypassed, matching the existing
 * `completionRef ?? null` write shape exactly for every caller that already enforces the
 * completion-integrity gate before calling this.
 */
export function resolveTerminalCompletionRef(
  completionRef: string | null | undefined,
  opts: { skipCompletionGate?: boolean; by?: string | null },
): string | null | undefined {
  if (completionRef && completionRef.trim()) return completionRef;
  if (opts.skipCompletionGate) return skipGateCompletionRef(opts.by);
  return completionRef;
}
