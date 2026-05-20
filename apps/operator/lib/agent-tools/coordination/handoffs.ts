/**
 * handoffs.ts — agent → agent work transition events.
 *
 * agent-coordination-architecture-v2 §6.4 (#8). One file per
 * handoff at coord/handoffs/<msg_id>.json — the "I'm done, you're up"
 * record. Append-only: an acceptance is a SIBLING file with the same
 * shape but `kind: 'handoff_accepted'` and `related_msg_id` pointing
 * at the original handoff. No in-place mutation; pure event log.
 *
 * Per-event files = one writer per file = no lock needed.
 *
 * `## Now` integration (plan §6.4 #8): when a receiver calls
 * `plans:set-now` on the named plan_slug, the verb auto-emits a
 * handoff_accepted. That hook is deferred to the plans verb work;
 * for now the receiver calls coord:handoff with related_msg_id set
 * (or a dedicated coord:accept-handoff in a later increment).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { handoffsDir, handoffFile } from './paths';
import { newMsgId, type CoordEnvelope } from './envelope';
import type { AgentIdentity } from './identity';

export interface OpenHandoffInput {
  to: string[];
  plan_slug: string;
  summary: string;
  body?: string;
  next_action?: string;
  files_modified?: string[];
  commit?: string;
}

export interface HandoffRecord extends CoordEnvelope {
  kind: 'handoff' | 'handoff_accepted';
  next_action?: string;
  files_modified?: string[];
}

export interface HandoffWithAcceptance {
  record: HandoffRecord;
  accepted_by?: HandoffRecord;
}

/** Open a new handoff — writes the per-event file. */
export async function openHandoff(
  identity: AgentIdentity,
  input: OpenHandoffInput,
): Promise<HandoffRecord> {
  const env: HandoffRecord = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: input.to,
    kind: 'handoff',
    plan_slug: input.plan_slug,
    summary: input.summary,
  };
  if (input.body !== undefined) env.body = input.body;
  if (input.next_action !== undefined) env.next_action = input.next_action;
  if (input.files_modified !== undefined) env.files_modified = input.files_modified;
  if (input.commit !== undefined) env.commit = input.commit;
  await fs.mkdir(handoffsDir(), { recursive: true });
  await fs.writeFile(handoffFile(env.msg_id), JSON.stringify(env, null, 2), 'utf8');
  return env;
}

/**
 * Accept a handoff by msg_id — writes a sibling file with kind
 * 'handoff_accepted' and related_msg_id pointing at the original.
 * Returns the new acceptance record, or null when the target handoff
 * does not exist.
 */
export async function acceptHandoff(
  identity: AgentIdentity,
  targetMsgId: string,
  note?: string,
): Promise<HandoffRecord | null> {
  const target = await getHandoff(targetMsgId);
  if (!target) return null;
  const env: HandoffRecord = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: [target.from],
    kind: 'handoff_accepted',
    related_msg_id: targetMsgId,
    plan_slug: target.plan_slug,
    summary: note ?? `accepted handoff from ${target.from}`,
  };
  await fs.mkdir(handoffsDir(), { recursive: true });
  await fs.writeFile(handoffFile(env.msg_id), JSON.stringify(env, null, 2), 'utf8');
  return env;
}

/** Read one handoff record by msg_id. */
export async function getHandoff(
  msgId: string,
): Promise<HandoffRecord | null> {
  try {
    const buf = await fs.readFile(handoffFile(msgId), 'utf8');
    return JSON.parse(buf) as HandoffRecord;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * List handoffs (with acceptance status). Optionally filter to only
 * those still open (no acceptance file in the dir).
 */
export async function listHandoffs(
  opts: { status?: 'open' | 'accepted' } = {},
): Promise<HandoffWithAcceptance[]> {
  const dir = handoffsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const records: HandoffRecord[] = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const buf = await fs.readFile(join(dir, f), 'utf8');
      const rec = JSON.parse(buf) as HandoffRecord;
      if (rec.kind === 'handoff' || rec.kind === 'handoff_accepted') {
        records.push(rec);
      }
    } catch {
      // skip
    }
  }
  // Group: handoff records → optional acceptance.
  const handoffs = records.filter((r) => r.kind === 'handoff');
  const acceptsByTarget = new Map<string, HandoffRecord>();
  for (const r of records) {
    if (r.kind === 'handoff_accepted' && r.related_msg_id) {
      acceptsByTarget.set(r.related_msg_id, r);
    }
  }
  const out: HandoffWithAcceptance[] = handoffs
    .sort(
      (a, b) =>
        a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id),
    )
    .map((h) => {
      const item: HandoffWithAcceptance = { record: h };
      const acc = acceptsByTarget.get(h.msg_id);
      if (acc) item.accepted_by = acc;
      return item;
    });
  if (opts.status === 'open') {
    return out.filter((x) => !x.accepted_by);
  }
  if (opts.status === 'accepted') {
    return out.filter((x) => !!x.accepted_by);
  }
  return out;
}
