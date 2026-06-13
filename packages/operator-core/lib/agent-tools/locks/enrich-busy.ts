/**
 * enrichBusy — augment file-lock contention rows with the holder's declared
 * coord intent + focus. Extracted from `locks/acquire.ts` so the file-lock
 * contention formatter can be shared by BOTH `locks:acquire` and the
 * server-side `file-lock-guard` (P-013) WITHOUT the latter dragging the whole
 * `locks:acquire` tool (await/grant-bridge/events machinery) into the
 * capability:write/edit dispatch path.
 */

import { getPresence } from '../coordination/presence';
import type { AcquireBusy } from './su-lock-store';

export interface BusyJson {
  path: string;
  /** Canonical owner id of the holder (#5 — unredacted; SU is admin-tier). */
  owner: string;
  owner_label: string | null;
  intent: string;
  expires_ts: string;
  /** Holder's DECLARED coord intent (coord:declare-intent → presence), when
   *  meaningful. The lock's own `intent` is uninformative for the common
   *  hook-acquired edit lock ('PreToolUse:Edit' / 'capability:write'); this
   *  answers "what are they changing?" for a blocked peer. */
  holder_intent?: string;
  /** True when the holder declared THIS path among their current_files. */
  holder_focused?: boolean;
}

export function busyToJson(b: AcquireBusy): BusyJson {
  return {
    path: b.path,
    owner: b.owner,
    owner_label: b.owner_label,
    intent: b.intent,
    expires_ts: b.expires_ts.toISOString(),
  };
}

/** The OMP turn-start hook heartbeats this exact intent every turn, so treat it
 *  as "nothing meaningful declared" rather than surfacing it. */
const PLACEHOLDER_INTENT = '(active — see coord:presence for current work)';

/**
 * Enrich busy rows with the holder's declared coord intent (presence).
 * Best-effort: a presence miss just leaves the row unenriched. One getPresence
 * per DISTINCT holder, and only on contention, so the cost is paid rarely.
 */
export async function enrichBusy(rows: AcquireBusy[]): Promise<BusyJson[]> {
  const owners = [...new Set(rows.map((r) => r.owner))];
  const byOwner = new Map<string, Awaited<ReturnType<typeof getPresence>>>();
  await Promise.all(
    owners.map(async (o) => {
      byOwner.set(o, await getPresence(o).catch(() => null));
    }),
  );
  return rows.map((b) => {
    const json = busyToJson(b);
    const p = byOwner.get(b.owner) ?? null;
    const intent = p?.intent?.trim();
    if (intent && intent !== PLACEHOLDER_INTENT) json.holder_intent = intent;
    if (p?.currentFiles?.includes(b.path)) json.holder_focused = true;
    return json;
  });
}
