/**
 * escalations.ts — agent → human channel.
 *
 * agent-coordination-architecture-v2 §6.4 (#9). One file per
 * escalation at coord/escalations/<msg_id>.json. The file's JSON IS
 * the envelope, with an extra `severity`, `options?`, and `resolved`
 * field that starts null and is filled in-place on resolve.
 *
 * Per-event files mean every escalation has exactly one writer (the
 * opener for the open, the resolver for the resolve), so we don't
 * need a lock — read-modify-write the one file.
 *
 * Resolve semantics: the human (or the resolver tool) sets
 * `resolved = { choice, ts, note? }`. listEscalations({status:'open'})
 * filters out files whose `resolved` field is set.
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
  resolved: null | {
    choice: string;
    ts: string;
    by?: string;
    note?: string;
  };
}

/** Open a new escalation — appends a per-event file. */
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

/** List escalation records. Optionally filter by open/resolved. */
export async function listEscalations(
  opts: { status?: 'open' | 'resolved' } = {},
): Promise<EscalationRecord[]> {
  const dir = escalationsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const out: EscalationRecord[] = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const buf = await fs.readFile(join(dir, f), 'utf8');
      const rec = JSON.parse(buf) as EscalationRecord;
      if (!rec || rec.kind !== 'escalation') continue;
      if (opts.status === 'open' && rec.resolved != null) continue;
      if (opts.status === 'resolved' && rec.resolved == null) continue;
      out.push(rec);
    } catch {
      // skip malformed files
    }
  }
  out.sort(
    (a, b) =>
      a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id),
  );
  return out;
}

/** Read one escalation by msg_id, or null. */
export async function getEscalation(
  msg_id: string,
): Promise<EscalationRecord | null> {
  try {
    const buf = await fs.readFile(escalationFile(msg_id), 'utf8');
    return JSON.parse(buf) as EscalationRecord;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Resolve an escalation by msg_id. Read-modify-writes the per-event
 * file in place. Returns the updated record, or null if not found.
 * Returns `'already_resolved'` if the file is already resolved (no
 * write).
 */
export async function resolveEscalation(
  input: ResolveInput,
): Promise<EscalationRecord | 'not_found' | 'already_resolved'> {
  const filepath = escalationFile(input.msg_id);
  let buf: string;
  try {
    buf = await fs.readFile(filepath, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return 'not_found';
    throw e;
  }
  const rec = JSON.parse(buf) as EscalationRecord;
  if (rec.resolved != null) return 'already_resolved';
  rec.resolved = {
    choice: input.choice,
    ts: new Date().toISOString(),
  };
  if (input.note !== undefined) rec.resolved.note = input.note;
  if (input.resolver !== undefined) rec.resolved.by = input.resolver;
  await fs.writeFile(filepath, JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}
