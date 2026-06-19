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

/**
 * List escalation records with pagination to prevent unbounded response sizes.
 * Loads up to maxRecords events, folds them, and returns with a truncated flag.
 * WI-239: bounds coord:escalations so one call never returns ~9M chars.
 */
export async function listEscalationsPaginated(
  opts: { status?: 'open' | 'resolved'; maxRecords?: number } = {},
): Promise<{ escalations: EscalationRecord[]; truncated: boolean; total: number }> {
  // EI-1548: bound the READ at the storage layer instead of loading the ENTIRE
  // escalations surface into memory and truncating after. Read a NEWEST-FIRST
  // window of recent events (opens + their sibling resolves) and fold within it;
  // `truncated` flags that older escalations exist beyond the window. The old
  // 1000-default returned a ~9MB dump over a ~13k backlog.
  const maxRecords = Math.max(1, Math.min(opts.maxRecords ?? 50, 500));
  const recent = await coordLog.readEventsBounded('escalations', { limit: maxRecords });
  const truncated = recent.length >= maxRecords;

  const opens: EscalationRecord[] = [];
  const resolves: EscalationResolvedEvent[] = [];
  for (const rec of recent) {
    if (rec.kind === 'escalation') opens.push(rec as EscalationRecord);
    else if (rec.kind === 'escalation_resolved') {
      const ev = rec as EscalationResolvedEvent;
      if (typeof ev.related_msg_id === 'string') resolves.push(ev);
    }
  }

  const escalations = foldEscalations(opens, resolves, opts);
  // `total` = events SCANNED in the bounded window (NOT the full backlog — that
  // would need an unbounded count); `truncated` signals more exist beyond it.
  return { escalations, truncated, total: recent.length };
}

/**
 * Close/archive escalations older than TTL that have been resolved.
 * GC for both operational (system) and user escalations to prevent unbounded growth.
 * WI-239: implement escalation lifecycle GC.
 */
export interface ArchiveEscalationOpts {
  resolvedOlderThanMs?: number; // Default 14 days (14 * 24 * 60 * 60 * 1000)
  limit?: number; // Max escalations to archive per call (batch limit, default 200)
}

export interface ArchiveResult {
  scanned: number;
  archived: number;
  truncated: boolean; // True if more remain beyond the batch limit
}

export async function archiveResolvedEscalations(
  opts: ArchiveEscalationOpts = {},
): Promise<ArchiveResult> {
  const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  const ttlMs = opts.resolvedOlderThanMs ?? DEFAULT_TTL_MS;
  const limit = opts.limit ?? 200;
  const nowMs = Date.now();
  
  const { opens, resolves } = await loadEscalations();
  const resolveMap = indexResolves(resolves);
  
  // Find resolved escalations older than TTL
  const toArchive: string[] = [];
  for (const open of opens) {
    const resolved = resolveMap.get(open.msg_id);
    if (!resolved) continue; // Not resolved yet
    
    const resolvedMs = Date.parse(resolved.ts);
    if (!Number.isFinite(resolvedMs)) continue;
    
    const ageMs = nowMs - resolvedMs;
    if (ageMs >= ttlMs) {
      toArchive.push(open.msg_id);
      if (toArchive.length >= limit) break;
    }
  }
  
  // Archive by creating a special "archived" resolution event
  // (idempotent: if already archived, this is a no-op from the fold perspective)
  let archived = 0;
  for (const msgId of toArchive) {
    const archiveEv: EscalationResolvedEvent = {
      ts: new Date().toISOString(),
      msg_id: newMsgId(),
      from: 'system:escalation-gc',
      to: ['human'],
      kind: 'escalation_resolved',
      related_msg_id: msgId,
      summary: 'auto-archived: resolved escalation aged beyond retention',
      choice: 'auto-archived',
    };
    await coordLog.putEvent('escalations', archiveEv.msg_id, archiveEv);
    archived += 1;
  }
  
  return { scanned: opens.length, archived, truncated: toArchive.length >= limit };
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
  opts: { allowSpawnRequest?: boolean } = {},
): Promise<EscalationRecord | 'not_found' | 'already_resolved' | 'requires_spawn_approve'> {
  const { opens, resolves } = await loadEscalations();
  const open = opens.find((e) => e.msg_id === input.msg_id);
  if (!open) return 'not_found';
  if (indexResolves(resolves).has(input.msg_id)) return 'already_resolved';
  // unify-agent-spawn-chokepoint P-005/P-006: a `new_subagent` spawn-approval request
  // (it carries meta.spawnRequest) is resolvable ONLY via the brain-gated
  // `new_subagent:approve` tool (which passes allowSpawnRequest), NOT the general
  // `coord:resolve` (open to all coord roles). This is what makes "only the brain
  // decides spawns" enforced at the tool layer, not prompt convention.
  if ((open as Record<string, unknown>).spawnRequest === true && !opts.allowSpawnRequest) {
    return 'requires_spawn_approve';
  }

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
