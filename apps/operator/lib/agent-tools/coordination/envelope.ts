/**
 * envelope.ts — operator-side re-export of the coordination envelope
 * vocabulary, now owned by @papercusp/coordination/core (P-011).
 *
 * `CoordKind` / `CoordEnvelope` / `newMsgId` come from the package. The
 * two generic file-line primitives (`appendCoordLine` / `readCoordFile`)
 * stay here because the host-side surfaces that DON'T go through the
 * CoordEventLog seam — subscriptions (stays host-side per the locks
 * agreement) and the /api/coord raw-file reader — use them directly on
 * arbitrary paths. The extracted channels (messages/handoffs/
 * escalations/plan-events) use the `coordLog` seam instead (see log.ts).
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export {
  type CoordKind,
  type CoordEnvelope,
  newMsgId,
} from '@papercusp/coordination/core';
import type { CoordEnvelope } from '@papercusp/coordination/core';

/**
 * Append a typed envelope to a coord file. Creates the parent directory
 * lazily. Caller's responsibility: only call from the file's one writer.
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
 * Read all envelopes from a coord file. Malformed lines are skipped.
 * Missing file returns []. Order: file order = write order = time order.
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
      // Skip malformed lines.
    }
  }
  return out;
}
