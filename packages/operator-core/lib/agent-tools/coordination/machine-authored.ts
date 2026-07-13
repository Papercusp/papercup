/**
 * machine-authored.ts — is a coord message MACHINE-authored? (WI-4537)
 *
 * WHY THIS EXISTS: `unanswered` / `unanswered_directed` (unanswered-directed.ts) is wired to
 * PREEMPT an agent's work — "a directed message awaiting YOUR answer OUTRANKS your own work".
 * A counter with that much authority must fire on messages a PEER is actually waiting on, and
 * on nothing else. Measured live before this fix, it fired on robot chatter: of 2791 unanswered
 * directed messages fleet-wide, ~490 came from synthetic senders that cannot read a reply —
 * `claim-discipline-watch` (390), `plan-clobber-watch` (47), `system:delivery-ladder` (29),
 * `system:claim-integrity-monitor` (10), … — none of which any agent will ever "answer".
 *
 * THE FLAG WAS ALREADY THERE AND UNDER-STAMPED. `extra: { auto: true }` marks a machine
 * lifecycle message, and some emitters set it (314 of the rows did) — but MOST machine senders
 * simply never bothered, so filtering on the flag alone would have missed the majority of the
 * noise (~490 unflagged vs ~314 flagged). Chasing every emitter and adding the flag by hand is
 * exactly the fix that rots: the next watchdog anyone adds forgets it again.
 *
 * SO THE ROOT FIX IS AT THE ONE CHOKEPOINT: `sendMessage` auto-stamps `auto: true` whenever the
 * SENDER is a machine identity (see messages.ts). Every current AND future system emitter is
 * flagged for free, and the flag becomes trustworthy. This module is the single source of truth
 * for "is this sender a machine", shared by:
 *   - sendMessage       (JS — stamps the flag at write time), and
 *   - unanswered-directed's SQL (the SAME pattern — a BACKSTOP that also excludes the millions
 *     of HISTORICAL rows already written without the stamp, which no write-time fix can reach).
 * One pattern, two call sites, so they can never drift.
 *
 * DELIBERATELY NOT MACHINE — the false positives that would matter most:
 *   - `pc-admin-coord-ui` — the HUMAN owner typing in the admin coord UI. Silencing that would
 *     hide the one sender whose message most deserves to preempt an agent.
 *   - `human`, agent sessions (`su-…`, `s-…`, `role-…`, bare uuids) — real correspondents.
 */

/**
 * POSIX-ERE (Postgres `~`) AND JS-compatible. Kept to the intersection of both dialects on
 * purpose: it is embedded verbatim in SQL and compiled verbatim in JS, so a pattern that only
 * one engine understands would silently make the two call sites disagree.
 *
 *   ^system[:-]                     system:delivery-ladder, system-watchdog, system:allhive-…
 *   -(watch|watchdog|sweep|monitor|digest|reaper|ladder)$
 *                                   claim-discipline-watch, plan-clobber-watch,
 *                                   stale-claim-sweep, hold-open-sweep, …-monitor, …-digest
 *   ^work-items$                    the work-item lifecycle event emitter ([event] work-item:done:…)
 */
export const MACHINE_SENDER_PATTERN =
  '^system[:-]|-(watch|watchdog|sweep|monitor|digest|reaper|ladder)$|^work-items$';

const MACHINE_SENDER_RE = new RegExp(MACHINE_SENDER_PATTERN);

/**
 * Is `from` a synthetic/system identity — i.e. something that emits but can never READ a reply?
 * Conservative by design: anything unrecognised is treated as a real correspondent, because the
 * cost of a false NEGATIVE (one extra robot line in a count) is trivial next to a false POSITIVE
 * (silently suppressing a peer's — or the owner's — real question).
 */
export function isMachineAuthoredSender(from: string | null | undefined): boolean {
  if (!from) return false;
  return MACHINE_SENDER_RE.test(from.trim().toLowerCase());
}
