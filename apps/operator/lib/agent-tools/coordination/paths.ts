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
