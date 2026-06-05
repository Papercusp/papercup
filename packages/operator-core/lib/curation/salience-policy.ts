/**
 * Salience policy — the one genuinely-new design piece of the curator-operator
 * (plan `curator-operator-2026-06-04`, D-004 → settled in D-007).
 *
 * The operator is the user's single voice; the fleet reports up STRUCTURED
 * status (escalations, blockers, decisions-needed, completions, routine
 * progress). This module decides — purely, deterministically, with ZERO LLM
 * tokens — what the operator should **surface now**, **batch into a calm
 * digest**, or **stay quiet about**. The LLM `operator:scan` stays for richer
 * proactive *suggestions*; this is the cheap, auditable, always-on filter.
 *
 * Faithful to D-004:
 *  - ALWAYS surface: escalations, blockers, decisions-needed, completions of
 *    user-requested work.
 *  - BATCH-summarize: routine progress + fleet-internal completions.
 *  - STAY SILENT: healthy in-progress work emits no signal at all (no row →
 *    nothing to classify).
 *  - Escalations / blockers can NEVER be suppressed by the filter on their
 *    merits — see the `baseDisposition` invariant + its test.
 *
 * Pure + side-effect-free so it is unit-testable without a database. The loop
 * (`curation-loop.ts`) owns I/O; this file owns the *decision*.
 */

/** Version stamped on every surfaced row so "why did this surface?" is always
 *  answerable (the reactive-graph / audit trail). Bump on a policy change. */
export const SALIENCE_POLICY_VERSION = 'curator-v1';

/**
 * The normalized, structured unit the curator reasons over. Produced by
 * `gatherFleetSignals` (`fleet-signals.ts`) from the canonical coord /
 * work_items sources — never from raw agent transcripts (D-002 / the
 * "operator token cost" risk mitigation).
 */
export type FleetSignalKind =
  /** An agent → human escalation (coord `escalations`). */
  | 'escalation'
  /** Work is blocked: a blocked plan-item / open blocking issue / feature
   *  status=blocked / an escalation with severity 'blocker'. */
  | 'blocker'
  /** A decision is needed: needs_human_review / needs_design / an escalation
   *  with severity 'question'. Always surfaced, but not a fire-alarm. */
  | 'decision'
  /** A work_item reached a terminal done/resolved state. */
  | 'completion'
  /** Routine progress (a subscribed work_item update / plan-event). */
  | 'progress';

export interface FleetSignal {
  /** Stable dedup key, e.g. `escalation:<msgId>`, `wi-done:<harness>#<id>`.
   *  Two ticks observing the same underlying fact MUST produce the same id. */
  id: string;
  kind: FleetSignalKind;
  /** One calm line for the user. */
  title: string;
  /** Optional second line (e.g. the blocking reason). */
  detail?: string;
  /** Owning harness slug, when applicable. */
  harness?: string;
  /** The work_item id (WI-/F-/EI-NNN) this signal is about, when applicable. */
  workItemId?: string;
  /** Escalation severity, when kind derives from an escalation. */
  severity?: 'blocker' | 'question' | 'advisory';
  /** Provenance: was this work requested by the human (vs fleet-internal)?
   *  Gates whether a `completion` is surfaced or batched. */
  userRequested?: boolean;
  /** Drill-in pointer for the D-005 overlay fallback — curation never hides;
   *  the raw item is always reachable (e.g. `escalation:<msgId>`,
   *  `wi:<harness>#<id>`, `coord:inbox`). */
  ref?: string;
  /** ISO timestamp of the underlying event. */
  ts: string;
}

export type Disposition = 'surface' | 'batch' | 'suppress';

export interface SalienceVerdict {
  disposition: Disposition;
  /** `urgent` ⇒ the P2 event-driven immediate wake; else it rides the cadence.
   *  Only escalations + blockers are urgent. */
  urgent: boolean;
  /** Human-readable why — recorded for the "why did this surface?" audit. */
  reason: string;
}

export interface SalienceState {
  /** Dedup keys already surfaced within the recent window
   *  (`operator_curation_log`). Prevents re-nagging the SAME signal. */
  alreadySurfaced: ReadonlySet<string>;
}

/**
 * The kind → (disposition, urgent) map BEFORE the idempotency overlay. Pure on
 * `kind` (+ provenance for completions). Exported so the never-suppress
 * invariant is directly testable:
 *
 *   baseDisposition('escalation').disposition === 'surface'  // always
 *   baseDisposition('blocker').disposition    === 'surface'  // always
 *
 * This encodes D-004: the salience policy NEVER suppresses an escalation /
 * blocker on its merits. (The only suppression is the exact-repeat idempotency
 * overlay below — that is de-dup, not hiding: the raw item always remains in
 * the coord inbox + the overlay drill-in, D-005.)
 */
export function baseDisposition(
  kind: FleetSignalKind,
  userRequested?: boolean,
): { disposition: Disposition; urgent: boolean; reason: string } {
  switch (kind) {
    case 'escalation':
      return { disposition: 'surface', urgent: true, reason: 'escalation — always surface, urgent' };
    case 'blocker':
      return { disposition: 'surface', urgent: true, reason: 'blocker — always surface, urgent' };
    case 'decision':
      // Always surface, but can wait one cadence tick — not a fire-alarm.
      return { disposition: 'surface', urgent: false, reason: 'decision-needed — always surface' };
    case 'completion':
      return userRequested
        ? { disposition: 'surface', urgent: false, reason: 'completion of user-requested work — surface' }
        : { disposition: 'batch', urgent: false, reason: 'fleet-internal completion — batch' };
    case 'progress':
      return { disposition: 'batch', urgent: false, reason: 'routine progress — batch' };
    default:
      // Defensive: unknown kinds are batched, never surfaced or dropped.
      return { disposition: 'batch', urgent: false, reason: 'unknown kind — batch (defensive)' };
  }
}

/**
 * Classify ONE signal: the kind-based disposition, then the idempotency
 * overlay (already-surfaced → suppress, so we don't re-surface the same fact
 * every tick). A NEW escalation/blocker is always surfaced.
 */
export function classifySignal(signal: FleetSignal, state: SalienceState): SalienceVerdict {
  const base = baseDisposition(signal.kind, signal.userRequested);
  if (base.disposition !== 'suppress' && state.alreadySurfaced.has(signal.id)) {
    // Idempotency, NOT salience-suppression — prevents re-nagging the same
    // signal. The raw item stays reachable via the coord inbox + drill-in ref.
    return { disposition: 'suppress', urgent: false, reason: 'already-surfaced (idempotency)' };
  }
  return base;
}

/** Classify a batch of signals; returns a map keyed by `signal.id`. */
export function classifyAll(
  signals: readonly FleetSignal[],
  state: SalienceState,
): Map<string, SalienceVerdict> {
  const out = new Map<string, SalienceVerdict>();
  for (const s of signals) out.set(s.id, classifySignal(s, state));
  return out;
}

/** A signal paired with its verdict — the loop's working unit. */
export interface ClassifiedSignal {
  signal: FleetSignal;
  verdict: SalienceVerdict;
}

/**
 * Partition classified signals into the three buckets the loop acts on:
 *  - `surfaceNow` — disposition 'surface' (urgent first, then the rest)
 *  - `batch`      — disposition 'batch' (collapsed into one digest)
 *  - everything else (suppressed) is dropped.
 * `surfaceNow` is ordered urgent-first so the most important line leads.
 */
export function partition(
  signals: readonly FleetSignal[],
  verdicts: ReadonlyMap<string, SalienceVerdict>,
): { surfaceNow: ClassifiedSignal[]; batch: ClassifiedSignal[]; hasUrgent: boolean } {
  const surfaceNow: ClassifiedSignal[] = [];
  const batch: ClassifiedSignal[] = [];
  let hasUrgent = false;
  for (const signal of signals) {
    const verdict = verdicts.get(signal.id);
    if (!verdict) continue;
    if (verdict.disposition === 'surface') {
      surfaceNow.push({ signal, verdict });
      if (verdict.urgent) hasUrgent = true;
    } else if (verdict.disposition === 'batch') {
      batch.push({ signal, verdict });
    }
  }
  // Urgent first within surfaceNow (escalations/blockers lead the message).
  surfaceNow.sort((a, b) => Number(b.verdict.urgent) - Number(a.verdict.urgent));
  return { surfaceNow, batch, hasUrgent };
}
