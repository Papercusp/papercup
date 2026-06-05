/**
 * escalations.ts — operator host adapter for the agent → human channel.
 *
 * Record shapes + the append-only resolve fold live in
 * @papercusp/coordination/core; the per-event-file I/O lives behind the
 * CoordEventLog seam (coordLog). Original function surface preserved.
 *
 * agent-coordination-architecture-v2 §6.4 (#9). Append-only (P-012): the
 * open escalation record is immutable; a resolution is a SIBLING
 * 'escalation_resolved' event, and open/resolved state is derived by
 * folding the resolve events at read time.
 */

import {
  newMsgId,
  foldEscalations,
  foldResolved,
  indexResolves,
  type EscalationSeverity,
  type EscalationOption,
  type OpenEscalationInput,
  type ResolveInput,
  type EscalationRecord,
  type EscalationResolvedEvent,
} from '@papercusp/coordination/core';
import { coordLog } from './log';
import type { AgentIdentity } from './identity';

export type {
  EscalationSeverity,
  EscalationOption,
  OpenEscalationInput,
  ResolveInput,
  EscalationRecord,
  EscalationResolvedEvent,
};

/** Open a new escalation — writes the immutable per-event record. */
export async function openEscalation(
  identity: AgentIdentity,
  // `meta` is an optional domain-free extras bag persisted on the record via
  // CoordEnvelope's `[key:string]:unknown` index signature — inbox-cards-
  // unification Phase D (P-033) stashes `{ cardCorrelationId, cardWorkspaceId }`
  // here to link a durable escalation to a live ctx.askUser card. The generic
  // coordination lib is untouched (the field lives only in this adapter input).
  input: OpenEscalationInput & { meta?: Record<string, unknown> },
): Promise<EscalationRecord> {
  const env: EscalationRecord = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: ['human'],
    kind: 'escalation',
    severity: input.severity,
    summary: input.summary,
    resolved: null,
  };
  if (input.body !== undefined) env.body = input.body;
  if (input.plan_slug !== undefined) env.plan_slug = input.plan_slug;
  if (input.options !== undefined) env.options = input.options;
  if (input.meta) Object.assign(env, input.meta);
  await coordLog.putEvent('escalations', env.msg_id, env);
  return env;
}

/** Read every escalation event and split it into opens + resolves. */
async function loadEscalations(): Promise<{
  opens: EscalationRecord[];
  resolves: EscalationResolvedEvent[];
}> {
  const all = await coordLog.readEvents('escalations');
  const opens: EscalationRecord[] = [];
  const resolves: EscalationResolvedEvent[] = [];
  for (const rec of all) {
    if (rec.kind === 'escalation') opens.push(rec as EscalationRecord);
    else if (rec.kind === 'escalation_resolved') {
      const ev = rec as EscalationResolvedEvent;
      if (typeof ev.related_msg_id === 'string') resolves.push(ev);
    }
  }
  return { opens, resolves };
}

/** List escalation records. Optionally filter by open/resolved. */
export async function listEscalations(
  opts: { status?: 'open' | 'resolved' } = {},
): Promise<EscalationRecord[]> {
  const { opens, resolves } = await loadEscalations();
  return foldEscalations(opens, resolves, opts);
}

/** Read one escalation by msg_id (with folded resolution), or null. */
export async function getEscalation(
  msg_id: string,
): Promise<EscalationRecord | null> {
  const open = await coordLog.getEvent('escalations', msg_id);
  if (!open || open.kind !== 'escalation') return null;
  const { resolves } = await loadEscalations();
  return foldResolved(open as EscalationRecord, indexResolves(resolves).get(msg_id));
}

/**
 * Resolve an escalation by msg_id. Append-only: writes a sibling
 * `escalation_resolved` event (never mutates the open record). Returns
 * the folded record, `'not_found'`, or `'already_resolved'` (no write).
 */
export async function resolveEscalation(
  input: ResolveInput,
): Promise<EscalationRecord | 'not_found' | 'already_resolved'> {
  const { opens, resolves } = await loadEscalations();
  const open = opens.find((e) => e.msg_id === input.msg_id);
  if (!open) return 'not_found';
  if (indexResolves(resolves).has(input.msg_id)) return 'already_resolved';

  const ev: EscalationResolvedEvent = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: input.resolver ?? open.from,
    to: [open.from],
    kind: 'escalation_resolved',
    related_msg_id: input.msg_id,
    summary: `resolved: ${input.choice}`,
    choice: input.choice,
  };
  if (input.resolver !== undefined) ev.by = input.resolver;
  if (input.note !== undefined) ev.note = input.note;
  await coordLog.putEvent('escalations', ev.msg_id, ev);
  return foldResolved(open, ev);
}
