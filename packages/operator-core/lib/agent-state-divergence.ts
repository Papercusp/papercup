/**
 * agent-state-divergence.ts — P-010's detector: where an agent's ACTIONS diverge
 * from what it DECLARED (unified-agent-state-plane-2026-07-27 P-010, per D-012,
 * D-016 and D-046). Targets MAST FM-2.6 (reasoning-action mismatch, 13.2%).
 *
 * PURE — no PG, no clock, no LLM. Unit-tested without a database, exactly like
 * its sibling `agent-facts/conflicts.ts` (P-011), whose shape this mirrors on
 * purpose: same coverage-block discipline, same structural-zero discipline.
 *
 * ── WHY THIS IS A DETECTOR AND NOT A READ TOOL (D-046) ──────────────────────
 *
 * P-010's item text says "bucket calls by `intent_event_id`". Read alone, that
 * describes a bucketing ENDPOINT — and D-046 explicitly refuses to build one:
 *
 *     "A bucketing endpoint over `tool_invocations` (`group by
 *      intent_event_id`) … it is the third read over a datum whose first two
 *      are dead. Rejected on evidence, not on caution."
 *
 * The evidence is brutal and specific: `activity:tool-log` (7 calls / 3 callers
 * / dead since 2026-07-16), `activity:recent` (6 / 2 / dead), `dev:session_detail`
 * (3 / 3 / dead). All three are pull reads over this exact table.
 *
 * The reconciliation is not a compromise, it is a real distinction. A pull read
 * requires an agent to CHOOSE to call it, and on this datum that choice has
 * demonstrably never been made — so a fourth one would be dead on arrival. A
 * DETECTOR requires no adoption: D-016 puts P-010 in the STRUCTURAL tier and
 * D-047 row 15 records its enforcement as "they run on their own". So this
 * module computes a verdict that is DELIVERED to the agent; it must never grow a
 * browse surface. The read path for this datum already exists and is P-024's
 * (`sessions:timeline`), which works precisely because it rides a tool people
 * already call.
 *
 * ── TYPED FIELDS ONLY — NO PROSE INFERENCE (the P-011 rule, and it binds here) ─
 *
 * P-011: *"v1 detects contradiction on TYPED fields only. Do not attempt prose
 * contradiction detection — that is an LLM call per pair and it will be wrong
 * often enough to poison the signal."* An intent declaration is FREE TEXT, so
 * "compare observed tool mix against what was declared" can NOT mean comparing
 * intent prose to tool names — that is the same poisoned signal wearing a
 * different hat. The typed things that actually exist on a stamped call are
 * `goal_ref` (TEXT, already resolved to `WI-6393` — P-009 typed it that way
 * deliberately), `intent_event_id`, `tool_name`, `status` and the args. Every
 * signal below is computed from those and nothing else.
 *
 * ── THE STAMPED LEGS ARE STRUCTURALLY EMPTY TODAY, AND THAT IS DISCLOSED ─────
 *
 * Measured 2026-07-27T15:16Z: **0 of 170,682** `tool_invocations` in 24h carried
 * `intent_event_id`, `goal_ref` OR `assumption_set_id`. P-009's stamp is written
 * but not yet DEPLOYED (`main` runs the release checkout). So a run of this
 * detector today compares nothing on the stamped legs and returns zero — which
 * is indistinguishable from "this fleet never diverges" unless the result says
 * so. It says so: {@link DivergenceCoverage.stampFillRate} ships with every
 * verdict and {@link isStructuralZero} separates "nothing was compared" from
 * "things were compared and agreed". Same defect class D-087 R4 closed for
 * P-011, and the same reason P-015 must measure FILL RATE rather than adoption.
 *
 * ── WHICH IS WHY THE SAMPLING LEGS EXIST ────────────────────────────────────
 *
 * P-010's text also asks for "the sampling trigger for unstamped signal — a
 * retry with changed args, or a tool/verb fallback after failure". Those need no
 * stamp at all: they are computed from `tool_name`, `status` and the args that
 * every one of those 170,682 rows already carries. That is what keeps this
 * detector genuinely live rather than dark while the stamp is undeployed — the
 * stamped legs light up on their own the moment the deploy lands, with no code
 * change here.
 */

/** How an agent's actions diverged from its declaration. */
export const DIVERGENCE_KINDS = [
  /** STAMPED: one intent bucket, ≥2 distinct goal refs — declared once, worked
   *  several goals without re-declaring. */
  'goal-drift-within-intent',
  /** UNSTAMPED SAMPLING: a call failed, then the SAME tool ran again with
   *  different args — the action changed while the declaration did not. */
  'retry-with-changed-args',
  /** UNSTAMPED SAMPLING: a call failed, then a DIFFERENT verb in the SAME tool
   *  namespace ran — a fallback within the family. */
  'tool-fallback-after-failure',
] as const;
export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number];

/** Why a run found no divergence. Only `'agreement'` is an informative zero. */
export const DIVERGENCE_ZERO_REASONS = [
  'no-calls',
  /** Nothing was stamped AND no failure was available to sample — both legs
   *  were structurally unable to run. */
  'nothing-comparable',
  /** The sampling legs ran and found nothing, but the stamped legs could not run
   *  at all (fill rate 0). A PARTIAL answer wearing a zero. */
  'stamped-legs-empty',
  'agreement',
] as const;
export type DivergenceZeroReason = (typeof DIVERGENCE_ZERO_REASONS)[number];

/**
 * True when the zero means "nothing was compared", not "no divergence exists".
 *
 * `stamped-legs-empty` counts as structural even though the sampling legs did
 * run: the caller asked about intent↔action divergence and the intent half was
 * never examined, so treating that as a clean bill of health is exactly the
 * misread this flag exists to prevent.
 */
export function isStructuralZero(reason: DivergenceZeroReason | null): boolean {
  return reason !== null && reason !== 'agreement';
}

/** Cap on returned findings — a payload bound, never a change to the counts. */
export const DIVERGENCE_LIMIT = 50;

/**
 * How far ahead of a failure the sampling legs look for a retry/fallback, in
 * calls by the SAME owner. Small on purpose: a retry is adjacent to its failure,
 * and a wide lookahead turns "the agent moved on" into a false positive.
 */
export const SAMPLING_LOOKAHEAD_CALLS = 5;

/** And a wall-clock bound, so a lookahead cannot span a wake boundary. */
export const SAMPLING_WINDOW_MS = 5 * 60_000;

/** Statuses that count as a failed call for the sampling legs. */
const FAILURE_STATUSES = new Set(['error', 'invalid-input', 'timeout', 'refused', 'denied']);

export function isFailureStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return FAILURE_STATUSES.has(status.trim().toLowerCase());
}

/** One `tool_invocations` row, reduced to the fields a verdict can rest on. */
export interface DivergenceCall {
  id: number;
  /** `coord_owner_id` — divergence is only ever defined WITHIN one agent. */
  ownerId: string;
  toolName: string;
  status: string | null;
  /** ISO-8601. Used for ordering and the sampling window only. */
  invokedAt: string;
  intentEventId?: number | null;
  goalRef?: string | null;
  /** Raw args; digested internally. Absent is fine — the retry leg then cannot
   *  fire for that call, which is reported, not guessed at. */
  args?: unknown;
}

/** The namespace half of a `group:verb` tool name; '' when unnamespaced. */
export function toolNamespace(toolName: string): string {
  const i = toolName.indexOf(':');
  return i > 0 ? toolName.slice(0, i) : '';
}

/**
 * Stable digest of a call's args, for "did the args CHANGE" only. Key-sorted so
 * property order never manufactures a difference; unserializable input yields
 * null, meaning "cannot tell", never a throw inside a detector.
 */
export function digestArgs(args: unknown): string | null {
  if (args === undefined) return null;
  try {
    return stableJson(args);
  } catch {
    return null;
  }
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableJson(val)}`).join(',')}}`;
}

/** One side of a finding — enough to read it without a second lookup. */
export interface DivergenceSide {
  callId: number;
  toolName: string;
  status: string | null;
  invokedAt: string;
  goalRef: string | null;
}

export interface Divergence {
  kind: DivergenceKind;
  ownerId: string;
  /** The intent bucket this was found in; null for the unstamped legs. */
  intentEventId: number | null;
  /** One line naming what diverged, in typed terms. Never inferred prose. */
  detail: string;
  a: DivergenceSide;
  b: DivergenceSide;
}

export interface DivergenceCoverage {
  callsExamined: number;
  /** Calls carrying an `intent_event_id`. */
  stampedCalls: number;
  /** Calls carrying a `goal_ref`. */
  goalStampedCalls: number;
  /**
   * `stampedCalls / callsExamined`, 0..1, rounded to 4dp. THE number P-015
   * measures. A zero here means every stamped leg below was unable to run —
   * see the module header.
   */
  stampFillRate: number;
  /** Distinct non-null `intent_event_id` values seen. */
  intentBuckets: number;
  /**
   * Buckets holding ≥2 calls with a goal ref — the ones that COULD produce a
   * `goal-drift-within-intent` verdict, whether or not they did. This is the
   * false-positive-rate denominator, the analog of P-011's `comparedPairs`.
   */
  comparableBuckets: number;
  /** Failed calls — the denominator for both sampling legs. */
  failuresSeen: number;
  /** Failures whose lookahead window actually held a later call to compare. */
  failuresSampled: number;
  /** Did the stamped legs have anything at all to compare? */
  stampedLegRan: boolean;
  /** Did the sampling legs have anything at all to compare? */
  samplingLegRan: boolean;
}

export interface DivergenceReport {
  divergences: Divergence[];
  /** True when {@link DIVERGENCE_LIMIT} cut the list; counts stay complete. */
  truncated: boolean;
  coverage: DivergenceCoverage;
  /** Null when divergence was found. Otherwise WHY the answer is zero. */
  structuralZero: DivergenceZeroReason | null;
}

function sideOf(c: DivergenceCall): DivergenceSide {
  return {
    callId: c.id,
    toolName: c.toolName,
    status: c.status,
    invokedAt: c.invokedAt,
    goalRef: c.goalRef ?? null,
  };
}

function timeOf(c: DivergenceCall): number {
  const t = Date.parse(c.invokedAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Deterministic order: by owner, then time, then id. Sorting defensively rather
 * than trusting the caller's ORDER BY means the same rows always yield the same
 * verdict — a property the tests assert directly.
 */
function ordered(calls: readonly DivergenceCall[]): DivergenceCall[] {
  return [...calls].sort((a, b) => {
    if (a.ownerId !== b.ownerId) return a.ownerId < b.ownerId ? -1 : 1;
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) return ta - tb;
    return a.id - b.id;
  });
}

/**
 * Find where actions diverged from declarations. Deterministic and total: same
 * input, same output, no I/O.
 *
 * Callers pass a BOUNDED window of one or more agents' calls. This module does
 * not decide the window — a detector that silently applied its own time bound
 * would disagree with the read that fed it and neither would be wrong on its own
 * terms (the same rule `conflicts.ts` follows for liveness).
 *
 * ── WHAT IS DELIBERATELY NOT A DIVERGENCE ───────────────────────────────────
 *
 * • **Several intent ids under ONE goal ref.** This is the NORMAL shape, not
 *   drift: an agent re-declares intent on every wake via `coord:orient` while
 *   holding the same claim throughout — `agent-state-stamp.ts` says so in as
 *   many words. Flagging it would fire on every long-running agent, every wake,
 *   which is precisely how a detector earns being ignored.
 * • **A goal ref going null.** `noteGoalClaimed(owner, null)` on release is a
 *   deliberate clear, so calls after a release legitimately carry no goal. Only
 *   two DISTINCT NON-NULL goals in one bucket are evidence of anything.
 * • **A failure followed by an unrelated tool.** The fallback leg requires the
 *   same NAMESPACE; without that, every failure followed by any next call is a
 *   "fallback" and the signal is noise.
 * • **A retry with IDENTICAL args.** That is a plain retry — the declaration and
 *   the action still agree. Only a CHANGED argument set is a mismatch between
 *   what was declared and what was done.
 */
export function detectIntentActionDivergence(calls: readonly DivergenceCall[]): DivergenceReport {
  const rows = ordered(calls);
  const divergences: Divergence[] = [];
  let truncated = false;

  const push = (d: Divergence): void => {
    if (divergences.length >= DIVERGENCE_LIMIT) {
      truncated = true;
      return;
    }
    divergences.push(d);
  };

  // ── Stamped leg: goal drift inside one intent bucket ──────────────────────
  // Keyed by owner AND intent id: an intent id is globally unique, but keying on
  // both makes the invariant explicit rather than incidental.
  const buckets = new Map<string, DivergenceCall[]>();
  let stampedCalls = 0;
  let goalStampedCalls = 0;
  for (const c of rows) {
    if (c.intentEventId != null) {
      stampedCalls += 1;
      const key = `${c.ownerId}\x00${c.intentEventId}`;
      const b = buckets.get(key);
      if (b) b.push(c);
      else buckets.set(key, [c]);
    }
    if (c.goalRef != null && c.goalRef !== '') goalStampedCalls += 1;
  }

  let comparableBuckets = 0;
  for (const bucket of buckets.values()) {
    const withGoal = bucket.filter((c) => c.goalRef != null && c.goalRef !== '');
    if (withGoal.length < 2) continue;
    // Counted BEFORE the distinctness test, and the distinction is load-bearing:
    // this is the "could be compared" denominator, not the "did diverge"
    // numerator. A healthy agent that holds ONE goal across a whole intent has a
    // comparable bucket that simply agrees — if that incremented nothing, its
    // clean result would be reported as a structural zero (nothing examined)
    // rather than as the real agreement it is.
    comparableBuckets += 1;
    const distinct = new Map<string, DivergenceCall>();
    for (const c of withGoal) {
      const g = c.goalRef as string;
      if (!distinct.has(g)) distinct.set(g, c);
    }
    if (distinct.size < 2) continue;
    // Report against the FIRST goal seen — the one the intent was declared
    // under. Pairing every goal against every other would multiply one drift
    // into n² findings that all describe the same event.
    const [first, ...rest] = [...distinct.values()];
    for (const other of rest) {
      push({
        kind: 'goal-drift-within-intent',
        ownerId: first.ownerId,
        intentEventId: first.intentEventId ?? null,
        detail: `one intent declaration spans goals ${first.goalRef} and ${other.goalRef} — the goal changed without a new intent being declared`,
        a: sideOf(first),
        b: sideOf(other),
      });
    }
  }

  // ── Sampling legs: retry-with-changed-args, and same-namespace fallback ────
  // These need no stamp, which is why they have live input today.
  const byOwner = new Map<string, DivergenceCall[]>();
  for (const c of rows) {
    const b = byOwner.get(c.ownerId);
    if (b) b.push(c);
    else byOwner.set(c.ownerId, [c]);
  }

  let failuresSeen = 0;
  let failuresSampled = 0;
  for (const owned of byOwner.values()) {
    for (let i = 0; i < owned.length; i += 1) {
      const fail = owned[i];
      if (!isFailureStatus(fail.status)) continue;
      failuresSeen += 1;
      const failAt = timeOf(fail);
      const failDigest = digestArgs(fail.args);
      const ns = toolNamespace(fail.toolName);
      let sampled = false;

      const end = Math.min(owned.length, i + 1 + SAMPLING_LOOKAHEAD_CALLS);
      for (let j = i + 1; j < end; j += 1) {
        const next = owned[j];
        if (timeOf(next) - failAt > SAMPLING_WINDOW_MS) break;
        sampled = true;

        if (next.toolName === fail.toolName) {
          const nextDigest = digestArgs(next.args);
          // Both digests must EXIST. A null means "args were not supplied to the
          // detector", and calling that a change would invent signal from a gap
          // in the input — the failure mode this whole module is guarding.
          if (failDigest != null && nextDigest != null && failDigest !== nextDigest) {
            push({
              kind: 'retry-with-changed-args',
              ownerId: fail.ownerId,
              intentEventId: fail.intentEventId ?? null,
              detail: `${fail.toolName} failed (${fail.status}) and was retried with DIFFERENT arguments — the action changed while the declaration did not`,
              a: sideOf(fail),
              b: sideOf(next),
            });
          }
          // Either way the retry answers this failure; stop scanning it.
          break;
        }

        if (ns !== '' && toolNamespace(next.toolName) === ns) {
          push({
            kind: 'tool-fallback-after-failure',
            ownerId: fail.ownerId,
            intentEventId: fail.intentEventId ?? null,
            detail: `${fail.toolName} failed (${fail.status}) and was followed by ${next.toolName} in the same '${ns}' namespace — a verb fallback`,
            a: sideOf(fail),
            b: sideOf(next),
          });
          break;
        }
      }
      if (sampled) failuresSampled += 1;
    }
  }

  const callsExamined = rows.length;
  const coverage: DivergenceCoverage = {
    callsExamined,
    stampedCalls,
    goalStampedCalls,
    stampFillRate: callsExamined === 0 ? 0 : round4(stampedCalls / callsExamined),
    intentBuckets: buckets.size,
    comparableBuckets,
    failuresSeen,
    failuresSampled,
    stampedLegRan: comparableBuckets > 0,
    samplingLegRan: failuresSampled > 0,
  };

  return {
    divergences,
    truncated,
    coverage,
    structuralZero: divergences.length > 0 ? null : zeroReasonFor(coverage),
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function zeroReasonFor(c: DivergenceCoverage): DivergenceZeroReason {
  if (c.callsExamined === 0) return 'no-calls';
  if (!c.stampedLegRan && !c.samplingLegRan) return 'nothing-comparable';
  if (!c.stampedLegRan) return 'stamped-legs-empty';
  return 'agreement';
}

/** One line naming what a zero actually means, for a delivered finding. */
export function explainZero(reason: DivergenceZeroReason): string {
  switch (reason) {
    case 'no-calls':
      return 'STRUCTURAL ZERO — no tool calls were handed in, so nothing was examined.';
    case 'nothing-comparable':
      return 'STRUCTURAL ZERO — calls exist but NONE carried an intent stamp and NONE failed, so neither the stamped legs nor the sampling legs could run. This is not "no divergence": nothing was compared.';
    case 'stamped-legs-empty':
      return 'PARTIAL — the sampling legs ran and found nothing, but stampFillRate is 0 so the intent/goal legs never ran. Until P-009\'s stamp is DEPLOYED every call carries NULL, and a zero here says nothing about intent↔action divergence.';
    case 'agreement':
      return 'A REAL ZERO — intent buckets were compared and the goals held within them agree.';
  }
}

/**
 * The delivery precondition. P-011 refuses to notify until its false-positive
 * rate is computable, on the grounds that wiring a detector into orient/coord
 * before the number exists is "the exact ordering the item forbids". The same
 * rule binds here, but PER LEG rather than for the whole detector: the sampling
 * legs have live input today (170,682 unstamped calls in 24h) while the stamped
 * legs have none, so a single global gate would either suppress a leg that works
 * or notify from a leg that cannot.
 *
 * Returns the kinds whose findings are safe to deliver given what actually ran.
 */
export function deliverableKinds(coverage: DivergenceCoverage): DivergenceKind[] {
  const out: DivergenceKind[] = [];
  if (coverage.stampedLegRan) out.push('goal-drift-within-intent');
  if (coverage.samplingLegRan) {
    out.push('retry-with-changed-args', 'tool-fallback-after-failure');
  }
  return out;
}
