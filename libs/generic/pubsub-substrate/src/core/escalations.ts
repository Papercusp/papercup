/**
 * escalations.ts — escalation record shapes + the append-only resolve
 * fold. PURE.
 *
 * agent-coordination-architecture-v2 §6.4 (#9). An escalation is an
 * immutable event; a resolution is a SIBLING event with kind
 * 'escalation_resolved' + related_msg_id (P-012). The open/resolved
 * state is DERIVED by folding the resolve events over the opens —
 * `foldResolved` overlays one, `foldEscalations` does the whole set.
 * The per-event-file I/O lives behind the CoordEventLog seam.
 */

import { type CoordEnvelope } from './envelope';

export type EscalationSeverity = 'blocker' | 'question' | 'advisory';

export interface EscalationOption {
  id: string;
  label: string;
}

export interface OpenEscalationInput {
  severity: EscalationSeverity;
  summary: string;
  body?: string;
  plan_slug?: string;
  options?: EscalationOption[];
}

export interface ResolveInput {
  msg_id: string;
  choice: string;
  note?: string;
  /** Identity of the resolver (often the human, surfaced through ctx). */
  resolver?: string;
}

export interface EscalationRecord extends CoordEnvelope {
  kind: 'escalation';
  severity: EscalationSeverity;
  options?: EscalationOption[];
  /**
   * Read-time overlay: null while open, populated by folding the sibling
   * `escalation_resolved` event. Never persisted as non-null on the open
   * record.
   */
  resolved: null | {
    choice: string;
    ts: string;
    by?: string;
    note?: string;
  };
}

/** The append-only resolution event. */
export interface EscalationResolvedEvent extends CoordEnvelope {
  kind: 'escalation_resolved';
  related_msg_id: string;
  choice: string;
  by?: string;
  note?: string;
}

/** Overlay a resolve event onto an open record's `resolved` field. */
export function foldResolved(
  open: EscalationRecord,
  ev: EscalationResolvedEvent | undefined,
): EscalationRecord {
  if (!ev) return { ...open, resolved: null };
  const resolved: NonNullable<EscalationRecord['resolved']> = {
    choice: ev.choice,
    ts: ev.ts,
  };
  if (ev.by !== undefined) resolved.by = ev.by;
  if (ev.note !== undefined) resolved.note = ev.note;
  return { ...open, resolved };
}

/**
 * Build the map of resolution events keyed by the escalation they
 * resolve. If more than one resolution exists for the same escalation
 * (a concurrent double-resolve that beat the idempotency check), the
 * earliest by (ts, msg_id) wins — deterministic.
 */
export function indexResolves(
  resolves: EscalationResolvedEvent[],
): Map<string, EscalationResolvedEvent> {
  const sorted = [...resolves].sort(
    (a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id),
  );
  const byTarget = new Map<string, EscalationResolvedEvent>();
  for (const ev of sorted) {
    if (!byTarget.has(ev.related_msg_id)) byTarget.set(ev.related_msg_id, ev);
  }
  return byTarget;
}

/**
 * Fold open escalations with their resolution events. Optionally filter
 * by open/resolved. Sorted ascending by (ts, msg_id).
 */
export function foldEscalations(
  opens: EscalationRecord[],
  resolves: EscalationResolvedEvent[],
  opts: { status?: 'open' | 'resolved' } = {},
): EscalationRecord[] {
  const byTarget = indexResolves(resolves);
  const out: EscalationRecord[] = [];
  for (const open of opens) {
    const folded = foldResolved(open, byTarget.get(open.msg_id));
    if (opts.status === 'open' && folded.resolved != null) continue;
    if (opts.status === 'resolved' && folded.resolved == null) continue;
    out.push(folded);
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
}
