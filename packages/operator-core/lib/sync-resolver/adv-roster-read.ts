/**
 * adv-roster-read.ts — the Sessions roster snapshot, BOUNDED and GUARDABLE (WI-39825).
 *
 * ## Why this is its own module and not still inline in the resolver
 *
 * The compute used to live inside `sync-resolver/index.ts`'s `advRoster.list`
 * resolver. Bounding it there is possible — and it WAS bounded there first, in
 * place. Guarding the bound there is not, and an unfalsifiable guard is the
 * thing this whole class of work exists to avoid: the in-place version shipped
 * with zero tests asserting that the deadline fires, which is indistinguishable
 * from a deadline that never fires.
 *
 * A resolver's only input is its wire `argsSchema`. To prove a deadline fires
 * you have to MOVE it, and the only way to move it through a resolver is to put
 * a `budgetMs` knob into the CLIENT CONTRACT — a private test lever shipped to
 * every caller. The alternative, leaving the budget hardcoded at
 * {@link ROSTER_READ_BUDGET_MS} and genuinely waiting it out, costs 6s per test
 * case, blows vitest's 5s default, and produces the kind of slow suite somebody
 * eventually deletes.
 *
 * Extraction dissolves both problems, and it is the seam this repo already
 * chose: `learning-observations-read.ts`, `learning-gym-read.ts`,
 * `learning-frontier-read.ts`, `learning-retain-read.ts` and
 * `learning-scout-read.ts` are all this shape. `opts.budgetMs` is a FUNCTION
 * parameter here, never a wire field, so a guard can shrink the budget to
 * milliseconds while the shipped contract is unchanged.
 *
 * ## What the bound actually fixes
 *
 * Four store legs fan out under one `Promise.all`, and before WI-39825 they had
 * neither a deadline nor a catch. `Promise.all` waits for the slowest, so ONE
 * wedged read took the whole roster past the sync layer's
 * `RESOLVER_READ_TIMEOUT_MS` ceiling and the Sessions view rendered nothing —
 * which is what "the roster spins forever" looks like from the outside. This is
 * a POLLED query behind the header pill and the Agents tile, so a single wedged
 * leg is not a one-off 500; it is every poll, for as long as the store is slow.
 *
 * The legs are NOT equal, so they do not degrade equally:
 *
 *   - `active` (`mergeRosterWithAssignments`) IS the roster. A snapshot without
 *     it is not a degraded roster, it is a wrong one — an empty fleet reads as
 *     "nothing is running", the single most misleading thing this view can say.
 *     So a lapse PROPAGATES, exactly as a throw from that reader does today.
 *     The gain is a fast, LABELLED failure at the budget instead of a hang.
 *   - `ended` / `pending` / `starting` are supplementary sections that render
 *     empty perfectly well. Their lapse costs its own section and nothing else.
 *
 * ## Why a lapsed supplementary leg is NAMED rather than swallowed
 *
 * The in-place version used a bare `.catch(() => [])`. That keeps the roster
 * shipping — the important half — but makes a wedged leg invisible: an empty
 * `ended` list is indistinguishable from "no sessions have ended", and an empty
 * `starting` from "nothing is booting", which is precisely the calm-and-empty
 * failure the `degradedFields` channel exists to prevent. Each casualty is now
 * recorded as a shared {@link DegradedField} beside the intact data, and the
 * array is OMITTED entirely when every leg succeeds — so a healthy payload is
 * byte-identical to what it was before, and its presence is the signal.
 *
 * On the kind: a lapse classifies as `read-failed`, not a new `timed-out`
 * member. `UnavailableKind` is a shared union consumed by client guards; adding
 * a member to say what the verbatim reason (`<label> exceeded the read budget`)
 * already says would strand those consumers for no information gain.
 */

import { classifyReadFailure, type DegradedField } from './degraded-snapshot';
import { createReadDeadline } from './read-deadline';

/**
 * The whole snapshot's budget, shared by every leg (see `createReadDeadline`:
 * one deadline for the fan-out, not a per-call budget). Sits under the sync
 * layer's `RESOLVER_READ_TIMEOUT_MS` ceiling so the bound can actually prevent
 * the failure it exists to prevent, and matches the gym read's budget.
 */
export const ROSTER_READ_BUDGET_MS = 6_000;

export interface ReadAdvRosterOptions {
  /** Active workspace id; `null` is the cross-workspace read, as before. */
  workspaceId?: string | null;
  /** Row cap for the ended-sessions section (the wire default is 50). */
  endedLimit?: number;
  /**
   * Deadline for the whole fan-out. A FUNCTION parameter, never a wire field —
   * it exists so the guard can prove the deadline fires without waiting
   * {@link ROSTER_READ_BUDGET_MS} out. Defaults to {@link ROSTER_READ_BUDGET_MS}.
   */
  budgetMs?: number;
}

/**
 * Read the Sessions roster: the live fleet plus the ended / pending / starting
 * sections, bounded by one shared deadline.
 *
 * Rejects only when `active` — the leg the view cannot be honest without —
 * fails or lapses. Every other failure mode returns a roster that is TRUE about
 * its intact sections and names the casualties in `degradedFields`.
 */
export async function readAdvRoster(opts: ReadAdvRosterOptions = {}) {
  const { workspaceId = null, endedLimit = 50, budgetMs = ROSTER_READ_BUDGET_MS } = opts;
  const os = await import('node:os');
  const {
    mergeRosterWithAssignments,
    dedupeEndedAgainstActive,
    pendingLaunchesToRosterEntries,
    startingLaunchesToRosterEntries,
    dedupeStartingAgainstActive,
  } = await import('../adv-roster');
  const { listEndedAdvSessions, listPendingWorkbenchLaunches, listStartingTerminalLaunches } =
    await import('../adv-sessions');

  const degradedFields: DegradedField[] = [];
  /** Note a supplementary leg's failure instead of swallowing it into `[]`. */
  const noteDegraded = (field: string, err: unknown): never[] => {
    const { kind, reason } = classifyReadFailure(err);
    console.warn(`[advRoster.list] ${field} read failed:`, reason);
    degradedFields.push({ field, kind, reason });
    return [];
  };

  const withinBudget = createReadDeadline(budgetMs);
  const [{ active, orphanedClaims }, endedAll, pendingRows, startingRows] = await Promise.all([
    // PRIMARY: a lapse propagates, as a throw from this reader does today.
    withinBudget(mergeRosterWithAssignments({ workspaceId }), 'roster active'),
    withinBudget(listEndedAdvSessions({ workspaceId, limit: endedLimit }), 'roster ended').catch(
      (err) => noteDegraded('ended', err),
    ),
    withinBudget(listPendingWorkbenchLaunches({ workspaceId }), 'roster pending').catch((err) =>
      noteDegraded('pending', err),
    ),
    withinBudget(listStartingTerminalLaunches({ workspaceId }), 'roster starting').catch((err) =>
      noteDegraded('starting', err),
    ),
  ]);

  const host = os.hostname();
  return {
    active,
    ended: dedupeEndedAgainstActive(endedAll, active),
    orphanedClaims,
    pending: pendingLaunchesToRosterEntries(pendingRows, host),
    // WI-6376: terminal-spawned launches inside their boot window, minus any
    // that already came online (presence wins — see the dedupe's doc).
    starting: dedupeStartingAgainstActive(
      startingLaunchesToRosterEntries(startingRows, host),
      active,
    ),
    // Omitted entirely when every leg succeeded, so a healthy roster stays
    // byte-identical to what it was before the bound — the flag's PRESENCE is
    // the signal, exactly as `unavailable` is for a whole-snapshot fault.
    ...(degradedFields.length > 0 ? { degradedFields } : {}),
  };
}
