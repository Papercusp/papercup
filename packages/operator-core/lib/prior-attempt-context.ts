/**
 * Canonical prior-attempt context compiler (P-009, D-007/D-008).
 *
 * This is deliberately a projection over existing authority, not another history
 * store.  The collector reads spec revisions, plan decisions, exact spec-evidence
 * edges, work-item lifecycle/checkpoints/comments/completions, and release
 * provenance.  The pure compiler then normalizes, deduplicates and orders those
 * facts.  Claim-time payload budgeting belongs to the consumer (P-010); this
 * module exposes stable priorities and raw references so truncation cannot change
 * authority or make the omitted source impossible to retrieve.
 */
import { createHash } from 'node:crypto';
import { getPlanRow } from './agent-tools/plans/source';
import { parsePlan } from './agent-tools/plans/parser';
import { listSpecClauses, type SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';
import { listSpecEvidence, listWorkItemSpecRevisionEdges } from './agent-tools/plans/spec-evidence-store';
import { getWorkItem, getWorkItemThreadWindow, listWorkItems, type WorkItem } from './work-items';
import { getWorkItemCheckpointWithMeta, getWorkItemCheckpointJournal } from './work-item-checkpoint';
import { getWorkItemLifecycleHistory } from './work-item-lifecycle-history';
import { getClaimTimePriorWorkHint } from './work-item-prior-work';
import { resolveConcreteWorkspaceId } from './workspace-registry';
import { boundedLine, extractPriorAttemptRungs, retractionText } from './prior-attempt-rungs';
import {
  resolveContainmentTree,
  type ContainmentDirection,
  type ContainmentRef,
  type ContainmentTree,
} from './containment-tree';
import { readEffortThread } from './effort-thread';

export type { PriorAttemptRungs } from './prior-attempt-rungs';
export { extractPriorAttemptRungs } from './prior-attempt-rungs';

/**
 * DISTANCE FROM THE REQUESTED REF, nearest first (P-018 / D-007).
 *
 * This was a PLAN-ANCHORED ladder ('same-spec' | 'same-plan-item' | 'plan-wide'),
 * which could only describe a work-item that carried a plan pointer. Measured
 * 2026-09-02: of 16,792 open items, 15,791 (94.0%) carry neither a plan nor a goal —
 * so the old vocabulary had no word for the position of 94% of this system's work, and
 * `getClaimTimePriorAttemptBrief` returned null rather than say it.
 *
 * The rungs are now positions in the containment tree (see ./containment-tree):
 *  - `self`            the requested ref's OWN history. Always available, plan or no plan.
 *  - `same-spec`       a different item bound to one of the requested item's target specs.
 *  - `same-plan-item`  a different item implementing the same plan item.
 *  - `plan-wide`       the plan level itself (decisions, its thread) and its other items.
 *  - `goal-wide`       the goal level and what hangs off it — ADMITTED, not tuned (D-020).
 */
export type PriorAttemptScope = 'self' | 'same-spec' | 'same-plan-item' | 'plan-wide' | 'goal-wide';
export type PriorAttemptAuthority =
  | 'current-spec'
  | 'spec-revision'
  | 'plan-decision'
  | 'retraction'
  | 'verified-completion'
  | 'checkpoint'
  | 'lifecycle'
  | 'release-provenance'
  | 'comment';

export interface PriorAttemptSource {
  scope: PriorAttemptScope;
  authority: PriorAttemptAuthority;
  rawRef: string;
  workItemId?: string | null;
  specId?: string | null;
  specRevision?: number | null;
  planItemId?: string | null;
  at?: string | null;
  actor?: string | null;
  text: string;
  /**
   * D-008 ROLLUP DEPTH — hops DOWNWARD from the requested ref, and the only field
   * the compression ladder spends against. 0 (default) means full resolution.
   *
   * ⚠ Deliberately NOT "distance in the containment tree". Anything reached through
   * an ANCESTOR — a plan decision, the plan's thread, a plan sibling's checkpoint —
   * stays at 0, because those are already bounded by `maxPlanWorkItems` and are the
   * behaviour a member's claim has always received. Charging them depth would strip
   * text from a plan-backed claim that gets it today: a regression dressed as a
   * budget fix. Depth is spent ONLY on the descendant closure, which is where D-008
   * measured the unbounded cost (the worst plan here carries 126 items, rolling up
   * ~167k chars) and which only a LEADER read ever requests.
   */
  depth?: number;
  /** Explicit source metadata (evidence refs, lifecycle detail, fingerprints). */
  detail?: Record<string, unknown> | null;
}

export interface PriorAttemptRecord extends PriorAttemptSource {
  id: string;
  approach: string | null;
  outcome: string | null;
  rootCauses: string[];
  falsePremises: string[];
  touchedFiles: string[];
  tests: string[];
  residue: string[];
}

export interface PriorAttemptCompilation {
  records: PriorAttemptRecord[];
  sourceCount: number;
  deduplicatedCount: number;
  byScope: Record<PriorAttemptScope, number>;
  byAuthority: Record<PriorAttemptAuthority, number>;
  fingerprint: string;
}

export interface PriorAttemptBriefRecord {
  authority: PriorAttemptAuthority;
  scope: PriorAttemptScope;
  rawRef: string;
  workItemId?: string | null;
  specId?: string | null;
  specRevision?: number | null;
  at?: string | null;
  text: string;
  approach?: string | null;
  outcome?: string | null;
  rootCauses?: string[];
  falsePremises?: string[];
  touchedFiles?: string[];
  tests?: string[];
  /** P-017: this record's `text` was clipped to the budget — `rawRef` still
   * resolves to the full source via resolvePriorAttemptRefs(). */
  textTruncated?: boolean;
  /** P-017: length of the full normalized source text, so a reader can size the
   * drill-down before paying for it. */
  fullTextChars?: number;
  /** D-008 rollup depth this record was rendered at. Absent/0 = full resolution;
   * ≥1 means fields were dropped BY DESIGN, not by budget pressure, and `rawRef`
   * still resolves to everything. */
  depth?: number;
}

/** P-017: an omitted record, reduced to what makes it RETRIEVABLE. */
export interface PriorAttemptOmittedRef {
  authority: PriorAttemptAuthority;
  scope: PriorAttemptScope;
  rawRef: string;
  workItemId?: string | null;
  specId?: string | null;
  at?: string | null;
  /**
   * WHY this record is not inline. `budget` = the brief ran out of room.
   * `empty-at-depth` = D-010's explicit degradation — the record survives at its
   * rollup depth only as rungs the writer never populated, so it would have been a
   * hollow row. The distinction matters: `budget` says "raise the budget to see
   * this", `empty-at-depth` says "there is nothing here to see at this resolution —
   * read it at its own level."
   */
  reason?: 'budget' | 'empty-at-depth';
}

export interface BoundedPriorAttemptBrief {
  schemaVersion: 'prior-attempt-brief-v1';
  fingerprint: string;
  /** Canonical sources survive before ordinary attempt detail under pressure. */
  authority: PriorAttemptBriefRecord[];
  /** Residue is lifted out of records so a truncated attempt cannot hide it. */
  residue: Array<{ rawRef: string; workItemId?: string | null; items: string[] }>;
  attempts: PriorAttemptBriefRecord[];
  rawRefs: string[];
  /** Lossless authority/residue drill-down refs survive even when their inline
   * detail must be compressed out of an extreme history. */
  protectedRefs: {
    authority: Array<{ authority: PriorAttemptAuthority; rawRef: string }>;
    residue: string[];
  };
  omission: {
    omittedRecords: number;
    omittedByAuthority: Partial<Record<PriorAttemptAuthority, number>>;
    /** P-017: the refs of the records this brief left out.  A COUNT tells the
     * reader that history was dropped but not WHICH history, which makes the
     * omission unauditable; these refs resolve through
     * resolvePriorAttemptRefs().  Bounded independently of the record budget —
     * a ref is ~100 bytes against a record's ~700. */
    omittedRefs: PriorAttemptOmittedRef[];
    /** P-017: true when even `omittedRefs` had to be cut.  Without this an
     * exhausted ref list is indistinguishable from a complete one. */
    omittedRefsTruncated: boolean;
    sourceCount: number;
    deduplicatedCount: number;
    truncated: boolean;
  };
  estimatedTokens: number;
  serializedChars: number;
}

export interface PriorAttemptBriefBudget {
  maxChars?: number;
  maxRecords?: number;
  maxTextChars?: number;
}

/** Nearest-first (P-018 keeps this ordering property; only the rungs changed).
 *  `self` leads because the claimant's own prior trajectory is the single record
 *  most likely to stop it re-doing finished work — and for the 94% orphan case it
 *  is the ONLY rung that exists. */
const SCOPE_RANK: Record<PriorAttemptScope, number> = {
  self: 0,
  'same-spec': 1,
  'same-plan-item': 2,
  'plan-wide': 3,
  'goal-wide': 4,
};

// D-008: this order is authority, not a relevance guess.  In particular, a
// semantic/comment summary can never outrank a retraction or current spec.
const AUTHORITY_RANK: Record<PriorAttemptAuthority, number> = {
  'current-spec': 0,
  'plan-decision': 1,
  retraction: 2,
  'spec-revision': 3,
  'verified-completion': 4,
  checkpoint: 5,
  lifecycle: 6,
  'release-provenance': 7,
  comment: 8,
};

const CANONICAL_AUTHORITY = new Set<PriorAttemptAuthority>(['current-spec', 'plan-decision', 'retraction']);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

function normalizedRecord(source: PriorAttemptSource): PriorAttemptRecord {
  const text = source.text.trim();
  const isCompletion = source.authority === 'verified-completion';
  const isCheckpoint = source.authority === 'checkpoint';
  const id = createHash('sha256')
    .update(
      `${source.rawRef}\0${source.authority}\0${source.scope}\0${text}\0${JSON.stringify(canonicalValue(source.detail ?? null))}`,
    )
    .digest('hex')
    .slice(0, 20);
  const rungs = extractPriorAttemptRungs(text);
  return {
    ...source,
    text,
    id,
    depth: source.depth ?? 0,
    approach: isCheckpoint || source.authority === 'comment' ? boundedLine(text) || null : null,
    outcome: isCompletion ? boundedLine(text) || null : null,
    rootCauses: rungs.rootCauses,
    falsePremises: rungs.falsePremises,
    touchedFiles: rungs.touchedFiles,
    tests: rungs.tests,
    residue: rungs.residue,
  };
}

function atMs(at: string | null | undefined): number {
  const n = at ? Date.parse(at) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Pure canonical normalization/order seam. */
export function compilePriorAttempts(sources: readonly PriorAttemptSource[]): PriorAttemptCompilation {
  const byIdentity = new Map<string, PriorAttemptRecord>();
  for (const source of sources) {
    const record = normalizedRecord(source);
    if (!record.text) continue;
    // A raw authority ref denotes one fact.  If a caller accidentally supplies it
    // twice, retain the fresher/richer form instead of spending claim budget twice.
    const key = `${record.authority}\0${record.rawRef}`;
    const prior = byIdentity.get(key);
    if (!prior || atMs(record.at) > atMs(prior.at) || record.text.length > prior.text.length) {
      byIdentity.set(key, record);
    }
  }
  const records = [...byIdentity.values()].sort((a, b) => {
    const aCanonical = CANONICAL_AUTHORITY.has(a.authority) ? 0 : 1;
    const bCanonical = CANONICAL_AUTHORITY.has(b.authority) ? 0 : 1;
    return (
      aCanonical - bCanonical ||
      (aCanonical === 0
        ? AUTHORITY_RANK[a.authority] - AUTHORITY_RANK[b.authority] || SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]
        : SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || AUTHORITY_RANK[a.authority] - AUTHORITY_RANK[b.authority]) ||
      atMs(b.at) - atMs(a.at) ||
      a.rawRef.localeCompare(b.rawRef)
    );
  });
  const byScope = {
    self: 0,
    'same-spec': 0,
    'same-plan-item': 0,
    'plan-wide': 0,
    'goal-wide': 0,
  } satisfies Record<PriorAttemptScope, number>;
  const byAuthority = Object.fromEntries(
    (Object.keys(AUTHORITY_RANK) as PriorAttemptAuthority[]).map((key) => [key, 0]),
  ) as Record<PriorAttemptAuthority, number>;
  for (const record of records) {
    byScope[record.scope] += 1;
    byAuthority[record.authority] += 1;
  }
  const fingerprint = createHash('sha256')
    .update(records.map((r) => `${r.id}:${r.at ?? ''}`).join('\n'))
    .digest('hex');
  return {
    records,
    sourceCount: sources.length,
    deduplicatedCount: sources.length - records.length,
    byScope,
    byAuthority,
    fingerprint,
  };
}

/**
 * D-008's compression ladder, as a FIELD SELECTION per rollup depth.
 *
 * "A read of ANY level costs the same fixed budget. What changes with depth is
 * RESOLUTION, not volume — zooming out on a map buys less detail per feature, not
 * more ink."
 *
 * ⚠ D-010 corrects D-008 on one point and this function implements the correction:
 * the deep rungs are keyword-derived and EMPTY in ~19 of every 20 records, so
 * "keep only rootCauses + falsePremises" mostly keeps an empty record. A hollow
 * record is worse than an omitted one — it spends bytes to tell the reader nothing
 * while looking like history was delivered. So depth ≥ 2 with both rungs empty
 * returns `null`, and the caller discloses it as an omission with a REASON.
 */
function briefRecordAtDepth(record: PriorAttemptRecord, maxTextChars: number): PriorAttemptBriefRecord | null {
  const depth = record.depth ?? 0;
  if (depth <= 0) return briefRecord(record, maxTextChars);
  const base = {
    authority: record.authority,
    scope: record.scope,
    rawRef: record.rawRef,
    workItemId: record.workItemId,
    specId: record.specId,
    at: record.at,
    depth,
  };
  if (depth === 1) {
    // One level down: drop `text`, keep the summary pair. Both are themselves
    // keyword/first-line derived, so an empty pair here still degrades to the
    // ref-only shape rather than pretending to a summary it does not have.
    const approach = record.approach ? boundedLine(record.approach, Math.min(maxTextChars, 500)) : null;
    const outcome = record.outcome ? boundedLine(record.outcome, Math.min(maxTextChars, 500)) : null;
    if (!approach && !outcome && !record.rootCauses.length && !record.falsePremises.length) return null;
    return {
      ...base,
      text: '',
      ...(approach ? { approach } : {}),
      ...(outcome ? { outcome } : {}),
      ...(record.rootCauses.length ? { rootCauses: record.rootCauses } : {}),
      ...(record.falsePremises.length ? { falsePremises: record.falsePremises } : {}),
    };
  }
  // Two or more levels down: only the fields that STOP A REPEAT survive.
  if (!record.rootCauses.length && !record.falsePremises.length) return null;
  return {
    ...base,
    text: '',
    ...(record.rootCauses.length ? { rootCauses: record.rootCauses } : {}),
    ...(record.falsePremises.length ? { falsePremises: record.falsePremises } : {}),
  };
}

function briefRecord(record: PriorAttemptRecord, maxTextChars: number): PriorAttemptBriefRecord {
  const text = boundedLine(record.text, maxTextChars);
  const out: PriorAttemptBriefRecord = {
    authority: record.authority,
    scope: record.scope,
    rawRef: record.rawRef,
    workItemId: record.workItemId,
    specId: record.specId,
    specRevision: record.specRevision,
    at: record.at,
    text,
  };
  // P-017: a clipped body is a DIFFERENT claim, not a shorter one — a record
  // whose retraction lives past the cut reads as endorsement.  Mark it so the
  // reader knows `rawRef` still has more, and can drill down for the full text.
  if (text.length < record.text.replace(/\s+/g, ' ').trim().length) {
    out.textTruncated = true;
    out.fullTextChars = record.text.replace(/\s+/g, ' ').trim().length;
  }
  if (record.approach) out.approach = boundedLine(record.approach, Math.min(maxTextChars, 500));
  if (record.outcome) out.outcome = boundedLine(record.outcome, Math.min(maxTextChars, 500));
  if (record.rootCauses.length) out.rootCauses = record.rootCauses;
  if (record.falsePremises.length) out.falsePremises = record.falsePremises;
  if (record.touchedFiles.length) out.touchedFiles = record.touchedFiles;
  if (record.tests.length) out.tests = record.tests;
  return out;
}

function briefSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** P-017: how many omitted-record refs a brief carries before it must itself
 * truncate.  Deliberately generous relative to `maxRecords` — a ref costs ~100
 * bytes against a record's ~700, so retrievability is cheap next to detail. */
const OMITTED_REF_CAP = 200;

/**
 * P-021 — THE CLAIM-TIME TOKEN CEILING. This plan named none anywhere, which is the
 * gap D-008's "fixed budget" rule needed a number for. It is stated here, in code,
 * beside the budget it governs, and asserted by a test.
 *
 * 12_500 tokens = the 50_000-char default at the ~4 chars/token estimate this module
 * already uses. Against the 250_000-token fleet-member compaction cap (WI-2142006)
 * that is 5% of a member's whole context spent at claim.
 *
 * BASELINE FOR THE NUMBER, measured: the budget was 14_000 chars (~3,500 tokens,
 * ~1.75% of the then-200k cap) and WI-40078 measured live overhead at avg 2,922 /
 * P95 3,482 tokens with 16 of 20 briefs TRUNCATED and ~7.5 detail records dropped
 * each — i.e. the common case was a truncated brief, not a fitted one. WI-2142006
 * then raised the budget to 50_000 and the member cap to 250_000.
 */
export const CLAIM_BRIEF_TOKEN_CEILING = 12_500;

/**
 * P-021 — THE ORPHAN CEILING, and the reason it is separate.
 *
 * 50_000 chars was inherited from a surface serving the 5.8% of items that carry a
 * plan, where a brief legitimately compiles specs, decisions and 16 siblings. P-018
 * extends delivery to the other 94%, whose measured history is far thinner: 1.38
 * posts per issue thread, avg 962 chars, p90 2,705 (2026-09-02). Letting the orphan
 * case inherit the plan-backed budget would hand 94% of claims a ceiling sized for a
 * population they are not in — the exact mistake D-006 caught when the plan was
 * keyed to plan slugs.
 *
 * 12_000 chars (~3,000 tokens, 1.2% of the member cap) is sized from what an orphan
 * can actually hold: its own checkpoint, up to CARRY_JOURNAL_MAX_ENTRIES (15) ring
 * entries capped at 600 chars each (9,000 worst case), its thread window, and its
 * lifecycle. That covers the realistic worst orphan whole and is 4× smaller than the
 * budget it must not inherit.
 */
export const ORPHAN_CLAIM_BRIEF_BUDGET: Required<PriorAttemptBriefBudget> = {
  maxChars: 12_000,
  maxRecords: 24,
  maxTextChars: 700,
};

/**
 * Bounded claim-time projection.  Budgeting is deterministic and omission is
 * explicit.  Canonical authority and lifted residue are admitted before ordinary
 * attempt detail.  If even the protected set is unusually large, text shrinks to
 * short snippets but stable raw refs remain for every protected fact.
 */
export function buildBoundedPriorAttemptBrief(
  compilation: PriorAttemptCompilation,
  budget: PriorAttemptBriefBudget = {},
  includeEmpty = false,
): BoundedPriorAttemptBrief | null {
  if (!compilation.records.length && !includeEmpty) return null;
  // 50_000 CHARS (owner directive 2026-09-02, WI-2142006), up from 14_000.
  // WI-40078 measured the 14k budget BINDING on 16 of 20 sampled live claims,
  // dropping an average of 7.5 detail records each — i.e. the common case was a
  // truncated brief, not a fitted one. No claim site passes a budget (claim.ts,
  // claim_next.ts, scheduler/get_next.ts all call with none), so this default IS
  // the live claim-time ceiling.
  //
  // ⚠ 50_000 will often NOT be the operative bound. A record costs up to
  // maxTextChars (700) + approach (≤500) + outcome (≤500) + its ref arrays, so
  // maxRecords (48) caps a brief around 34k–58k chars depending on content. Raise
  // maxRecords too if you need the char budget to be the real limit; it was
  // deliberately left alone here because it was not part of the directive.
  const maxChars = Math.max(2_000, budget.maxChars ?? 50_000);
  const maxRecords = Math.max(1, budget.maxRecords ?? 48);
  const maxTextChars = Math.max(80, budget.maxTextChars ?? 700);
  const protectedRecords = compilation.records.filter((record) => CANONICAL_AUTHORITY.has(record.authority));
  const ordinaryRecords = compilation.records.filter((record) => !CANONICAL_AUTHORITY.has(record.authority));
  const residue = compilation.records
    .filter((record) => record.residue.length > 0)
    .map((record) => ({ rawRef: record.rawRef, workItemId: record.workItemId, items: record.residue }));
  const authority: PriorAttemptBriefRecord[] = [];
  const attempts: PriorAttemptBriefRecord[] = [];
  const rawRefs: string[] = [];
  const protectedRefs = {
    authority: protectedRecords.map((record) => ({ authority: record.authority, rawRef: record.rawRef })),
    residue: residue.map((entry) => entry.rawRef),
  };
  const omitted = new Map<PriorAttemptAuthority, number>();
  // P-017: identity of every dropped record, not just its tally.  Keyed by
  // rawRef because a record can be rejected twice (budget, then envelope
  // overflow) and must not be double-counted as two distinct omissions.
  const omittedRefs = new Map<string, PriorAttemptOmittedRef>();
  const dropRecord = (record: PriorAttemptRecord, reason: 'budget' | 'empty-at-depth' = 'budget') => {
    if (omittedRefs.has(record.rawRef)) return;
    omitted.set(record.authority, (omitted.get(record.authority) ?? 0) + 1);
    omittedRefs.set(record.rawRef, {
      authority: record.authority,
      scope: record.scope,
      rawRef: record.rawRef,
      workItemId: record.workItemId,
      specId: record.specId,
      at: record.at,
      reason,
    });
  };
  let admitted = 0;

  // Assemble against a pessimistic envelope, then fill ordinary detail from the
  // remaining bytes. Protected rows use a compact fallback rather than omission.
  const envelope = () => ({
    schemaVersion: 'prior-attempt-brief-v1' as const,
    fingerprint: compilation.fingerprint,
    authority,
    residue,
    attempts,
    rawRefs,
    protectedRefs,
    omission: {
      omittedRecords: compilation.records.length - admitted,
      omittedByAuthority: {},
      // P-017: DELIBERATELY empty during admission. The ref list is metadata
      // ABOUT history already dropped, so it must never compete for bytes with
      // the history still being kept — it is refilled from the leftovers after
      // the content bound is enforced (see the refill pass below).
      omittedRefs: [] as PriorAttemptOmittedRef[],
      omittedRefsTruncated: false,
      sourceCount: compilation.sourceCount,
      deduplicatedCount: compilation.deduplicatedCount,
      truncated: admitted < compilation.records.length,
    },
    estimatedTokens: 0,
    serializedChars: 0,
  });

  for (const record of protectedRecords) {
    const full = briefRecord(record, maxTextChars);
    authority.push(full);
    rawRefs.push(record.rawRef);
    admitted += 1;
    if (briefSize(envelope()) > maxChars) {
      authority[authority.length - 1] = briefRecord(record, 96);
    }
  }
  // Residue is protected independently. Bound individual residue prose but never
  // remove its rawRef or the fact that residue exists.
  for (const entry of residue) entry.items = entry.items.map((item) => boundedLine(item, 160));

  for (const record of ordinaryRecords) {
    // D-008 ladder + D-010's honest degradation: a record whose rollup depth leaves it
    // with nothing but empty rungs is DISCLOSED, never rendered hollow.
    //
    // ⚠ THIS RUNS BEFORE THE BUDGET CHECK, deliberately. Ordered the other way, a
    // record that renders to NOTHING at its depth gets labelled `budget` once the
    // record cap is reached — telling the reader to raise the budget to see something
    // that would still be empty, and burning an admission slot a record with real
    // content could have used. An empty projection costs no bytes, so it cannot be a
    // budget casualty.
    const projected = briefRecordAtDepth(record, maxTextChars);
    if (!projected) {
      dropRecord(record, 'empty-at-depth');
      continue;
    }
    if (admitted >= maxRecords) {
      dropRecord(record);
      continue;
    }
    attempts.push(projected);
    rawRefs.push(record.rawRef);
    admitted += 1;
    if (briefSize(envelope()) > maxChars) {
      attempts.pop();
      rawRefs.pop();
      admitted -= 1;
      dropRecord(record);
    }
  }
  const omittedRecords = compilation.records.length - admitted;
  const result: BoundedPriorAttemptBrief = {
    schemaVersion: 'prior-attempt-brief-v1',
    fingerprint: compilation.fingerprint,
    authority,
    residue,
    attempts,
    rawRefs: [...new Set(rawRefs)],
    protectedRefs,
    omission: {
      omittedRecords,
      omittedByAuthority: Object.fromEntries([...omitted].filter(([, count]) => count > 0)),
      omittedRefs: [],
      omittedRefsTruncated: false,
      sourceCount: compilation.sourceCount,
      deduplicatedCount: compilation.deduplicatedCount,
      truncated: omittedRecords > 0,
    },
    estimatedTokens: 0,
    serializedChars: 0,
  };
  // P-017: refs for records dropped by the admit loop, plus any the enforcement
  // pass below removes. Held OUTSIDE `result` until the content bound is met.
  const pendingRefs: PriorAttemptOmittedRef[] = [...omittedRefs.values()];
  const noteOmitted = (entry: PriorAttemptBriefRecord) => {
    result.omission.omittedByAuthority[entry.authority] =
      (result.omission.omittedByAuthority[entry.authority] ?? 0) + 1;
    result.omission.omittedRecords += 1;
    result.omission.truncated = true;
    // A record the FINAL bound removed is just as omitted as one the admit loop
    // rejected, and just as much in need of a way back to its source.
    if (!pendingRefs.some((ref) => ref.rawRef === entry.rawRef)) {
      pendingRefs.push({
        authority: entry.authority,
        scope: entry.scope,
        rawRef: entry.rawRef,
        workItemId: entry.workItemId,
        specId: entry.specId,
        at: entry.at,
        reason: 'budget',
      });
    }
  };
  // Enforce the advertised bound against the FINAL serialized shape. Protected
  // facts keep lossless refs even when their inline detail is the part removed.
  while (briefSize(result) > maxChars && result.attempts.length > 0) {
    const removed = result.attempts.pop()!;
    result.rawRefs = result.rawRefs.filter((ref) => ref !== removed.rawRef);
    noteOmitted(removed);
  }
  while (briefSize(result) > maxChars && result.residue.length > 0) {
    const entry = result.residue[result.residue.length - 1]!;
    if (entry.items.some((item) => item.length > 64)) {
      entry.items = entry.items.map((item) => boundedLine(item, 64));
    } else {
      result.residue.pop();
    }
  }
  while (briefSize(result) > maxChars && result.authority.length > 0) {
    const entry = result.authority[result.authority.length - 1]!;
    if (
      entry.text.length > 64 ||
      entry.approach ||
      entry.outcome ||
      entry.rootCauses ||
      entry.falsePremises ||
      entry.touchedFiles ||
      entry.tests
    ) {
      result.authority[result.authority.length - 1] = {
        authority: entry.authority,
        scope: entry.scope,
        rawRef: entry.rawRef,
        text: boundedLine(entry.text, 64),
      };
    } else {
      result.authority.pop();
      result.rawRefs = result.rawRefs.filter((ref) => ref !== entry.rawRef);
      noteOmitted(entry);
    }
  }
  // P-017 refill, LAST and lowest-priority. Every omitted record should be
  // retrievable, but never at the cost of a fact still being reported: a ref
  // list admitted alongside content can outgrow the budget faster than content
  // can be stripped, and the enforcement pass above then strips the protected
  // canonical rows to pay for it — measured at 8.5KB of refs inside a 5KB
  // budget, with every current-spec/decision/retraction row evicted. So refs
  // buy only the bytes the content did not want, and any shortfall is
  // DISCLOSED rather than silently shortening the list.
  for (const ref of pendingRefs.slice(0, OMITTED_REF_CAP)) {
    result.omission.omittedRefs.push(ref);
    if (briefSize(result) > maxChars) {
      result.omission.omittedRefs.pop();
      result.omission.omittedRefsTruncated = true;
      break;
    }
  }
  if (pendingRefs.length > result.omission.omittedRefs.length) {
    result.omission.omittedRefsTruncated = true;
  }
  result.serializedChars = briefSize(result);
  result.estimatedTokens = Math.ceil(result.serializedChars / 4);
  // Updating the metrics can change their own digit width by a byte or two.
  result.serializedChars = briefSize(result);
  result.estimatedTokens = Math.ceil(result.serializedChars / 4);
  return result;
}

export interface CollectPriorAttemptsOptions {
  harnessSlug?: string;
  /**
   * P-018: the ref this read is ABOUT. Defaults to `{ kind:'work_item', ref: workItemId }`,
   * which is every existing caller. A plan or goal ref makes this a LEADER rollup read
   * (see `direction`).
   */
  target?: ContainmentRef;
  /** OPTIONAL since P-018 — resolved from the containment tree when absent, and simply
   *  ABSENT for the 94% of items that carry no plan. Previously required, which is why
   *  the whole surface returned null for them. */
  planSlug?: string | null;
  planItemId?: string | null;
  workItemId: string;
  /** Optional exact target specs.  When absent, derive them from the work-item
   * evidence edges, then from current clauses owned by the plan item. */
  specIds?: string[];
  maxPlanWorkItems?: number;
  maxThreadPosts?: number;
  /**
   * Containment direction (D-007). `up` (DEFAULT) is the member-safe read: the ref's
   * own history plus its ancestors' rulings. `down`/`both` add the descendant rollup,
   * which is a LEADER read — 94% of items have no plan and no goal, so a rollup can
   * only ever fire for the 6%, and wiring one into a member's claim path would spend
   * the member budget on it.
   */
  direction?: ContainmentDirection;
  maxDescendants?: number;
  /** How many ring entries of a checkpoint's trajectory to admit (P-003's journal). */
  maxJournalEntries?: number;
  /** Downward readers preserve failed source reads as unknown. Member callers stay fail-soft. */
  onReadFailure?: (source: string) => void;
}

/** How many prior checkpoint-ring entries a claim admits. The ring holds up to
 *  CARRY_JOURNAL_MAX_ENTRIES (15); admitting the newest few is what turns P-003's
 *  storage into delivered continuity without re-importing a transcript. */
const DEFAULT_JOURNAL_ENTRIES = 4;

export const PRIOR_ATTEMPT_CLAIM_BUDGET_MS = 2_500;

export interface ClaimTimePriorAttemptOptions {
  workItem?: Partial<Pick<WorkItem, 'id' | 'harness' | 'payload' | 'sourcePlanSlug' | 'sourcePlanItemIds'>> | null;
  workItemId?: string | null;
  planSlug?: string | null;
  planItemId?: string | null;
  harness?: string | null;
  budget?: PriorAttemptBriefBudget;
  timeoutMs?: number;
}

interface CollectorDeps {
  getPlan: typeof getPlanRow;
  specs: typeof listSpecClauses;
  edges: typeof listWorkItemSpecRevisionEdges;
  evidence: typeof listSpecEvidence;
  item: typeof getWorkItem;
  items: typeof listWorkItems;
  thread: typeof getWorkItemThreadWindow;
  checkpoint: typeof getWorkItemCheckpointWithMeta;
  /**
   * P-003's trajectory ring — the superseded checkpoints a replace-on-write slot used
   * to destroy. Injected like every other store so a test can supply one.
   *
   * OPTIONAL, unlike its siblings, because it was added to an interface that already
   * had partial doubles in the wild: making it required turns "this double predates
   * the ring" into a TypeError deep inside the collector, which surfaces as a
   * fail-soft `null` brief rather than a legible failure. An absent ring is the same
   * graceful degradation every other leg already has — and the honest one for the
   * 10,326 rows written before P-003 turned journaling on.
   */
  journal?: typeof getWorkItemCheckpointJournal;
  lifecycle: typeof getWorkItemLifecycleHistory;
  priorWork: typeof getClaimTimePriorWorkHint;
}

const DEFAULT_DEPS: CollectorDeps = {
  getPlan: getPlanRow,
  specs: listSpecClauses,
  edges: listWorkItemSpecRevisionEdges,
  evidence: listSpecEvidence,
  item: getWorkItem,
  items: listWorkItems,
  thread: getWorkItemThreadWindow,
  checkpoint: getWorkItemCheckpointWithMeta,
  journal: getWorkItemCheckpointJournal,
  lifecycle: getWorkItemLifecycleHistory,
  priorWork: getClaimTimePriorWorkHint,
};

function planItemIdsOf(item: WorkItem): string[] {
  if (item.sourcePlanItemIds?.length) return item.sourcePlanItemIds;
  const payload = item.payload && typeof item.payload === 'object' ? (item.payload as Record<string, unknown>) : null;
  const pointer =
    payload?.plan_item && typeof payload.plan_item === 'object' ? (payload.plan_item as Record<string, unknown>) : null;
  const id = typeof pointer?.item_id === 'string' ? pointer.item_id : null;
  return id ? [id] : [];
}

/**
 * P-018: position of a candidate item RELATIVE TO THE REQUESTED REF.
 *
 * `self` is checked first and unconditionally — the requested item's own history is
 * distance zero however the plan pointers happen to fall, and for an orphan it is the
 * only rung that exists at all.
 */
function scopeFor(
  item: WorkItem,
  targetSpecIds: Set<string>,
  edgeSpecs: ReadonlySet<string>,
  planItemId: string | null,
  requestedWorkItemId: string,
  descendantDepth?: number,
): PriorAttemptScope {
  if (item.id === requestedWorkItemId) return 'self';
  if ([...edgeSpecs].some((id) => targetSpecIds.has(id))) return 'same-spec';
  if (planItemId && planItemIdsOf(item).includes(planItemId)) return 'same-plan-item';
  // A descendant two hops down (a goal's plan's item) sits on the goal rung; one hop
  // (a plan's item) sits on the plan rung, which is also where a plan sibling lands.
  if ((descendantDepth ?? 0) >= 2) return 'goal-wide';
  return 'plan-wide';
}

/**
 * Read existing stores and compile their canonical prior-attempt projection.
 *
 * P-018 lifted the plan requirement. The shape is now: resolve the CONTAINMENT TREE
 * for the requested ref, then read
 *   - the ref's OWN history (always — this is the rung an orphan has),
 *   - its ANCESTORS' own history (plan decisions + the plan's thread, the goal's
 *     thread) and, when a plan resolved, its sibling items, and
 *   - its DESCENDANTS, only when the caller asked to descend (a leader read).
 */
export async function collectPriorAttempts(
  options: CollectPriorAttemptsOptions,
  deps: CollectorDeps = DEFAULT_DEPS,
  resolvedTree?: ContainmentTree,
): Promise<PriorAttemptCompilation> {
  const harness = options.harnessSlug;
  const workspaceId = resolveConcreteWorkspaceId();
  const target: ContainmentRef = options.target ?? {
    kind: 'work_item',
    ref: options.workItemId,
    harness: harness ?? null,
  };
  const failed = <T>(source: string, fallback: T): T => {
    options.onReadFailure?.(source);
    return fallback;
  };
  const tree =
    resolvedTree ??
    (await resolveContainmentTree(target, {
      workspaceId: workspaceId || undefined,
      harness: harness ?? null,
      direction: options.direction ?? 'up',
      maxDescendants: options.maxDescendants,
    }).catch(() => failed('containment', null)));
  if (tree?.unavailable) options.onReadFailure?.(`containment:${tree.unavailable}`);
  const ancestorPlan = tree?.ancestors.find((node) => node.kind === 'plan') ?? null;
  const ancestorGoal = tree?.ancestors.find((node) => node.kind === 'goal') ?? null;
  // The plan this read is anchored to: an explicit option, else the requested ref
  // itself when it IS a plan, else the ref's plan ancestor. May legitimately be null —
  // that is the 94% case P-018 exists to serve, and every plan-dependent read below
  // is guarded rather than assumed.
  const planSlug = options.planSlug ?? (target.kind === 'plan' ? target.ref : null) ?? ancestorPlan?.ref ?? null;
  const planItemId = options.planItemId ?? null;
  const planHarness = ancestorPlan?.harness ?? harness ?? null;

  const [plan, currentItem, allSpecs, targetEdges] = await Promise.all([
    planSlug
      ? deps.getPlan(planSlug, harness ? { harnessSlug: harness } : {}).catch(() => failed('plan', null))
      : Promise.resolve(null),
    target.kind === 'work_item' ? deps.item(options.workItemId, harness).catch(() => null) : Promise.resolve(null),
    planSlug
      ? deps.specs({ harnessSlug: harness, planSlug, includeHistory: true }).catch(() => failed('specs', []))
      : Promise.resolve([]),
    planSlug
      ? deps.edges({ harnessSlug: harness, planSlug, workItemId: options.workItemId }).catch(() => [])
      : Promise.resolve([]),
  ]);
  const derivedSpecIds = targetEdges.map((edge) => edge.specId);
  const fallbackSpecIds = planItemId
    ? allSpecs.filter((spec) => spec.planItemId === planItemId).map((spec) => spec.specId)
    : [];
  const targetSpecIds = new Set(
    options.specIds?.length
      ? options.specIds
      : target.kind === 'plan'
        ? allSpecs.map((spec) => spec.specId)
        : derivedSpecIds.length
          ? derivedSpecIds
          : fallbackSpecIds,
  );
  if (planSlug && !plan) options.onReadFailure?.('plan:unavailable');

  const evidence =
    target.kind === 'work_item' && targetSpecIds.size && planSlug
      ? await deps
          .evidence({
            harnessSlug: harness,
            planSlugs: [planSlug],
            specIds: [...targetSpecIds],
            limit: Math.max(options.maxPlanWorkItems ?? 200, 1) * 10,
          })
          .catch(() => [])
      : [];
  const evidenceItemIds = new Set(evidence.map((entry) => entry.workItemId));
  // A descendant read must use the bounded, authoritative tree selection. Loading
  // all plan siblings here bypassed both its cap and its scope/omission accounting.
  const listed =
    planSlug && target.kind === 'work_item'
      ? await deps
          .items({
            harness,
            sourcePlanSlug: planSlug,
            includeChildren: true,
            includeObservations: true,
            limit: options.maxPlanWorkItems ?? 200,
          })
          .catch(() => [])
      : [];
  const candidates = new Map<string, WorkItem>();
  for (const item of listed) candidates.set(item.id, item);
  if (currentItem) candidates.set(currentItem.id, currentItem);
  for (const id of evidenceItemIds) {
    if (!candidates.has(id)) {
      const item = await deps.item(id, harness).catch(() => null);
      if (item) candidates.set(id, item);
    }
  }
  // P-019: descendants of a plan/goal read, admitted in the tree's priority order and
  // carrying their DEPTH so the D-008 ladder can spend against it.
  const descendantDepth = new Map<string, number>();
  await Promise.all(
    (tree?.descendants ?? []).map(async (node) => {
      if (node.kind !== 'work_item') return;
      descendantDepth.set(node.ref, node.depth);
      if (!candidates.has(node.ref)) {
        const item = await deps.item(node.ref, node.harness ?? harness).catch(() => failed(`item:${node.ref}`, null));
        if (item) candidates.set(item.id, item);
        else options.onReadFailure?.(`item:${node.ref}`);
      }
    }),
  );

  const edgeSpecsByItem = new Map<string, Set<string>>();
  for (const entry of evidence) {
    const set = edgeSpecsByItem.get(entry.workItemId) ?? new Set<string>();
    set.add(entry.specId);
    edgeSpecsByItem.set(entry.workItemId, set);
  }
  if (targetEdges.length) {
    edgeSpecsByItem.set(options.workItemId, new Set(targetEdges.map((edge) => edge.specId)));
  }
  const sources: PriorAttemptSource[] = [];

  for (const spec of allSpecs) {
    if (!targetSpecIds.has(spec.specId)) continue;
    sources.push(specSource(spec, planItemId ?? ''));
  }
  if (plan && planSlug) {
    for (const decision of parsePlan(plan.content).decisions) {
      sources.push({
        scope: 'plan-wide',
        authority: 'plan-decision',
        rawRef: `${planSlug}#${decision.id}`,
        planItemId,
        text: `${decision.title}\n${decision.body}`,
      });
    }
  }

  // P-017's CAPTURE SURFACE, read back. A note attached at the plan or goal level
  // lives on that level's own thread; without these two reads the write side would
  // have nowhere to be delivered from, and D-004's rule (deliver through machinery
  // agents already receive) would be satisfied only for item-level notes.
  const levelThreads = await Promise.all([
    planSlug && planHarness
      ? readEffortThread(
          { kind: 'plan', ref: planSlug, harness: planHarness },
          options.maxThreadPosts ?? 25,
          workspaceId || undefined,
        ).catch(() => failed('plan-thread', []))
      : Promise.resolve([]),
    ancestorGoal || target.kind === 'goal'
      ? readEffortThread(
          { kind: 'goal', ref: target.kind === 'goal' ? target.ref : ancestorGoal!.ref },
          options.maxThreadPosts ?? 25,
          workspaceId || undefined,
        ).catch(() => failed('goal-thread', []))
      : Promise.resolve([]),
  ]);
  const levelScopes: PriorAttemptScope[] = ['plan-wide', 'goal-wide'];
  const levelRefs = [planSlug, target.kind === 'goal' ? target.ref : (ancestorGoal?.ref ?? null)];
  levelThreads.forEach((posts, index) => {
    const ref = levelRefs[index];
    if (!ref) return;
    for (const post of posts) {
      sources.push({
        scope: levelScopes[index]!,
        authority: retractionText(post.body) ? 'retraction' : 'comment',
        rawRef: `${levelScopes[index] === 'plan-wide' ? 'plan' : 'goal'}:${ref}#comment:${post.id}`,
        planItemId,
        at: post.created_ts,
        actor: post.author_id,
        text: post.body,
      });
    }
  });

  await Promise.all(
    [...candidates.values()].map(async (item) => {
      const edgeSpecs = edgeSpecsByItem.get(item.id) ?? new Set<string>();
      const depth = descendantDepth.get(item.id) ?? 0;
      const scope = scopeFor(item, targetSpecIds, edgeSpecs, planItemId, options.workItemId, depth);
      // Plan-wide history is material through its structured completion record.
      // Pulling four deep stores for every plan sibling made a 32-item claim issue
      // 128 independent PG reads and measured at P95 20.144s. Deep history is
      // reserved for same-spec/same-item attempts; plan-wide remains bounded and
      // useful without turning claim enrichment into a fan-out query storm.
      // `self` and spec/item-tied siblings get the four deep stores; a plan-wide or
      // goal-wide row stays shallow, because pulling four stores for every sibling
      // made a 32-item claim issue 128 independent PG reads at P95 20.1s. The
      // requested ref is ALWAYS deep — for an orphan it is the only rung there is.
      const deep = item.id === options.workItemId || (scope !== 'plan-wide' && scope !== 'goal-wide');
      const [thread, checkpoint, lifecycle, priorWork, journal] = await Promise.all([
        deep ? deps.thread(item.id, options.maxThreadPosts ?? 50, harness).catch(() => null) : Promise.resolve(null),
        deep || descendantDepth.has(item.id)
          ? deps
              .checkpoint({ harness: item.harness, workItemId: item.id })
              .catch(() => failed(`checkpoint:${item.id}`, { checkpoint: null, updatedAtMs: null }))
          : Promise.resolve({ checkpoint: null, updatedAtMs: null }),
        deep && workspaceId
          ? deps.lifecycle({ id: item.id, workspaceId, payload: item.payload, family: item.family }).catch(() => null)
          : Promise.resolve(null),
        deep ? deps.priorWork({ harness: item.harness, workItemId: item.id }).catch(() => null) : Promise.resolve(null),
        // P-003's trajectory ring. Read ONLY for the requested ref: it is the one item
        // whose superseded reasoning a claimant is about to repeat, and admitting every
        // sibling's ring would multiply the deep-read cost the `deep` guard just bounded.
        item.id === options.workItemId && deps.journal
          ? deps.journal({ harness: item.harness, workItemId: item.id }).catch(() => [])
          : Promise.resolve([]),
      ]);
      if (item.terminalCompletionRef || item.terminalCompletionEvidence) {
        const evidenceText = item.terminalCompletionEvidence
          ? JSON.stringify(item.terminalCompletionEvidence)
          : item.terminalCompletionRef!;
        sources.push({
          scope,
          authority: 'verified-completion',
          rawRef: `${item.id}#completion`,
          workItemId: item.id,
          planItemId: planItemIdsOf(item)[0] ?? null,
          at: item.closedAt ?? item.updatedAt,
          actor: item.terminalOwner,
          text: evidenceText,
          depth,
          detail: { completionRef: item.terminalCompletionRef, authority: item.completionAuthority },
        });
      }
      if (checkpoint.checkpoint) {
        sources.push({
          scope,
          authority: retractionText(checkpoint.checkpoint) ? 'retraction' : 'checkpoint',
          rawRef: `${item.id}#checkpoint`,
          workItemId: item.id,
          planItemId: planItemIdsOf(item)[0] ?? null,
          at: checkpoint.updatedAtMs ? new Date(checkpoint.updatedAtMs).toISOString() : null,
          text: checkpoint.checkpoint,
          depth,
        });
      }
      // P-003's ring, newest first — the SUPERSEDED checkpoints that used to be
      // destroyed in place. Each is a distinct rawRef so it dedups and drills down
      // like any other record, and the newest few are admitted because a ring entry
      // is one-wake bookkeeping more often than it is a durable finding (D-003).
      for (const [index, entry] of journal.slice(0, options.maxJournalEntries ?? DEFAULT_JOURNAL_ENTRIES).entries()) {
        if (!entry.note?.trim()) continue;
        // The newest ring entry normally DUPLICATES the live checkpoint (the ring
        // records what was stored). Skip it rather than pay for the same text twice.
        if (index === 0 && checkpoint.checkpoint && entry.note.trim() === checkpoint.checkpoint.trim()) continue;
        sources.push({
          scope,
          authority: retractionText(entry.note) ? 'retraction' : 'checkpoint',
          rawRef: `${item.id}#checkpoint-journal:${entry.at}`,
          workItemId: item.id,
          planItemId: planItemIdsOf(item)[0] ?? null,
          at: Number.isFinite(entry.at) ? new Date(entry.at).toISOString() : null,
          text: entry.note,
          depth,
          detail: { supersededCheckpoint: true, ringIndex: index },
        });
      }
      for (const post of thread?.posts ?? []) {
        sources.push({
          scope,
          authority: retractionText(post.body) ? 'retraction' : 'comment',
          rawRef: `${item.id}#comment:${post.id}`,
          workItemId: item.id,
          planItemId: planItemIdsOf(item)[0] ?? null,
          at: post.created_ts,
          actor: post.author_id,
          text: post.body,
          depth,
        });
      }
      for (const event of lifecycle?.events ?? []) {
        sources.push({
          scope,
          authority: 'lifecycle',
          rawRef: `${item.id}#lifecycle:${event.source}:${event.atMs}:${event.kind}`,
          workItemId: item.id,
          planItemId: planItemIdsOf(item)[0] ?? null,
          at: event.at,
          actor: event.by,
          text: `${event.kind}${event.action ? ` (${event.action})` : ''}: ${JSON.stringify(event.detail ?? {})}`,
          depth,
          detail: { source: event.source, ...event.detail },
        });
      }
      if (priorWork) {
        const lastReleasedBy = priorWork.lastReleasedBy;
        const releasedAt = priorWork.releasedAtMs ? new Date(priorWork.releasedAtMs).toISOString() : null;
        if (lastReleasedBy || releasedAt) {
          sources.push({
            scope,
            authority: 'release-provenance',
            rawRef: `${item.id}#release:${releasedAt ?? 'unknown'}`,
            workItemId: item.id,
            planItemId: planItemIdsOf(item)[0] ?? null,
            at: releasedAt,
            actor: lastReleasedBy,
            text: `claim released${lastReleasedBy ? ` by ${lastReleasedBy}` : ''}${releasedAt ? ` at ${releasedAt}` : ''}`,
            depth,
          });
        }
      }
    }),
  );
  return compilePriorAttempts(sources);
}

function planPointer(opts: ClaimTimePriorAttemptOptions): { planSlug: string; planItemId: string } | null {
  const payload =
    opts.workItem?.payload && typeof opts.workItem.payload === 'object'
      ? (opts.workItem.payload as Record<string, unknown>)
      : null;
  const pointer =
    payload?.plan_item && typeof payload.plan_item === 'object' ? (payload.plan_item as Record<string, unknown>) : null;
  const planSlug =
    opts.planSlug ??
    opts.workItem?.sourcePlanSlug ??
    (typeof pointer?.plan_slug === 'string' ? pointer.plan_slug : null);
  const planItemId =
    opts.planItemId ??
    opts.workItem?.sourcePlanItemIds?.[0] ??
    (typeof pointer?.item_id === 'string' ? pointer.item_id : null);
  return planSlug && planItemId ? { planSlug, planItemId } : null;
}

/**
 * Shared fail-soft claim enrichment used by every canonical claim surface.
 *
 * ⚠ P-018 REMOVED THE PLAN-POINTER GATE THAT USED TO OPEN THIS FUNCTION.
 *
 * It read `const pointer = planPointer(opts); if (!pointer) return null;`, so an item
 * carrying neither a plan slug nor a plan-item id received a ZERO-BYTE brief — not a
 * partial one. Measured 2026-09-02: that is 94.0% of open work-items (15,791 of
 * 16,792). An orphan claimant got only `priorWorkHint` (who/attempts metadata, no
 * content), the authorship-revalidation warning, and its own checkpoint if one existed
 * — and only ~10% of items open past 21 days have one.
 *
 * The gate was not a policy choice; it fell out of a plan-anchored ladder that had no
 * vocabulary for an item's own position. Now the requested ref IS the anchor: an
 * orphan compiles the `self` rung (its checkpoint, its P-003 trajectory ring, its
 * thread, its lifecycle, its completion), and a plan-backed item compiles exactly what
 * it always did plus its plan's and goal's own threads.
 *
 * BUDGET: an orphan gets {@link ORPHAN_CLAIM_BRIEF_BUDGET}, deliberately NOT the
 * 50k-char default that was sized for the 5.8% of items carrying a plan (P-021).
 */
export async function getClaimTimePriorAttemptBrief(
  opts: ClaimTimePriorAttemptOptions,
  deps: CollectorDeps = DEFAULT_DEPS,
): Promise<BoundedPriorAttemptBrief | null> {
  const pointer = planPointer(opts);
  const workItemId =
    opts.workItemId ?? opts.workItem?.id ?? (pointer ? `plan-item:${pointer.planSlug}#${pointer.planItemId}` : null);
  // With no ref of any kind there is nothing to be about — the one remaining null.
  if (!workItemId) return null;
  const timeoutMs = Math.max(100, opts.timeoutMs ?? PRIOR_ATTEMPT_CLAIM_BUDGET_MS);
  const budget = opts.budget ?? (pointer ? undefined : ORPHAN_CLAIM_BRIEF_BUDGET);
  try {
    const compilation = await Promise.race([
      collectPriorAttempts(
        {
          harnessSlug: opts.harness ?? opts.workItem?.harness ?? undefined,
          planSlug: pointer?.planSlug ?? opts.planSlug ?? opts.workItem?.sourcePlanSlug ?? null,
          planItemId: pointer?.planItemId ?? opts.planItemId ?? null,
          workItemId,
          // A CLAIM is a member read: ancestors only, never a descendant rollup (D-007).
          direction: 'up',
          maxPlanWorkItems: 16,
          maxThreadPosts: 12,
        },
        deps,
      ),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('prior-attempt-claim-timeout')), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return buildBoundedPriorAttemptBrief(compilation, budget);
  } catch {
    return null;
  }
}

/**
 * P-019 / D-007: the LEADER rollup read — a plan's or goal's own history UNION its
 * descendants', nearest-first, at a fixed budget that divides by depth.
 *
 * Deliberately a SEPARATE entry point from the claim path rather than a flag on it.
 * D-007 states the constraint plainly: "the rollup read is a LEADER read, not a member
 * read ... it must be stated so nobody wires a goal rollup into a member's claim path,
 * which is exactly where the member budget would be spent." A distinct function is
 * that statement made mechanical — a member's claim cannot reach this by passing an
 * argument, and leaders carry a 400k compaction limit against a member's 250k.
 */
export type ContainmentRollupBrief = BoundedPriorAttemptBrief & {
  status: 'available' | 'empty' | 'unknown';
  target: ContainmentRef;
  fanOut: ContainmentTree['fanOut'];
  degradedSources: string[];
  omittedDescendants: ContainmentRef[];
  omittedDescendantsTruncated: boolean;
};

export async function getContainmentRollupBrief(
  opts: {
    target: ContainmentRef;
    harness?: string | null;
    budget?: PriorAttemptBriefBudget;
    timeoutMs?: number;
    maxDescendants?: number;
  },
  deps: CollectorDeps = DEFAULT_DEPS,
): Promise<ContainmentRollupBrief | null> {
  if (!opts.target?.ref) return null;
  const timeoutMs = Math.max(100, opts.timeoutMs ?? PRIOR_ATTEMPT_CLAIM_BUDGET_MS * 2);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const tree = await resolveContainmentTree(opts.target, {
          harness: opts.harness ?? opts.target.harness ?? null,
          direction: 'down',
          maxDescendants: opts.maxDescendants,
        });
        const degradedSources = new Set<string>();
        const compilation = await collectPriorAttempts(
          {
            harnessSlug: opts.harness ?? opts.target.harness ?? undefined,
            target: opts.target,
            // The rollup is ABOUT the level, so no single work-item is "self"; passing the
            // level's own ref keeps `self` empty rather than crowning an arbitrary child.
            workItemId: opts.target.kind === 'work_item' ? opts.target.ref : `${opts.target.kind}:${opts.target.ref}`,
            direction: 'down',
            maxDescendants: opts.maxDescendants,
            maxPlanWorkItems: 200,
            maxThreadPosts: 25,
            onReadFailure: (source) => {
              degradedSources.add(source);
            },
          },
          deps,
          tree,
        );
        const brief = buildBoundedPriorAttemptBrief(compilation, opts.budget, true)!;
        return {
          ...brief,
          status: degradedSources.size
            ? ('unknown' as const)
            : compilation.records.length
              ? ('available' as const)
              : ('empty' as const),
          target: opts.target,
          fanOut: tree.fanOut,
          degradedSources: [...degradedSources],
          omittedDescendants: tree.omittedDescendants.slice(0, 8),
          omittedDescendantsTruncated: tree.omittedDescendantsTruncated || tree.omittedDescendants.length > 8,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('prior-attempt-rollup-timeout')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One bounded projection shared by the plan read, launch seed and leader sink. */
export async function readPlanHistoryContext(
  planSlug: string,
  harness: string,
  read: typeof getContainmentRollupBrief = getContainmentRollupBrief,
) {
  const recovery = { tool: 'plans:get', args: { slug: planSlug, harness, heading: 'History' } };
  const brief = await read({
    target: { kind: 'plan', ref: planSlug, harness },
    harness,
    budget: { maxChars: 6_000, maxRecords: 16, maxTextChars: 400 },
    maxDescendants: 24,
    timeoutMs: 2_500,
  }).catch(() => null);
  return { status: brief?.status ?? 'unknown', brief, recovery };
}

export type PlanHistoryContext = Awaited<ReturnType<typeof readPlanHistoryContext>>;

export interface PriorAttemptRefResolution {
  schemaVersion: 'prior-attempt-refs-v1';
  /** Full, UNTRUNCATED records for the refs that still compile. */
  records: PriorAttemptRecord[];
  /** Refs that no longer resolve.  A ref goes unresolved when its source moved
   * on (a checkpoint replaced, a comment edited, a plan item re-scoped) — which
   * is a real answer about the history, not an error.  Returning it explicitly
   * keeps a vanished source distinguishable from one this call never looked for. */
  unresolved: string[];
  /** The compilation fingerprint the refs were resolved against.  A caller
   * holding a brief can compare it to `brief.fingerprint`: a mismatch means the
   * history moved between the brief and the drill-down. */
  fingerprint: string;
}

/**
 * P-017 raw drill-down.  Resolves brief refs — admitted, protected, or OMITTED —
 * back to their full source records.
 *
 * This is a re-projection of the same authority the brief was cut from, not a
 * second store: it re-runs the canonical collector and selects by `rawRef`.  So
 * a ref that a bounded brief could only afford to COUNT still leads back to the
 * text, which is the property the module docstring promises and the budget loop
 * would otherwise quietly break.
 */
export async function resolvePriorAttemptRefs(
  opts: ClaimTimePriorAttemptOptions & { rawRefs: readonly string[]; target?: ContainmentRef },
  deps: CollectorDeps = DEFAULT_DEPS,
): Promise<PriorAttemptRefResolution | null> {
  const wanted = [...new Set(opts.rawRefs.filter((ref) => typeof ref === 'string' && ref.trim()))];
  if (!wanted.length) return null;
  // ⚠ WI-2142613 REMOVED THE PLAN-POINTER GATE THAT USED TO OPEN THIS FUNCTION,
  // for the same reason P-018 removed it from the briefing path above.
  //
  // It read `const pointer = planPointer(opts); if (!pointer) return null;`, so the
  // DRILL-DOWN returned null for the 94.0% of open work-items carrying no plan
  // (15,791 of 16,792, measured 2026-09-02) — the very population P-018 had just
  // extended the BRIEF to reach. That left this module's promise broken on exactly
  // one side: an orphan now RECEIVES a bounded brief that discloses its omissions via
  // `omittedRefs`, and then could not resolve a single one of them. A bounded read
  // that cannot be un-bounded is a truncated answer indistinguishable from a complete
  // one — the defect class this whole surface exists to remove. Reachable, not
  // theoretical: ORPHAN_CLAIM_BRIEF_BUDGET admits 12,000 chars / 24 records while a
  // realistic orphan carries ~9,000 chars of journal ring alone, so omission happens.
  //
  // The gate was VESTIGIAL, not load-bearing. The anchor below already PREFERRED an
  // explicit workItemId and used the plan pointer only as a last-resort fallback, and
  // collectPriorAttempts has accepted an optional planSlug since P-018 — it resolves
  // the containment tree from the requested ref, so a plan is a thing it may FIND,
  // never a precondition. What remains is the narrower and honest guard: this function
  // needs SOME anchor to resolve against, not specifically a PLAN one.
  const pointer = planPointer(opts);
  const workItemId =
    opts.workItemId ??
    opts.workItem?.id ??
    (opts.target ? `${opts.target.kind}:${opts.target.ref}` : null) ??
    (pointer ? `plan-item:${pointer.planSlug}#${pointer.planItemId}` : null);
  if (!workItemId) return null;
  const timeoutMs = Math.max(100, opts.timeoutMs ?? PRIOR_ATTEMPT_CLAIM_BUDGET_MS);
  try {
    const compilation = await Promise.race([
      collectPriorAttempts(
        {
          harnessSlug: opts.harness ?? opts.workItem?.harness ?? undefined,
          planSlug: pointer?.planSlug ?? null,
          planItemId: pointer?.planItemId ?? null,
          workItemId,
          ...(opts.target ? { target: opts.target, direction: 'down' as const, maxDescendants: 24 } : {}),
          maxPlanWorkItems: 16,
          maxThreadPosts: 12,
        },
        deps,
      ),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('prior-attempt-resolve-timeout')), timeoutMs);
        timer.unref?.();
      }),
    ]);
    const want = new Set(wanted);
    const records = compilation.records.filter((record) => want.has(record.rawRef));
    const found = new Set(records.map((record) => record.rawRef));
    return {
      schemaVersion: 'prior-attempt-refs-v1',
      records,
      unresolved: wanted.filter((ref) => !found.has(ref)),
      fingerprint: compilation.fingerprint,
    };
  } catch {
    return null;
  }
}

function specSource(spec: SpecClauseRevision, targetPlanItemId: string): PriorAttemptSource {
  return {
    scope: 'same-spec',
    authority: spec.revision === spec.currentRevision ? 'current-spec' : 'spec-revision',
    rawRef: `${spec.planSlug}#${spec.specId}@${spec.revision}`,
    specId: spec.specId,
    specRevision: spec.revision,
    planItemId: spec.planItemId,
    at: spec.createdAt,
    actor: spec.createdBy,
    text: `${spec.behavior} Required evidence: ${spec.requiredEvidence.join('; ')}. Required test layers: ${spec.requiredTestLayers.join('; ')}. Lifecycle: ${spec.lifecycleStatus}.`,
    detail: {
      currentRevision: spec.currentRevision,
      contentHash: spec.contentHash,
      targetPlanItemId,
      acceptanceRef: spec.acceptanceRef,
    },
  };
}
