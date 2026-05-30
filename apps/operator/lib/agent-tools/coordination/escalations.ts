/**
 * escalations.ts — agent → human channel.
 *
 * agent-coordination-architecture-v2 §6.4 (#9). One file per event at
 * coord/escalations/<msg_id>.json.
 *
 * Append-only event log (P-012, 2026-05-30). The open escalation file
 * is written ONCE and never mutated. A resolution is a SIBLING file
 * with `kind: 'escalation_resolved'` and `related_msg_id` pointing at
 * the original — exactly mirroring how handoffs records an acceptance
 * as a `handoff_accepted` sibling. The current state (open vs
 * resolved) is DERIVED by folding the resolve events over the opens at
 * read time. No in-place mutation: the whole surface is now a pure
 * append-only log, which is what lets `CoordEventLog` swap a
 * PG-backed store for the filesystem one (papercusp-systems-abstraction
 * D-009 / P-011).
 *
 * Per-event files mean every file has exactly one writer (the opener
 * for the open, the resolver for the resolve), so no lock is needed.
 *
 * The returned `EscalationRecord.resolved` field is a read-time
 * overlay derived from the folded `escalation_resolved` event — on
 * disk the open file always carries `resolved: null`.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { escalationsDir, escalationFile } from './paths';
import { newMsgId, type CoordEnvelope } from './envelope';
import type { AgentIdentity } from './identity';

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
   * Read-time overlay: null while open, populated by folding the
   * sibling `escalation_resolved` event. Never persisted as non-null
   * on the open file (see file header).
   */
  resolved: null | {
    choice: string;
    ts: string;
    by?: string;
    note?: string;
  };
}

/** The append-only resolution event written as a sibling file. */
export interface EscalationResolvedEvent extends CoordEnvelope {
  kind: 'escalation_resolved';
  /** msg_id of the escalation this resolves. */
  related_msg_id: string;
  choice: string;
  /** ownerId of the resolver, when known. */
  by?: string;
  note?: string;
}

/** Open a new escalation — writes the immutable per-event file. */
export async function openEscalation(
  identity: AgentIdentity,
  input: OpenEscalationInput,
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
  await fs.mkdir(escalationsDir(), { recursive: true });
  await fs.writeFile(escalationFile(env.msg_id), JSON.stringify(env, null, 2), 'utf8');
  return env;
}

/**
 * Read every file in the escalations dir once and split it into open
 * records and a map of resolution events keyed by the escalation they
 * resolve. If more than one resolution exists for the same escalation
 * (e.g. a concurrent double-resolve that beat the idempotency check),
 * the earliest by (ts, msg_id) wins — deterministic.
 */
async function loadEscalationDir(): Promise<{
  opens: EscalationRecord[];
  resolvedByTarget: Map<string, EscalationResolvedEvent>;
}> {
  const dir = escalationsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { opens: [], resolvedByTarget: new Map() };
    }
    throw e;
  }
  const opens: EscalationRecord[] = [];
  const resolves: EscalationResolvedEvent[] = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const buf = await fs.readFile(join(dir, f), 'utf8');
      const rec = JSON.parse(buf) as CoordEnvelope;
      if (!rec || typeof rec !== 'object') continue;
      if (rec.kind === 'escalation') {
        opens.push(rec as EscalationRecord);
      } else if (rec.kind === 'escalation_resolved') {
        const ev = rec as EscalationResolvedEvent;
        if (typeof ev.related_msg_id === 'string') resolves.push(ev);
      }
    } catch {
      // skip malformed files
    }
  }
  resolves.sort(
    (a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id),
  );
  const resolvedByTarget = new Map<string, EscalationResolvedEvent>();
  for (const ev of resolves) {
    // first writer wins (resolves is ts-sorted ascending)
    if (!resolvedByTarget.has(ev.related_msg_id)) {
      resolvedByTarget.set(ev.related_msg_id, ev);
    }
  }
  return { opens, resolvedByTarget };
}

/** Overlay a resolve event onto an open record's `resolved` field. */
function foldResolved(
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

/** List escalation records. Optionally filter by open/resolved. */
export async function listEscalations(
  opts: { status?: 'open' | 'resolved' } = {},
): Promise<EscalationRecord[]> {
  const { opens, resolvedByTarget } = await loadEscalationDir();
  const out: EscalationRecord[] = [];
  for (const open of opens) {
    const folded = foldResolved(open, resolvedByTarget.get(open.msg_id));
    if (opts.status === 'open' && folded.resolved != null) continue;
    if (opts.status === 'resolved' && folded.resolved == null) continue;
    out.push(folded);
  }
  out.sort(
    (a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id),
  );
  return out;
}

/** Read one escalation by msg_id (with folded resolution), or null. */
export async function getEscalation(
  msg_id: string,
): Promise<EscalationRecord | null> {
  let buf: string;
  try {
    buf = await fs.readFile(escalationFile(msg_id), 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw e;
  }
  const open = JSON.parse(buf) as EscalationRecord;
  if (open.kind !== 'escalation') return null;
  const { resolvedByTarget } = await loadEscalationDir();
  return foldResolved(open, resolvedByTarget.get(msg_id));
}

/**
 * Resolve an escalation by msg_id. Append-only: writes a sibling
 * `escalation_resolved` event file (never mutates the open file).
 * Returns the folded (resolved) record, or `'not_found'` if no such
 * escalation exists, or `'already_resolved'` if a resolution event is
 * already present (no write).
 */
export async function resolveEscalation(
  input: ResolveInput,
): Promise<EscalationRecord | 'not_found' | 'already_resolved'> {
  const { opens, resolvedByTarget } = await loadEscalationDir();
  const open = opens.find((e) => e.msg_id === input.msg_id);
  if (!open) return 'not_found';
  if (resolvedByTarget.has(input.msg_id)) return 'already_resolved';

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
  await fs.mkdir(escalationsDir(), { recursive: true });
  await fs.writeFile(escalationFile(ev.msg_id), JSON.stringify(ev, null, 2), 'utf8');
  return foldResolved(open, ev);
}
