/**
 * messages.ts — the L3 message + ack substrate.
 *
 * agent-coordination-architecture-v2 §6.4 (#6). One outbox per sender
 * at coord/messages/<ownerId>.jsonl; the inbox is the union scan of
 * every outbox, filtered by `to.includes(me) || to.includes('*')`.
 *
 * Per-sender outbox = exactly one writer per file = no contention,
 * no locking needed (envelope.ts handles the append).
 *
 * Acks: the acker appends an `ack` entry to its OWN outbox (with
 * `related_msg_id` pointing at the original message). This keeps the
 * single-writer-per-file invariant and lets the thread be
 * reconstructed by scanning + traversing related_msg_id.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { messagesDir, outboxFile } from './paths';
import {
  appendCoordLine,
  newMsgId,
  readCoordFile,
  type CoordEnvelope,
  type CoordKind,
} from './envelope';
import type { AgentIdentity } from './identity';

/** Options for sendMessage / generalised coord append. */
export interface SendOptions {
  /** Recipient ownerIds. Use ['*'] for broadcast, ['human'] for the human inbox. */
  to: string[];
  summary?: string;
  body?: string;
  files?: string[];
  plan_slug?: string;
  related_msg_id?: string;
  /** Default 'message'. Use other kinds for typed channel writes
   *  (notify, escalation, etc. — coord-shared paths use this too). */
  kind?: CoordKind;
}

/** Append a new envelope to the caller's outbox. */
export async function sendMessage(
  identity: AgentIdentity,
  opts: SendOptions,
): Promise<CoordEnvelope> {
  const env: CoordEnvelope = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: opts.to,
    kind: opts.kind ?? 'message',
  };
  if (opts.summary !== undefined) env.summary = opts.summary;
  if (opts.body !== undefined) env.body = opts.body;
  if (opts.files !== undefined) env.files = opts.files;
  if (opts.plan_slug !== undefined) env.plan_slug = opts.plan_slug;
  if (opts.related_msg_id !== undefined) env.related_msg_id = opts.related_msg_id;
  await appendCoordLine(outboxFile(identity.ownerId), env);
  return env;
}

/**
 * Append an ack for `targetMsgId`, addressed back to the message's
 * sender. The acker's own outbox is the writer, preserving the
 * one-writer-per-file invariant.
 */
export async function appendAck(
  identity: AgentIdentity,
  targetMsgId: string,
  targetFrom: string,
): Promise<CoordEnvelope> {
  return sendMessage(identity, {
    to: [targetFrom],
    kind: 'ack',
    related_msg_id: targetMsgId,
  });
}

export interface InboxOptions {
  /** Only return envelopes whose ts is strictly after this ISO timestamp. */
  since_ts?: string;
  /** Filter to one or more kinds. Omit for all kinds. */
  kinds?: CoordKind[];
  /** Filter out the caller's own outbox lines (default true). */
  excludeOwn?: boolean;
}

/**
 * Read everything in coord/messages/ addressed to `ownerId` (or to '*').
 * Sorted by ts ascending. Forgiving of malformed files (skipped) and a
 * missing messages dir (returns []).
 */
export async function readInbox(
  ownerId: string,
  opts: InboxOptions = {},
): Promise<CoordEnvelope[]> {
  const dir = messagesDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const excludeOwn = opts.excludeOwn ?? true;
  const sinceMs = opts.since_ts ? new Date(opts.since_ts).getTime() : 0;
  const kindFilter = opts.kinds ? new Set<CoordKind>(opts.kinds) : null;

  const out: CoordEnvelope[] = [];
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    const lines = await readCoordFile(join(dir, f));
    for (const l of lines) {
      if (excludeOwn && l.from === ownerId) continue;
      if (!Array.isArray(l.to)) continue;
      if (!l.to.includes(ownerId) && !l.to.includes('*')) continue;
      if (sinceMs && new Date(l.ts).getTime() <= sinceMs) continue;
      if (kindFilter && !kindFilter.has(l.kind)) continue;
      out.push(l);
    }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

/**
 * Reconstruct a thread rooted at `rootMsgId`. Collects every envelope
 * connected via the `related_msg_id` chain (in either direction),
 * sorted by ts ascending.
 */
export async function readThread(rootMsgId: string): Promise<CoordEnvelope[]> {
  const dir = messagesDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const all: CoordEnvelope[] = [];
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    all.push(...(await readCoordFile(join(dir, f))));
  }
  const byId = new Map<string, CoordEnvelope>();
  for (const l of all) byId.set(l.msg_id, l);

  const inThread = new Set<string>([rootMsgId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of all) {
      const inSelf = inThread.has(l.msg_id);
      const rel = l.related_msg_id;
      const inRel = rel ? inThread.has(rel) : false;
      if (inSelf && rel && !inRel) {
        inThread.add(rel);
        changed = true;
      }
      if (!inSelf && rel && inRel) {
        inThread.add(l.msg_id);
        changed = true;
      }
    }
  }
  return all
    .filter((l) => inThread.has(l.msg_id))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}
