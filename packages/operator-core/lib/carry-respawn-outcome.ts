/**
 * carry-respawn-outcome — read back what ACTUALLY happened to this session's
 * last carry-respawn, so `session:request-compaction` can report the EFFECT
 * instead of only the acknowledgement (EI-19480099650947832).
 *
 * WHY THIS EXISTS. `session:request-compaction` returns `respawn: true` when the
 * socket write to the psu-pty host succeeded. That is a statement about a
 * REQUEST being accepted, not about a cut occurring — and the two genuinely
 * diverge. The host's carry-respawn has to win a busy-gate: it waits for the
 * agent's pty to go quiet for OUTPUT_QUIET_MS, re-polls across successive
 * windows, and can still end in `respawn-carry-dropped` (busy-gate-expired /
 * carry-stale / superseded / rearm-error). Every one of those outcomes is
 * written to the per-owner host event log — a JSONL file that, until this
 * module, NO tool read. So the failure mode is silent in the worst possible
 * direction: the caller is told the cut is queued, correctly stops working, and
 * keeps accumulating context past its ceiling until a FORCE compaction seizes a
 * turn mid-thought — which is precisely what self-compaction exists to prevent.
 *
 * Measured 2026-08-04 on session su-4a6e2255-… (the filing that commissioned
 * this): `respawn-rearm-queued` at 00:28:00 → the re-poll ran fruitlessly for
 * 14+ minutes → a second request-compaction was terminally dropped at 00:38:29,
 * and the agent learned none of it.
 *
 * The derivation is PURE and exported separately from the IO so it can be
 * unit-tested without a host. The row reader is the EXISTING
 * `readOwnerHostEvents` — deliberately not a second reader of the same file.
 */
import { readOwnerHostEvents, type ColdBootDrillHostEvent } from './cold-boot-drill-live';

/** Host event kinds that constitute the carry-respawn lifecycle, in the order a
 *  successful respawn emits them. Anything else in the log (wake deferrals,
 *  stale-fire drops, shutdown rows) is NOT a verdict about a respawn. */
const RESPAWN_TERMINAL_OK = new Set(['respawned', 'respawn-carry-delivered']);
const RESPAWN_TERMINAL_FAIL = new Set(['respawn-carry-dropped']);
/** Non-terminal: an attempt is still re-polling for an idle window. */
const RESPAWN_IN_FLIGHT = new Set(['respawn-rearm-queued', 'respawn-rearm-superseded']);

export type PriorRespawnOutcome = 'delivered' | 'dropped' | 'pending' | 'none';

export interface PriorRespawn {
  /** delivered = a cut actually fired; dropped = it terminally failed; pending =
   *  an attempt is still re-polling; none = this session has no respawn history. */
  outcome: PriorRespawnOutcome;
  /** The host's own reason string on a drop (busy-gate-expired / carry-stale /
   *  superseded / rearm-error), when it recorded one. */
  reason?: string;
  /** ISO timestamp of the deciding row. */
  ts?: string;
  /** How long ago that row was written, ms (null when the row carried no ts). */
  ageMs?: number | null;
}

/**
 * PURE: given this owner's host event rows (oldest→newest, as the log is
 * appended), decide what happened to the MOST RECENT carry-respawn.
 *
 * Newest-first scan, first lifecycle row wins — so a `respawn-carry-delivered`
 * that followed a `respawn-carry-dropped` correctly reports `delivered`, and a
 * `dropped` verdict means no respawn has succeeded since it, however old it is.
 */
export function deriveLastRespawnOutcome(
  rows: ColdBootDrillHostEvent[],
  opts: { now?: number } = {},
): PriorRespawn {
  const now = opts.now ?? Date.now();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const kind = String(row?.kind ?? '');
    if (!kind) continue;
    let outcome: PriorRespawnOutcome | null = null;
    if (RESPAWN_TERMINAL_FAIL.has(kind)) outcome = 'dropped';
    else if (RESPAWN_TERMINAL_OK.has(kind)) outcome = 'delivered';
    else if (RESPAWN_IN_FLIGHT.has(kind)) outcome = 'pending';
    if (!outcome) continue;
    const ts = typeof row.ts === 'string' ? row.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    return {
      outcome,
      ...(row.reason ? { reason: String(row.reason) } : {}),
      ...(ts ? { ts } : {}),
      ageMs: Number.isFinite(parsed) ? now - parsed : null,
    };
  }
  return { outcome: 'none' };
}

/** IO wrapper: read this owner's host event log and derive the verdict. Never
 *  throws — an unreadable/absent log is reported as `none`, exactly like a
 *  session that has never respawned. */
export async function readPriorRespawnOutcome(
  ownerId: string,
  opts: { dir?: string; now?: number } = {},
): Promise<PriorRespawn> {
  try {
    const rows = opts.dir ? await readOwnerHostEvents(ownerId, opts.dir) : await readOwnerHostEvents(ownerId);
    return deriveLastRespawnOutcome(rows, { now: opts.now });
  } catch {
    return { outcome: 'none' };
  }
}

function humanAge(ageMs: number | null | undefined): string {
  if (ageMs == null || !Number.isFinite(ageMs)) return 'unknown age';
  const min = Math.round(ageMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 90) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

/**
 * The note fragment `session:request-compaction` appends when this session's
 * PREVIOUS carry-respawn did not land. Empty string when the last respawn
 * delivered, when there is no history, or when the outcome cannot be decided —
 * a warning is only ever emitted on evidence.
 */
export function priorRespawnNote(prior: PriorRespawn | null | undefined): string {
  if (!prior) return '';
  if (prior.outcome === 'dropped') {
    return (
      ` ⚠ prior-respawn-DROPPED: your PREVIOUS carry-respawn on this session never cut —` +
      ` the host recorded \`respawn-carry-dropped\`${prior.reason ? ` (reason: ${prior.reason})` : ''}` +
      ` ${humanAge(prior.ageMs)}. An acknowledged request is NOT a landed cut: the host still has to` +
      ` win a busy-gate (your pty must go quiet), and it can give up. So do NOT assume this one lands —` +
      ` if your next turn still has your full transcript, the cut did not happen; keep flushing state` +
      ` durably (work_items:checkpoint / loop:checkpoint) rather than relying on the carry.`
    );
  }
  if (prior.outcome === 'pending') {
    return (
      ` ⚠ prior-respawn-STILL-PENDING: an earlier carry-respawn on this session is still re-polling for` +
      ` an idle window (host recorded \`${prior.reason ? `${prior.reason}` : 'respawn-rearm-queued'}\`` +
      ` ${humanAge(prior.ageMs)}). This request SUPERSEDES it — the in-flight re-poll adopts this newer` +
      ` carry document — but the cut still only fires once your pty actually goes quiet.`
    );
  }
  return '';
}
