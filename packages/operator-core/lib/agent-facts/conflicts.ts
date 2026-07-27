/**
 * conflicts.ts — P-011's detector: two LIVE assumptions in tension over the same
 * referent (unified-agent-state-plane-2026-07-27 P-011, per D-019 and D-087).
 * PURE — no PG, no clock, no LLM. Unit-tested without a database.
 *
 * ── WHY TYPED-ONLY, AND WHAT "TYPED" MEANS HERE ─────────────────────────────
 *
 * P-011: *"v1 detects contradiction on TYPED fields only. Do not attempt prose
 * contradiction detection — that is an LLM call per pair and it will be wrong
 * often enough to poison the signal."* D-019 DEFECT 2 found the item unbuildable
 * as first written — `agent_facts.body` is free text, so there was nothing typed
 * to compare — and resolved it by adding the optional `claim jsonb`. So the two
 * things this module compares are BOTH out of `claim`:
 *
 *   referent    = `claim.subject`   — what the assumption is ABOUT
 *   contradiction = `claim.assertion` differs — what is being taken as true
 *
 * An assumption filed without a `claim` stays perfectly valid and still folds; it
 * is simply invisible here. D-019 calls that the honest degradation, and
 * `facts:assert` now SAYS so at assert time (D-087 R5) rather than leaving the
 * agent to discover it never counted.
 *
 * ── THE REFERENT RULE (D-087 R1) ────────────────────────────────────────────
 *
 * The plan item says "sharing a `dependsOn` referent"; D-019 says compare
 * `claim`. Both are honoured, in a precedence that avoids the obvious
 * false positive:
 *
 *   • both facts carry a `claim.subject` → same referent iff the subjects match.
 *     `dependsOn` is ignored: the typed subject is the more specific statement of
 *     what the assumption is about, and two assumptions can rest on the same cell
 *     while being about different things ("the reds are unrelated to my change"
 *     vs "the gate is slow" both read `gate.verdict` and contradict nothing).
 *   • NEITHER carries a subject → same referent iff they share a `dependsOn`
 *     `(cell, subject)` pair. This is the plan's original axis, kept for
 *     assumptions that declared dependencies but no typed subject.
 *   • exactly ONE carries a subject → NOT comparable. One side stated its
 *     referent and the other did not; guessing that they mean the same thing is
 *     the prose inference this item forbids.
 *
 * ── WHAT IS DELIBERATELY NOT A CONFLICT ─────────────────────────────────────
 *
 * • Two versions of ONE identity (`scope`+`scopeRef`+`key`) — that is
 *   supersession, not tension (D-087 R3). A useful side effect: a federated
 *   duplicate of the same identity arriving from another hive cannot manufacture
 *   a conflict, which is why the read behind this needs no `source_hive` filter.
 * • Assertions that normalize EQUAL — that is two agents AGREEING, which is
 *   signal worth nothing and noise worth avoiding.
 * • Anything about liveness/staleness. Callers pass live rows only (see
 *   `listAssumptionFacts`); "is this assumption still true" is the `dependsOn`
 *   staleness question and is answered elsewhere.
 *
 * ── AND WHY THE COVERAGE BLOCK IS NOT OPTIONAL (D-087 R4) ───────────────────
 *
 * Measured 2026-07-27: the whole ledger held 2088 facts and ZERO assumptions,
 * zero typed claims, zero declared dependencies. A detector over that reports
 * "0 conflicts" — indistinguishable from a fleet in perfect agreement. So every
 * result carries the denominator plus an explicit reason for a zero, and
 * {@link isStructuralZero} separates "nothing was compared" from "things were
 * compared and agreed". Same defect class as D-086: a silently-empty half never
 * announces itself, and `ok:true` is not evidence.
 */
import type { AgentFact } from './store';

/**
 * Why a run found no conflicts. Only `'agreement'` is an informative zero — the
 * other three mean nothing was actually compared (see {@link isStructuralZero}).
 */
export const CONFLICT_ZERO_REASONS = [
  'no-assumption-facts',
  'no-typed-claims',
  'no-shared-referents',
  'agreement',
] as const;
export type ConflictZeroReason = (typeof CONFLICT_ZERO_REASONS)[number];

/** True when the zero means "nothing was compared", not "no tension exists". */
export function isStructuralZero(reason: ConflictZeroReason | null): boolean {
  return reason !== null && reason !== 'agreement';
}

/** Cap on returned pairs — a payload bound, never a change to the counts. */
export const CONFLICT_PAIRS_LIMIT = 50;

/**
 * Is this fact an ASSUMPTION? (D-087 R2)
 *
 * ⚠ The legacy form is deliberately included. D-019's model defined an assumption
 * as `confidence:'suspected'` + `dependsOn` BEFORE its own DEFECT 1 added the
 * `kind` discriminator (migration 690), so a `kind`-only predicate would silently
 * miss every assumption filed in between. `kind` when declared WINS: a row
 * explicitly filed as a conclusion or convention is not an assumption however
 * hedged its confidence.
 */
export function isAssumptionFact(
  f: Pick<AgentFact, 'kind' | 'confidence'>,
): boolean {
  if (f.kind != null) return f.kind === 'assumption';
  return f.confidence === 'suspected';
}

/**
 * Normalize a typed claim value for COMPARISON. Returns null for "absent /
 * nothing to compare".
 *
 * Strings are trimmed, lower-cased and internally whitespace-collapsed — no
 * stemming, no synonyms, no semantics. Numbers and booleans stringify. Objects
 * and arrays get a key-sorted JSON rendering so a structured assertion is
 * comparable instead of silently incomparable; anything unserializable is
 * treated as absent rather than throwing inside a detector.
 */
export function normalizeClaimValue(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase().replace(/\s+/g, ' ');
    return s === '' ? null : s;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    try {
      return stableJson(v);
    } catch {
      return null;
    }
  }
  return null;
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableJson(val)}`).join(',')}}`;
}

function claimField(f: Pick<AgentFact, 'claim'>, name: string): unknown {
  const c = f.claim;
  if (!c || typeof c !== 'object') return undefined;
  return (c as Record<string, unknown>)[name];
}

/** The fact's typed subject, normalized; null when none was filed. */
export function claimSubject(f: Pick<AgentFact, 'claim'>): string | null {
  return normalizeClaimValue(claimField(f, 'subject'));
}

/** The fact's typed assertion, normalized; null when none was filed. */
export function claimAssertion(f: Pick<AgentFact, 'claim'>): string | null {
  return normalizeClaimValue(claimField(f, 'assertion'));
}

/** How two facts came to share a referent — reported so a pair can be judged. */
export type ReferentKind = 'claim-subject' | 'depends-on-cell';

/**
 * The referent keys this fact can be compared under, per the precedence in the
 * module header: a typed `claim.subject` if present, otherwise its declared
 * `dependsOn` cells. Never both — see the "exactly ONE carries a subject" rule.
 */
export function assumptionReferents(
  f: Pick<AgentFact, 'claim' | 'dependsOn'>,
): Array<{ key: string; kind: ReferentKind; label: string }> {
  const subject = claimSubject(f);
  if (subject) {
    // GROUPED on the normalized key, REPORTED as filed. A subject is usually a
    // cell id (`gate.greenCheckpoint.verdict`) and lower-casing it for display
    // would mangle the one string a reader needs to recognise — while comparing
    // case-sensitively would split a referent two agents plainly share. When two
    // spellings do collide, the label is whichever was seen first; the key is what
    // decides they are the same referent.
    const raw = claimField(f, 'subject');
    const label = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : subject;
    return [{ key: `claim:${subject}`, kind: 'claim-subject', label }];
  }
  const out: Array<{ key: string; kind: ReferentKind; label: string }> = [];
  const seen = new Set<string>();
  for (const d of f.dependsOn ?? []) {
    const cell = (d.cell ?? '').trim();
    if (!cell) continue;
    const as = (d.subject ?? '').trim();
    const label = as ? `${cell}@${as}` : cell;
    const key = `cell:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, kind: 'depends-on-cell', label });
  }
  return out;
}

/** One side of a conflicting pair — enough to read it without a second lookup. */
export interface ConflictSide {
  scope: AgentFact['scope'];
  scopeRef: string | null;
  key: string;
  /** The absolute versioned identity, when the row carried its id. */
  id: number | null;
  createdBy: string;
  updatedAt: string;
  /** The normalized assertion that was compared. */
  assertion: string;
  /** The prose an agent/human reads, so a pair is judgeable in one read. */
  body: string;
}

export interface AssumptionConflict {
  /** The shared referent AS FILED — grouping happened on its normalized form. */
  referent: string;
  referentKind: ReferentKind;
  a: ConflictSide;
  b: ConflictSide;
  /** Both assumptions are the SAME agent's — a self-contradiction, not a
   *  disagreement. Frequently the more actionable of the two. */
  sameAuthor: boolean;
}

export interface ConflictCoverage {
  /** Facts handed in (already live-filtered by the caller). */
  factsExamined: number;
  /** Of those, the ones that are assumptions at all. */
  liveAssumptions: number;
  /** Assumptions carrying BOTH a comparable referent and a typed assertion —
   *  the only rows that can ever produce a verdict. */
  comparable: number;
  /** Referents held by ≥2 distinct fact identities. */
  sharedReferents: number;
  /** Distinct-identity pairs actually compared — the FP-rate denominator the
   *  P-011 done-when needs, and P-015's incidence base. */
  comparedPairs: number;
}

export interface AssumptionConflictReport {
  conflicts: AssumptionConflict[];
  /** True when {@link CONFLICT_PAIRS_LIMIT} cut the list; counts stay complete. */
  truncated: boolean;
  coverage: ConflictCoverage;
  /** Null when conflicts were found. Otherwise WHY the answer is zero. */
  structuralZero: ConflictZeroReason | null;
}

function identityOf(f: AgentFact): string {
  return `${f.scope} ${(f.scopeRef ?? '').trim()} ${f.key}`;
}

function sideOf(f: AgentFact, assertion: string): ConflictSide {
  return {
    scope: f.scope,
    scopeRef: f.scopeRef,
    key: f.key,
    id: f.id ?? null,
    createdBy: f.createdBy,
    updatedAt: f.updatedAt,
    assertion,
    body: f.body,
  };
}

/**
 * Find every pair of live assumptions in tension. Deterministic and total: same
 * input, same output, no I/O.
 *
 * Callers pass LIVE rows (unexpired, unretracted, current) — this module does not
 * re-derive liveness, because a detector that silently applied its own liveness
 * rule would disagree with the read that fed it and neither would be wrong on
 * its own terms.
 */
export function detectAssumptionConflicts(facts: readonly AgentFact[]): AssumptionConflictReport {
  const assumptions = facts.filter((f) => isAssumptionFact(f));

  // Referent → the comparable rows filed under it.
  const groups = new Map<
    string,
    { kind: ReferentKind; label: string; rows: Array<{ f: AgentFact; assertion: string }> }
  >();
  let comparable = 0;
  for (const f of assumptions) {
    const assertion = claimAssertion(f);
    const referents = assumptionReferents(f);
    if (!assertion || referents.length === 0) continue;
    comparable += 1;
    for (const r of referents) {
      const g = groups.get(r.key) ?? { kind: r.kind, label: r.label, rows: [] };
      g.rows.push({ f, assertion });
      groups.set(r.key, g);
    }
  }

  const conflicts: AssumptionConflict[] = [];
  let comparedPairs = 0;
  let sharedReferents = 0;
  let truncated = false;

  for (const g of groups.values()) {
    const identities = new Set(g.rows.map((r) => identityOf(r.f)));
    if (identities.size < 2) continue;
    sharedReferents += 1;
    for (let i = 0; i < g.rows.length; i += 1) {
      for (let j = i + 1; j < g.rows.length; j += 1) {
        const a = g.rows[i];
        const b = g.rows[j];
        // D-087 R3: versions of one identity are supersession, not tension.
        if (identityOf(a.f) === identityOf(b.f)) continue;
        comparedPairs += 1;
        if (a.assertion === b.assertion) continue; // agreement
        if (conflicts.length >= CONFLICT_PAIRS_LIMIT) {
          truncated = true;
          continue;
        }
        conflicts.push({
          referent: g.label,
          referentKind: g.kind,
          a: sideOf(a.f, a.assertion),
          b: sideOf(b.f, b.assertion),
          sameAuthor: a.f.createdBy === b.f.createdBy,
        });
      }
    }
  }

  const coverage: ConflictCoverage = {
    factsExamined: facts.length,
    liveAssumptions: assumptions.length,
    comparable,
    sharedReferents,
    comparedPairs,
  };

  return {
    conflicts,
    truncated,
    coverage,
    structuralZero: conflicts.length > 0 ? null : zeroReasonFor(coverage),
  };
}

function zeroReasonFor(c: ConflictCoverage): ConflictZeroReason {
  if (c.liveAssumptions === 0) return 'no-assumption-facts';
  if (c.comparable === 0) return 'no-typed-claims';
  if (c.comparedPairs === 0) return 'no-shared-referents';
  return 'agreement';
}

/**
 * D-087 R5 — the honest-degradation disclosure, for `facts:assert`.
 *
 * D-019 rules that an assumption filed without a `claim` stays valid and simply
 * cannot be compared: *"which is the honest degradation."* Honest requires SAYING
 * so. Otherwise an agent declares an assumption, gets a clean `ok:true`, and
 * believes it armed a detector that will never see the row — the same
 * silently-fine-looking gap EI-18685042986450096 closed for truncated bodies.
 *
 * Warn-only: returns `undefined` for anything that is not an assumption, and for
 * an assumption that IS comparable. Same shape as `truncationField`.
 */
export function assumptionDetectabilityWarning(
  f: Pick<AgentFact, 'kind' | 'confidence' | 'claim' | 'dependsOn'>,
): { missing: string[]; note: string } | undefined {
  if (!isAssumptionFact(f)) return undefined;
  const missing: string[] = [];
  if (!claimAssertion(f)) missing.push('claim.assertion');
  if (!claimSubject(f) && (f.dependsOn ?? []).length === 0) missing.push('claim.subject (or a dependsOn cell)');
  if (missing.length === 0) return undefined;
  return {
    missing,
    note:
      'STORED, and it will fold normally — but it is INVISIBLE to the conflicting-assumption detector ' +
      '(facts:conflicts), which compares TYPED fields only and never prose bodies. Re-assert the same key with ' +
      "claim: { subject: '<what this is about>', assertion: '<what you take as true>' } to make it comparable: " +
      'the subject is the referent two assumptions must share, the assertion is what gets compared.',
  };
}

/** One line naming what a zero actually means, for a tool result / a report. */
export function explainZero(reason: ConflictZeroReason): string {
  switch (reason) {
    case 'no-assumption-facts':
      return 'STRUCTURAL ZERO — no live assumptions exist in scope at all, so nothing was compared. This is not "the fleet agrees": declare assumptions with facts:assert { kind:\'assumption\' } before reading this as good news.';
    case 'no-typed-claims':
      return "STRUCTURAL ZERO — live assumptions exist but none carries both a typed `claim.subject` and a `claim.assertion`, so none is comparable. Prose bodies are deliberately never compared (P-011). Add `claim: { subject, assertion }` to make an assumption detectable.";
    case 'no-shared-referents':
      return 'STRUCTURAL ZERO — comparable assumptions exist but no two distinct ones share a referent, so no pair was compared. Contradiction is only defined between assumptions about the same subject.';
    case 'agreement':
      return 'A REAL ZERO — pairs were compared and their typed assertions agree.';
  }
}
