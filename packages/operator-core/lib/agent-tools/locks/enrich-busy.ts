/**
 * enrichBusy — augment file-lock contention rows with the holder's declared
 * coord intent + focus. Extracted from `locks/acquire.ts` so the file-lock
 * contention formatter can be shared by BOTH `locks:acquire` and the
 * server-side `file-lock-guard` (P-013) WITHOUT the latter dragging the whole
 * `locks:acquire` tool (await/grant-bridge/events machinery) into the
 * capability:write/edit dispatch path.
 */

import { getPresence } from '../coordination/presence';
import { PLACEHOLDER_INTENT } from '../coordination/presence-payload';
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
  /** EI-10433: true when the lock's OWN stated intent and the holder's CURRENT
   *  declared coord intent are on clearly different threads AND the holder is
   *  not focused on this path — i.e. the holder acquired this lock for one task,
   *  has since declared they moved to another, and never released it. A blocked
   *  peer reads this as "likely orphaned, not actively contended" so it needn't
   *  cross-reference coord:presence by hand or wait out the full TTL. */
  holder_intent_diverged?: boolean;
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
// PLACEHOLDER_INTENT is imported from coordination/presence-payload (canonical —
// one string shared by the read-side normalization + this busy-holder detection).

/** Hook/dispatch-stamped lock intents that don't identify WHAT the holder is
 *  changing, so the lock's own intent can't be compared against the holder's
 *  declared coord intent (e.g. 'PreToolUse:Edit', 'capability:edit'). */
function isUninformativeLockIntent(intent: string): boolean {
  const s = intent.trim();
  if (!s || s === PLACEHOLDER_INTENT) return true;
  return /^(?:PreToolUse:|PostToolUse:|capability:)/i.test(s);
}

/** Work-item-ish refs (WI-4138, EI-10433, F-FIX-046, P-011, …). Extracted so a
 *  shared ref between the two intents counts as "same thread, not diverged". */
function intentRefs(s: string): string[] {
  return (s.match(/\b[a-z]{1,4}-\d[\w-]*/gi) ?? []).map((r) => r.toUpperCase());
}

function normIntent(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * EI-10433: true when the lock's OWN stated intent and the holder's CURRENT
 * declared coord intent are on clearly different threads — the "orphaned lock"
 * signal. Conservative (favours NOT flagging): an uninformative/placeholder
 * lock intent, an empty/equal holder intent, a substring relationship, or a
 * shared work-item ref all mean "not diverged".
 */
export function intentsDiverged(lockIntent: string, holderIntent: string): boolean {
  if (isUninformativeLockIntent(lockIntent)) return false;
  const a = normIntent(lockIntent);
  const b = normIntent(holderIntent);
  if (!a || !b || a === b) return false;
  if (a.includes(b) || b.includes(a)) return false; // one thread refining the other
  const [ra, rb] = [intentRefs(a), intentRefs(b)];
  if (ra.length && rb.length && ra.some((r) => rb.includes(r))) return false; // same work-item
  return true;
}

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
    // ⚠ DECLARED files ONLY — never derive this from the holder's lock holdings
    // (EI-18776963284535761). The holder holds a lock on `b.path` by definition (that is
    // why this row is contended), so a lock-derived `currentFiles` makes this term
    // CONSTANT-TRUE, the veto below always fires, and `holder_intent_diverged` can never
    // be reported again. That is the mirror image of the bug this comment came from: the
    // column used to be wiped by every coord:orient, making the term constant-FALSE and
    // the veto dead — so a live, actively-focused holder got advertised as "likely
    // orphaned". Both directions are silent. The signal only means anything while it is
    // what the holder SAID they are on, independent of what they hold.
    if (p?.currentFiles?.includes(b.path)) json.holder_focused = true;
    // EI-10433: flag a likely-orphaned lock — the holder's CURRENT declared
    // intent has moved off the lock's OWN stated intent and they aren't focused
    // on this path, so it's stale rather than actively contended.
    if (
      json.holder_intent &&
      json.holder_focused !== true &&
      intentsDiverged(b.intent, json.holder_intent)
    ) {
      json.holder_intent_diverged = true;
    }
    return json;
  });
}
