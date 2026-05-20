/**
 * Resolve the coord/ directory — the L3 channel substrate root.
 *
 * agent-coordination-architecture-v2 §6.1 puts coord/ at the repo
 * root. At runtime we resolve it in this order:
 *
 *   1. PAPERCUSP_COORD_DIR env var — explicit override; used by tests
 *      and unusual deployments.
 *   2. Nearest ancestor of process.cwd() containing a .git directory
 *      (defensible "repo root").
 *   3. process.cwd() as the last-resort fallback.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function findRepoRoot(start: string = process.cwd()): string {
  let cur = resolve(start);
  // 24 levels is far more than any realistic checkout depth.
  for (let i = 0; i < 24; i++) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

export function coordDir(): string {
  const env = process.env.PAPERCUSP_COORD_DIR;
  if (env && env.length > 0) return env;
  return join(findRepoRoot(), 'coord');
}

export function messagesDir(): string {
  return join(coordDir(), 'messages');
}

export function escalationsDir(): string {
  return join(coordDir(), 'escalations');
}

export function handoffsDir(): string {
  return join(coordDir(), 'handoffs');
}

export function subscriptionsDir(): string {
  return join(coordDir(), 'subscriptions');
}

export function subscriptionsFile(ownerId: string): string {
  const safe = ownerId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(subscriptionsDir(), `${safe}.jsonl`);
}

/**
 * Per-agent outbox filename. ownerId is sanitised — non-[A-Za-z0-9._-]
 * chars become '_'. Two distinct owners cannot collide because the
 * filename includes the (full) ownerId; sanitisation just makes the
 * filename POSIX-safe.
 */
export function outboxFile(ownerId: string): string {
  const safe = ownerId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(messagesDir(), `${safe}.jsonl`);
}

/**
 * Per-event filename for an escalation / handoff record. msg_id is
 * already time-sortable (`<base36-ms>-<hex>`); using it directly as
 * the filename gives sortable directory listings and O(1) lookup by
 * id (no parse-every-file scan needed).
 */
export function escalationFile(msgId: string): string {
  return join(escalationsDir(), `${sanitiseMsgId(msgId)}.json`);
}

export function handoffFile(msgId: string): string {
  return join(handoffsDir(), `${sanitiseMsgId(msgId)}.json`);
}

function sanitiseMsgId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}
