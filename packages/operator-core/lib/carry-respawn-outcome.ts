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
 * SECOND FAILURE, SAME SHAPE (P-009, fleet-lead-instrumentation-audit-2026-08-09):
 * an attempt can be PRE-EMPTED instead of refused — an internal claude re-exec or
 * a host restart takes the pending cut with it — and then NO verdict row is ever
 * written. The reader reported `pending` indefinitely and every warning here was
 * gated on `dropped`, so the one case with no evidence to quote was also the one
 * case that said nothing. {@link isOrphanedPendingRespawn} decides it from the
 * host's own stamped re-poll budget: past `capMs`, a pending attempt is not slow,
 * it is gone.
 *
 * The derivation is PURE and exported separately from the IO so it can be
 * unit-tested without a host. The row reader is the EXISTING
 * `readOwnerHostEvents` — deliberately not a second reader of the same file.
 */
import { readOwnerHostEvents, type ColdBootDrillHostEvent } from './cold-boot-drill-live';

/** Host event kinds that constitute the carry-respawn lifecycle, in the order a
 *  successful respawn emits them. Anything else in the log (wake deferrals,
 *  stale-fire drops, shutdown rows) is NOT a verdict about a respawn. */
const RESPAWN_TERMINAL_OK = new Set(['respawn-carry-delivered']);
const RESPAWN_TERMINAL_FAIL = new Set(['respawn-carry-dropped']);
/** Non-terminal: an attempt is still re-polling for an idle window. */
const RESPAWN_IN_FLIGHT = new Set(['respawn-rearm-queued', 'respawn-rearm-superseded']);

export type PriorRespawnOutcome = 'delivered' | 'dropped' | 'pending' | 'none';

export interface PriorRespawn {
  /** delivered = the successor received its continuation; dropped = it
   * terminally failed; pending = the cut or its first prompt is still awaiting
   * delivery; none = this session has no respawn history. */
  outcome: PriorRespawnOutcome;
  /** The host's own reason string on a drop (busy-gate-expired / carry-stale /
   *  superseded / rearm-error), when it recorded one. */
  reason?: string;
  /** ISO timestamp of the deciding row. */
  ts?: string;
  /** How long ago that row was written, ms (null when the row carried no ts). */
  ageMs?: number | null;
  /** The re-poll budget the host stamped on the deciding row (`capMs`), when it
   *  recorded one — the window after which a `pending` attempt CANNOT still be
   *  legitimately in flight. Read from the row rather than assumed, so the
   *  orphan verdict tracks the host's own configured cap instead of a copy of
   *  it that can silently drift. */
  capMs?: number | null;
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
    // A spawned process is not a delivered continuation. WI-10001066 opened a
    // fresh Codex child but dropped its first prompt minutes later. Keep that
    // interval pending until the host's native-turn verification settles it.
    // Other respawn modes remain unrelated lifecycle noise (WI-41504).
    else if (kind === 'respawned' && row.mode === 'carry-respawn') outcome = 'pending';
    else if (RESPAWN_IN_FLIGHT.has(kind)) outcome = 'pending';
    if (!outcome) continue;
    const ts = typeof row.ts === 'string' ? row.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    const capMs = typeof row.capMs === 'number' && Number.isFinite(row.capMs) ? row.capMs : null;
    return {
      outcome,
      ...(row.reason ? { reason: String(row.reason) } : {}),
      ...(ts ? { ts } : {}),
      ageMs: Number.isFinite(parsed) ? now - parsed : null,
      capMs,
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

/**
 * A lost carry-respawn older than this is history, not news. The agent has
 * demonstrably kept taking turns since, so repeating the warning every turn
 * would be noise — and a warning that is always on is one nobody reads.
 */
export const LOST_RESPAWN_AMBIENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The host's re-poll budget for a busy-gate-deferred respawn, used ONLY when the
 * deciding row carried no `capMs` of its own. Measured from a real host log
 * (su-b8422496, 2026-08-09T01:46:12Z): the first attempt caps at 180000ms and
 * the single deferred re-arm at 360000ms, so 360000 is the longest a `pending`
 * attempt can legitimately still be alive.
 */
export const PENDING_RESPAWN_DEFAULT_CAP_MS = 360_000;

/**
 * Slack added to the cap before a `pending` attempt is called ORPHANED. The cap
 * is a wait budget, not a deadline the host promises to write a row at, so a
 * verdict row can trail it by a clock skew / a flush. Two minutes is far larger
 * than any observed trailing gap and still an order of magnitude below the
 * multi-hour silences this exists to catch.
 */
export const PENDING_RESPAWN_ORPHAN_GRACE_MS = 120_000;

/**
 * PURE: is this `pending` attempt provably ORPHANED — i.e. past the window in
 * which it could still fire, with no terminal row ever written?
 *
 * WHY THIS IS DECIDABLE AT ALL, and why it is the P-009 signal. While a respawn
 * is genuinely pending the host DEFERS the agent's wakes
 * (`wake-turn-deferred-for-pending-respawn`), so a live agent reading this is
 * already evidence the attempt is not holding its slot. The cap turns that into
 * proof rather than a hunch: past `capMs + grace` the re-poll loop is over, and
 * a respawn that neither delivered nor dropped inside it is one nobody is
 * waiting for. The failure mode it names (P-009) is a `session:request-compaction`
 * ACKED with `respawn:true` whose cut was then pre-empted — an internal claude
 * re-exec, a host restart — leaving the attempt pending forever. `dropped` at
 * least got a verdict row; this one gets silence, which is why it needed its own
 * predicate rather than more prose on the drop path.
 *
 * An unknown age is NOT orphaned: the same evidence-only rule the ambient line
 * follows everywhere else.
 */
export function isOrphanedPendingRespawn(prior: PriorRespawn | null | undefined): boolean {
  if (!prior || prior.outcome !== 'pending') return false;
  if (prior.ageMs == null || !Number.isFinite(prior.ageMs)) return false;
  const cap =
    typeof prior.capMs === 'number' && Number.isFinite(prior.capMs) && prior.capMs > 0
      ? prior.capMs
      : PENDING_RESPAWN_DEFAULT_CAP_MS;
  return prior.ageMs > cap + PENDING_RESPAWN_ORPHAN_GRACE_MS;
}

/**
 * The AMBIENT warning line, for the per-turn coord injection block
 * (EI-19326331501849713, owner-directed 2026-08-09).
 *
 * WHY THIS IS SEPARATE FROM {@link priorRespawnNote}. That note rides the
 * `session:request-compaction` REPLY, so it is only ever read by an agent that
 * calls the tool AGAIN — and the whole failure mode is that a dropped respawn
 * gives you no reason to call again. You are told "queued", you correctly settle,
 * and you learn nothing. Measured on session bd819348 (2026-08-09): the owner
 * experienced this as "the successor got an error", when in fact no successor
 * existed and no error was ever raised.
 *
 * So this line answers the question the reply cannot: it reaches the agent on the
 * next TURN rather than the next REQUEST. Wording is deliberately concrete about
 * the observable — if your transcript is still intact, the cut did not happen —
 * because the failure is otherwise indistinguishable from a successful respawn
 * whose successor simply looks like you.
 *
 * PURE. Returns null unless the last respawn was LOST within
 * {@link LOST_RESPAWN_AMBIENT_MAX_AGE_MS} — either terminally DROPPED, or
 * ORPHANED while pending ({@link isOrphanedPendingRespawn}, the P-009 case).
 * `delivered`, `none`, a still-live `pending`, and a loss of unknown age are all
 * silent (a warning is only ever emitted on evidence — the same rule
 * {@link priorRespawnNote} follows).
 */
export function lostRespawnAmbientLine(
  prior: PriorRespawn | null | undefined,
  opts: { maxAgeMs?: number } = {},
): string | null {
  if (!prior) return null;
  const orphaned = isOrphanedPendingRespawn(prior);
  if (prior.outcome !== 'dropped' && !orphaned) return null;
  const maxAge = opts.maxAgeMs ?? LOST_RESPAWN_AMBIENT_MAX_AGE_MS;
  // An unknown age is NOT treated as recent: `ageMs` is null when the host row
  // carried no parseable timestamp, and guessing "recent" there would nag
  // forever on exactly the rows we know least about.
  if (prior.ageMs == null || !Number.isFinite(prior.ageMs) || prior.ageMs > maxAge) return null;
  // The two losses differ in what the host KNOWS, so they must not read alike: a
  // drop has a verdict you can quote back, an orphan has none — and telling an
  // agent the host "recorded" something it never recorded is the manufactured
  // certainty this whole module exists to remove.
  const head = orphaned
    ? `⚠ carry-respawn ORPHANED ${humanAge(prior.ageMs)}` +
      ` — your last session:request-compaction was acknowledged and the host queued a re-poll` +
      `${prior.reason ? ` (${prior.reason})` : ''}, then NEVER recorded an outcome. That re-poll window` +
      ` (${Math.round((prior.capMs ?? PENDING_RESPAWN_DEFAULT_CAP_MS) / 1000)}s) has long expired, so the` +
      ` cut is not coming — it was pre-empted (an internal claude re-exec, a host restart) rather than` +
      ` refused.`
    : `⚠ carry-respawn DROPPED ${humanAge(prior.ageMs)}` +
      `${prior.reason ? ` (reason: ${prior.reason})` : ''} — your last session:request-compaction was` +
      ` acknowledged but NEVER CUT, and no successor was spawned.`;
  return (
    `${head} You are still the same session, still` +
    ` carrying the full transcript. Do not wait for a compaction that is not coming: flush durable state` +
    ` (work_items:checkpoint / loop:checkpoint / facts:assert), then call session:request-compaction` +
    ` again at a clean stopping point — and note the cut only lands once your pty goes quiet, so an` +
    ` interactive back-and-forth can supersede it indefinitely.`
  );
}

function humanAge(ageMs: number | null | undefined): string {
  if (ageMs == null || !Number.isFinite(ageMs)) return 'unknown age';
  // Sub-minute is decided on the raw value, not a rounded one: Math.round would
  // render 30s as "1m ago", which is a small lie in the direction of making a
  // just-now failure look older than it is.
  if (ageMs < 60_000) return 'just now';
  const min = Math.round(ageMs / 60_000);
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
    // An orphaned attempt is NOT "still re-polling", and saying so would tell the
    // caller their new request is being adopted by a loop that no longer exists.
    if (isOrphanedPendingRespawn(prior)) {
      return (
        ` ⚠ prior-respawn-ORPHANED: an earlier carry-respawn on this session was queued` +
        ` ${humanAge(prior.ageMs)} (host recorded \`${prior.reason ? `${prior.reason}` : 'respawn-rearm-queued'}\`)` +
        ` and NEVER produced an outcome — no delivered row, no dropped row. Its re-poll window` +
        ` (${Math.round((prior.capMs ?? PENDING_RESPAWN_DEFAULT_CAP_MS) / 1000)}s) expired long ago, so that` +
        ` attempt was pre-empted rather than refused (an internal claude re-exec or a host restart drops the` +
        ` pending cut with no verdict). This request does NOT inherit it — it is a fresh attempt, and the` +
        ` same pre-emption can take this one too, so keep flushing state durably rather than relying on the carry.`
      );
    }
    return (
      ` ⚠ prior-respawn-STILL-PENDING: an earlier carry-respawn on this session is still re-polling for` +
      ` an idle window (host recorded \`${prior.reason ? `${prior.reason}` : 'respawn-rearm-queued'}\`` +
      ` ${humanAge(prior.ageMs)}). This request SUPERSEDES it — the in-flight re-poll adopts this newer` +
      ` carry document — but the cut still only fires once your pty actually goes quiet.`
    );
  }
  return '';
}
