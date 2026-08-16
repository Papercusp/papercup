/**
 * The host seam that gives `goals:update { status }` real teeth — in BOTH directions.
 *
 * Stop (`paused` | `killed`) and resume (`active`) share ONE executor and one install
 * point. They were split for a while and only the stop half existed, which is exactly
 * how the resume no-op (WI-37615) survived: a `status:'active'` write moved the label,
 * left placement gated and loops disarmed, and the card left the `blocked` lane with
 * nothing running behind it. One seam means there is one place to forget, not two.
 *
 * WHY A SEAM AND NOT A DIRECT CALL. The dep direction is
 * operator-core -> agent-mcp -> tooldef, so a goals tool (which lives HERE) cannot
 * reach the two things that actually halt execution — the pot placement bit
 * (`pot/started`) and the engine-loop disarm (`harness/routines/loop`) — both of
 * which live up in operator-core. operator-core installs the real executor at
 * module load; until then a goal status write behaves exactly as it did before.
 * Same shape as the `setCapabilityTierOverride` seam in capability-tiers-papercusp.
 *
 * WHY THIS EXISTS AT ALL (EI-20013729460455061). `goals:update` was a pure record
 * write: SELECT -> UPDATE -> SELECT, no wake, no stop, no fan-out. Nothing outside
 * the goals tools reads `goals.status`, so pausing or killing a goal changed a
 * label and nothing else while the fleets, loops and pots pursuing it kept running.
 * The tool's own guidance said the goals "should have their pots wound down
 * first" — i.e. the wind-down was documented as a manual prerequisite.
 *
 * THE HONESTY REQUIREMENT (EI-19995648221353323). The measured failure one level
 * down is a stop control that REPORTS more than it does: pot pause is a placement
 * gate, not a throttle — it gates new Mug placements and exerts zero backpressure
 * on sessions already alive with armed self-wake loops. Measured 2026-08-09, a pot
 * read "paused, maxBees 1" while 73 distinct owners ran it at 8-13k calls/hour and
 * drained the account pool to exhaustion. So the report this seam returns MUST
 * distinguish what was actually stopped from what is still running and merely
 * un-attributable — see `unattributedActiveLoops`. A stop control that lets its
 * caller read "paused" as "burn stopped" is the bug, not the fix.
 */
let executor;
/**
 * Install (or clear, with `undefined`) the host executor. Called once by
 * operator-core at module load. Idempotent — a re-install replaces.
 *
 * ONE executor covers stop AND resume rather than two parallel seams: they are two
 * directions of a single question ("what happens when a goal's status moves"), and a
 * second seam would be a second install point to forget — which is precisely the
 * failure mode this seam already exists to guard against.
 */
export function setGoalTransitionExecutor(fn) {
    executor = fn;
}
/** The installed executor, or undefined when the host has not wired one. */
export function getGoalTransitionExecutor() {
    return executor;
}
/**
 * The one membership list. Every guard below reads it rather than repeating the
 * literals, so adding a status is a single edit and the guards CANNOT disagree with
 * each other — the drift that let `achieved` be a first-class member of
 * `GOAL_STATUSES` while being invisible to this seam (WI-37832).
 */
export const STOPPING_STATUSES = ['paused', 'killed', 'achieved'];
/** A goal status that triggers the stop fan-out. */
export function isStoppingStatus(status) {
    return STOPPING_STATUSES.includes(status);
}
/**
 * The stopping statuses that are also TERMINAL — the goal is over, not merely
 * suspended. A strict subset of {@link STOPPING_STATUSES}, and the distinction is
 * load-bearing: `paused` gates placement and disarms loops but must KEEP the
 * GOAL-mode rows, because `executeGoalResume` reads exactly those rows as its
 * attribution index. Clear them on a pause and resume can no longer name the
 * sessions it is reporting on (WI-37834).
 */
export const TERMINAL_STATUSES = ['killed', 'achieved'];
/** A stopping status after which the goal is OVER, not merely suspended. */
export function isTerminalStatus(status) {
    return TERMINAL_STATUSES.includes(status);
}
/** A goal status that triggers the resume fan-out (WI-37615). */
export function isResumingStatus(status) {
    return status === 'active';
}
/** Any status that fans out at all — the union of the two above. */
export function isTransitioningStatus(status) {
    return isStoppingStatus(status) || isResumingStatus(status);
}
/** Narrow a transition report to the stop arm. */
export function isStopReport(r) {
    return isStoppingStatus(r.status);
}
