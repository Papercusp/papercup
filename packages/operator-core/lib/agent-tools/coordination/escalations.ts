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
import { coordLog, coordSql, coordWorkspaceId } from './log';
import type { AgentIdentity } from './identity';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { systemDistinctId } from '../../flag-distinct-id';

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

/**
 * Read the OPEN escalation set from the materialized projection (mig 355) — a
 * small table holding exactly the currently-open escalation records, maintained
 * incrementally by the coord_open_escalations_trg trigger. This is the P-005
 * fast path: it replaces the unbounded ~35k-event full-surface replay
 * (loadEscalations -> readEvents) that pg_stat_statements pinned as ~88% of DB
 * exec time. The stored `body` IS the open EscalationRecord (resolved:null by
 * construction — resolved rows are deleted by the trigger). Sorted in JS with
 * the SAME comparator as foldEscalations({status:'open'}) so the output is
 * byte-identical to the fold path (collation-independent).
 */
async function readOpenEscalationsProjection(): Promise<EscalationRecord[]> {
  const sql = coordSql();
  const ws = coordWorkspaceId();
  const rows = await sql<{ body: EscalationRecord }[]>`
    SELECT body FROM harness_shared.coord_open_escalations
     WHERE workspace_id = ${ws}
  `;
  return rows
    .map((r) => r.body)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
}

/** List escalation records. Optionally filter by open/resolved. */
export async function listEscalations(
  opts: { status?: 'open' | 'resolved' } = {},
): Promise<EscalationRecord[]> {
  // P-005 fast path: serve the open set from the materialized projection instead
  // of the unbounded full-surface event replay, when the flag is ON. Fail-safe:
  // any flag-read or projection-read error falls through to the authoritative
  // fold below (e.g. before mig 355 applies, the projection table won't exist).
  if (opts.status === 'open') {
    let useProjection = false;
    try {
      useProjection = await getFlag(
        FLAGS.COORD_OPEN_ESCALATIONS_PROJECTION,
        systemDistinctId(),
      );
    } catch {
      useProjection = false;
    }
    if (useProjection) {
      try {
        return await readOpenEscalationsProjection();
      } catch {
        // fall through to the authoritative event-fold
      }
    }
  }
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

/** One escalation to resolve in a batch sweep. Mirrors the per-call ResolveInput
 *  fields the batch path needs (no `allowSpawnRequest` — spawn-approval requests
 *  are never auto-reconciled, so a batch never resolves them). */
export interface BatchResolveItem {
  msg_id: string;
  choice: string;
  resolver?: string;
  note?: string;
}

export interface BatchResolveResult {
  resolved: number;
  notFound: number;
  alreadyResolved: number;
  requiresSpawnApprove: number;
}

/**
 * Resolve MANY escalations from a SINGLE load of the escalation log.
 *
 * EI-1490: the attention-reconcile sweep used to call `resolveEscalation` once
 * per stale escalation, and EACH call re-reads the ENTIRE escalations surface
 * (`loadEscalations` → `readEvents`) to find the open + check the resolve index.
 * Over the live ~13k operational backlog that is O(n²) per tick (500 resolves ×
 * a full ~14k-event scan each), so a sweep tick is slow enough to drain only a
 * fraction of its batch before the step budget — the lane never actually
 * drained. This batch loads + indexes ONCE, then writes the sibling
 * `escalation_resolved` events in a single O(n) pass.
 *
 * Idempotent + safe exactly like `resolveEscalation`: an unknown id → notFound,
 * an already-resolved (or duplicate-in-batch) id → alreadyResolved (no write),
 * a spawn-approval request → requiresSpawnApprove (never auto-resolved).
 */
export async function resolveEscalationsBatch(
  inputs: readonly BatchResolveItem[],
): Promise<BatchResolveResult> {
  const result: BatchResolveResult = {
    resolved: 0,
    notFound: 0,
    alreadyResolved: 0,
    requiresSpawnApprove: 0,
  };
  if (inputs.length === 0) return result;

  // ONE load for the whole batch (the O(n²) → O(n) fix).
  const { opens, resolves } = await loadEscalations();
  const openById = new Map(opens.map((e) => [e.msg_id, e]));
  const alreadyResolved = indexResolves(resolves);
  // Also guard against the same msg_id appearing twice in `inputs`.
  const resolvedThisBatch = new Set<string>();

  for (const input of inputs) {
    const open = openById.get(input.msg_id);
    if (!open) {
      result.notFound += 1;
      continue;
    }
    if (alreadyResolved.has(input.msg_id) || resolvedThisBatch.has(input.msg_id)) {
      result.alreadyResolved += 1;
      continue;
    }
    if ((open as Record<string, unknown>).spawnRequest === true) {
      result.requiresSpawnApprove += 1;
      continue;
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
    resolvedThisBatch.add(input.msg_id);
    result.resolved += 1;
  }

  return result;
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
