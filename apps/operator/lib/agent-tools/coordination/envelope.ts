/**
 * envelope.ts — the typed line shape every coord/*.jsonl file written
 * by the new coordination tools shares.
 *
 * agent-coordination-architecture-v2 §6.2 / §6.3. This envelope
 * applies to NEW coord files only — the legacy rust-port `coord/*.jsonl`
 * lines (different schema: `kind` vs `action`) are out of scope and
 * are not parsed by this module.
 *
 * Append discipline (§6.2): each *.jsonl file has exactly one writer
 * (the per-agent outbox is the agent itself; plan-events.jsonl has
 * the operator route). With one writer there is no contention and
 * `fs.appendFile` is sufficient — no lock needed.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type CoordKind =
  | 'message'
  | 'ack'
  | 'subscribe'
  | 'unsubscribe'
  | 'notify'
  | 'handoff'
  | 'handoff_accepted'
  | 'escalation'
  | 'escalation_resolved'
  | 'contract'
  | 'plan_event';

export interface CoordEnvelope {
  /** ISO-8601 UTC. */
  ts: string;
  /** Time-prefixed unique id; sortable lexicographically. */
  msg_id: string;
  /** AgentIdentity.ownerId of the writer. */
  from: string;
  /** Recipients. ['*'] = broadcast; ownerIds otherwise; ['human'] = surface to the user. */
  to: string[];
  kind: CoordKind;
  summary?: string;
  body?: string;
  files?: string[];
  /** Head SHA at write time. */
  commit?: string;
  plan_slug?: string;
  /** For acks / replies / resolutions — points at the originating msg_id. */
  related_msg_id?: string;
  /** Kind-specific extras (e.g. subscribe.pattern, escalation.options). */
  [key: string]: unknown;
}

/**
 * Generate a coord msg_id. Format: `<ms-base36>-<seq-base36>-<hex>` —
 * lex-monotonic by construction within one process even across
 * multiple ids minted in the same millisecond, so a downstream sort
 * by (ts, msg_id) is deterministic.
 *
 * v1 deviation from plan: the plan says "ULID". This uses a process-
 * local counter + UUIDv4 suffix instead of a real ULID encoder. The
 * field name is stable; future code can switch encoders without
 * changing readers.
 */
let _lastMs = 0;
let _seq = 0;
export function newMsgId(): string {
  const now = Date.now();
  if (now === _lastMs) {
    _seq += 1;
  } else {
    _lastMs = now;
    _seq = 0;
  }
  const ms = now.toString(36).padStart(8, '0');
  const seq = _seq.toString(36).padStart(4, '0');
  const rnd = randomUUID().replace(/-/g, '');
  return `${ms}-${seq}-${rnd}`;
}

/**
 * Append a typed envelope to a coord file. Creates the parent
 * directory lazily. Caller's responsibility: only call from the file's
 * one writer (e.g. the agent's own outbox).
 */
export async function appendCoordLine(
  filepath: string,
  envelope: CoordEnvelope,
): Promise<void> {
  await fs.mkdir(dirname(filepath), { recursive: true });
  const line = JSON.stringify(envelope) + '\n';
  await fs.appendFile(filepath, line, 'utf8');
}

/**
 * Read all envelopes from a coord file. Malformed lines are skipped
 * (the reader is forgiving). Missing file returns []. Order: file
 * order = write order = time order (per-writer monotonic).
 */
export async function readCoordFile(
  filepath: string,
): Promise<CoordEnvelope[]> {
  let buf: string;
  try {
    buf = await fs.readFile(filepath, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const out: CoordEnvelope[] = [];
  for (const ln of buf.split('\n')) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') out.push(obj as CoordEnvelope);
    } catch {
      // Skip malformed lines. Logged at the call site if needed.
    }
  }
  return out;
}
