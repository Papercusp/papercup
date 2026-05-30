/**
 * watermarks.ts — operator host adapter for per-agent "last-read"
 * pointers.
 *
 * A watermark is a mutable single-doc-per-agent read cursor, NOT an
 * append-only channel, so its persistence stays host-side (a whole-file
 * read-modify-write) and is deliberately NOT behind the CoordEventLog
 * seam (D-009). The value shape + pure merge/normalise come from
 * @papercusp/coordination/core.
 *
 * agent-coordination-architecture-v2 §7.2. Single writer per file (the
 * owning agent), so fs.writeFile is sufficient — no lock. Conservative:
 * the watermark is advanced at turn END, so an aborted turn re-sees the
 * same notifications (a missed notification is worse than a repeated one).
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
  emptyWatermark,
  normaliseWatermark,
  mergeWatermark,
  type Watermark,
} from '@papercusp/coordination/core';
import { watermarkFile } from './paths';

export { emptyWatermark };
export type { Watermark };

/**
 * Read an agent's watermark. A missing or malformed file is treated as
 * "never read anything" — returns an empty watermark.
 */
export async function readWatermark(ownerId: string): Promise<Watermark> {
  let buf: string;
  try {
    buf = await fs.readFile(watermarkFile(ownerId), 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyWatermark();
    throw e;
  }
  try {
    return normaliseWatermark(JSON.parse(buf) as Partial<Watermark>);
  } catch {
    // Malformed file — treat as unread rather than failing the turn.
    return emptyWatermark();
  }
}

/**
 * Merge `patch` into the agent's watermark and persist it. Omitted
 * fields keep their current value; `subscriptions_fired` is *replaced*
 * when supplied, not appended — the caller owns dedup.
 */
export async function writeWatermark(
  ownerId: string,
  patch: Partial<Watermark>,
): Promise<Watermark> {
  const current = await readWatermark(ownerId);
  const next = mergeWatermark(current, patch);
  const file = watermarkFile(ownerId);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
