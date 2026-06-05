/**
 * Fleet-signal gather — the INPUT half of the curator-operator
 * (plan `curator-operator-2026-06-04`, P0/P2/P3).
 *
 * Normalizes the canonical STRUCTURED fleet sources (coord escalations,
 * blocked plan-items/issues, needs-human/needs-design decisions + human
 * handoffs, work_item completions, routine progress) into a single
 * `FleetSignal[]` the salience policy classifies. It reads *structured status*,
 * never agent transcripts (D-002 / the "operator token cost" mitigation).
 *
 * Sources are injected as a `FleetReaders` bag so this normalizer is unit-
 * testable with fakes (the `autoloop.ts` test convention). The production wiring
 * (`deps.ts`) adapts the real coord / work_items readers into these minimal
 * shapes. Each reader is run defensively: a failing source yields `[]` and never
 * kills the tick.
 */
import type { FleetSignal, FleetSignalKind } from './salience-policy';

/** An open coord escalation (agent → human). */
export interface RawEscalation {
  msgId: string;
  /** 'blocker' | 'question' | 'advisory' (coord EscalationSeverity). */
  severity?: 'blocker' | 'question' | 'advisory' | string;
  summary: string;
  from?: string;
  harness?: string;
  planSlug?: string;
  ts: string;
}

/** A blocked plan-item / feature (NOT sourced from an escalation). */
export interface RawBlockedItem {
  /** Stable ref of the blocked item, e.g. `<plan>#<P-id>` or `feature:<h>#<id>`. */
  ref: string;
  harness?: string;
  title: string;
  /** Why it's blocked (e.g. the blocking issue ids). */
  reason?: string;
  workItemId?: string;
  ts?: string;
}

/** A decision the human owes — needs_human_review / needs_design / a human
 *  handoff / an escalation-question (the latter is split out of escalations,
 *  so a `decisions()` reader must NOT re-include escalation rows). */
export interface RawDecision {
  /** Stable id, e.g. `review:<h>#<id>`, `handoff:<msgId>`, `design:<h>#<id>`. */
  id: string;
  harness?: string;
  title: string;
  detail?: string;
  workItemId?: string;
  ref?: string;
  ts: string;
}

/** A work_item that reached a terminal done/resolved state. */
export interface RawCompletion {
  workItemId: string;
  harness?: string;
  title: string;
  /** Provenance: did the human request this work? Gates surface-vs-batch. */
  userRequested?: boolean;
  ref?: string;
  ts: string;
}

/** Routine progress (a subscribed work_item update / plan-event). */
export interface RawProgress {
  /** Stable id, e.g. `notify:<msgId>`, `plan-event:<id>`. */
  id: string;
  harness?: string;
  title: string;
  detail?: string;
  ref?: string;
  ts: string;
}

/** The injectable source bag. Each returns already-fetched, lightly-shaped rows. */
export interface FleetReaders {
  escalations(): Promise<RawEscalation[]>;
  blocked(): Promise<RawBlockedItem[]>;
  decisions(): Promise<RawDecision[]>;
  completions(): Promise<RawCompletion[]>;
  progress(): Promise<RawProgress[]>;
}

/** Map an escalation's severity onto a FleetSignal kind:
 *  blocker → 'blocker' (urgent), question → 'decision' (surface, calm),
 *  else (advisory/unset) → 'escalation' (the intentional human interrupt). */
export function escalationKind(severity?: string): FleetSignalKind {
  if (severity === 'blocker') return 'blocker';
  if (severity === 'question') return 'decision';
  return 'escalation';
}

/** Run a reader, swallowing errors to `[]` — one bad source can't kill the tick. */
async function safe<T>(fn: () => Promise<T[]>, label: string): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[curation] reader "${label}" failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Gather + normalize every source into one `FleetSignal[]`, de-duplicated by
 * `id` (first-wins) and sorted newest-first. Pure over the injected readers.
 */
export async function gatherFleetSignals(readers: FleetReaders): Promise<FleetSignal[]> {
  const [esc, blk, dec, cmp, prog] = await Promise.all([
    safe(() => readers.escalations(), 'escalations'),
    safe(() => readers.blocked(), 'blocked'),
    safe(() => readers.decisions(), 'decisions'),
    safe(() => readers.completions(), 'completions'),
    safe(() => readers.progress(), 'progress'),
  ]);

  const signals: FleetSignal[] = [];

  for (const e of esc) {
    const kind = escalationKind(e.severity);
    signals.push({
      id: `escalation:${e.msgId}`,
      kind,
      title: e.summary,
      harness: e.harness,
      severity: (e.severity === 'blocker' || e.severity === 'question' || e.severity === 'advisory')
        ? e.severity
        : undefined,
      ref: `escalation:${e.msgId}`,
      ts: e.ts,
    });
  }

  for (const b of blk) {
    signals.push({
      id: `blocked:${b.ref}`,
      kind: 'blocker',
      title: b.title,
      detail: b.reason,
      harness: b.harness,
      workItemId: b.workItemId,
      ref: `wi:${b.ref}`,
      ts: b.ts ?? new Date(0).toISOString(),
    });
  }

  for (const d of dec) {
    signals.push({
      id: `decision:${d.id}`,
      kind: 'decision',
      title: d.title,
      detail: d.detail,
      harness: d.harness,
      workItemId: d.workItemId,
      ref: d.ref ?? `decision:${d.id}`,
      ts: d.ts,
    });
  }

  for (const c of cmp) {
    signals.push({
      id: `completion:${c.workItemId}`,
      kind: 'completion',
      title: c.title,
      harness: c.harness,
      workItemId: c.workItemId,
      userRequested: c.userRequested ?? false,
      ref: c.ref ?? `wi:${c.workItemId}`,
      ts: c.ts,
    });
  }

  for (const p of prog) {
    signals.push({
      id: `progress:${p.id}`,
      kind: 'progress',
      title: p.title,
      detail: p.detail,
      harness: p.harness,
      ref: p.ref,
      ts: p.ts,
    });
  }

  return dedupById(signals).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

/** First-wins de-dup by `id` (two sources naming the same fact collapse). */
export function dedupById(signals: readonly FleetSignal[]): FleetSignal[] {
  const seen = new Set<string>();
  const out: FleetSignal[] = [];
  for (const s of signals) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}
