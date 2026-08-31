/**
 * portfolio-acts.ts — the ONE definition of "this holder PLACED something"
 * (goal-mode-drift-guards-2026-08-31 P-002).
 *
 * ── WHAT THIS ANSWERS THAT NOTHING ELSE DOES ────────────────────────────────
 *
 * `holder.ts` answers "is anybody there?". `activity.ts` folds that with the
 * goal's administrative status. `resolveGoalHolderWedge` (and its subject-
 * agnostic core in `agent-wedge.ts`) answers "has this holder EVER produced an
 * agent-origin tool call". All three read healthy for the failure that motivated
 * this module, and its own docblock says why in as many words: the wedge
 * predicate "only fires on holders that have NEVER produced an agent-origin
 * call, so this is not 'idle for 15 minutes' — it is 'has never once worked'".
 *
 * A steward that READS and REPORTS indefinitely while placing nothing passes
 * every one of them. It is alive, it is held, it has produced work, and it is
 * doing nothing that a portfolio manager exists to do. Measured: one such goal
 * ran 4+ hours and $109 before the ROLLING BUDGET CEILING — a money ceiling, the
 * last line of defence — became the first thing to notice.
 *
 * So the missing predicate is not about presence or effort. It is about the KIND
 * of call: did anything the holder did CHANGE THE PORTFOLIO?
 *
 * ── THE MEMBERSHIP RULE, STATED ONCE ────────────────────────────────────────
 *
 * A tool is a portfolio act iff a HOLDER invoking it changes WHAT WORK EXISTS or
 * WHO IS ON IT.
 *
 * Three consequences of that sentence, each of which decides real cases:
 *
 *  1. READS ARE NEVER PORTFOLIO ACTS — not `goals:list`, `plans:get`,
 *     `coord:orient`, `sessions:search`, `dev:pg_query`, `capability:read`. The
 *     condition being caught is a steward that reads and reports forever, so a
 *     definition that counted reads would be blind by construction.
 *  2. CONFIGURATION OF AN EXISTING SUBJECT IS NOT A PORTFOLIO ACT. A schema, a
 *     property, an unarmed schedule change how a thing is DESCRIBED, not what is
 *     being pursued or by whom. `goals:arm-schedule` is in, because arming is
 *     what makes future work exist; `goals:set-schedule` is out, because
 *     authoring an unarmed recurrence fires nothing.
 *  3. ENDING work counts. Killing a goal, detaching a pot and dropping an item
 *     are portfolio management. A steward whose honest judgement is "stop" has
 *     managed the portfolio; only a steward who does neither has not.
 *
 * ── ⚠ WHY THIS IS A CONSTANT AND NOT PROSE ──────────────────────────────────
 *
 * Because prose already drifted, on day one, in the direction that hurts.
 *
 * The predecessor of this list is the `portfolio-activity-floor` criterion on
 * the live `goal-mode-e2e` rubric (P-001, landed the same morning as this file).
 * It enumerates its verbs as PROSE inside a rubric criterion, and two of the
 * sixteen it names — `goals:amend` and `goals:kill` — HAVE NEVER EXISTED. There
 * is no tool by either name in the tree (verified 2026-08-31 by resolving all 16
 * against `name: '<verb>'` declarations; 14 resolved, those 2 did not). The real
 * verb for both intents is `goals:update`. So the criterion silently could not
 * see amendment or kill activity at all, and a steward whose whole contribution
 * was to amend and kill goals would have graded as measurably idle.
 *
 * That is the failure direction that matters, and it is worth naming precisely:
 * a portfolio verb MISSING from the set makes a BUSY steward read as IDLE. The
 * escalation is report-only, so the immediate cost is a false alarm rather than
 * a wrongly-killed goal — but a detector that cries wolf is a detector that gets
 * ignored, which returns us to the money ceiling.
 *
 * A hand-copied verb list cannot be pinned. This one can, and is:
 *
 *   • `portfolio-acts.test.ts` asserts every name here resolves to a REAL
 *     registered tool, so a phantom verb fails the build instead of quietly
 *     never matching.
 *   • The same test asserts GOAL_KICKOFF_GUARDED_TOOLS ⊆ PORTFOLIO_ACT_TOOLS.
 *     That containment is not a coincidence to be maintained by hand: a door so
 *     consequential that a goal holder MAY NOT CROSS IT before its kickoff reads
 *     are done is, by definition, an act of placing portfolio work. Adding a new
 *     guarded door without adding it here now fails a test — which is exactly the
 *     drift that produced `goals:amend`.
 *
 * ⚠ DEPENDENCY-FREE ON PURPOSE — this module imports NOTHING. `kickoff-evidence.ts`
 * (which owns the guarded set) statically imports `@papercusp/db-org` and the mode
 * store, and this constant is read by a pure fold and by a cell resolver. Importing
 * it here to express the containment would drag the store into every consumer at
 * load, the same cycle `activity.ts` documents avoiding. The containment lives in
 * the test, which may import both freely.
 */

/**
 * CREATE — a subject that did not exist now does.
 *
 * The portfolio grew. This is the most unambiguous facet: none of these can be
 * invoked without something new existing afterwards.
 */
export const PORTFOLIO_CREATE_TOOLS = [
  'goals:create',
  'goals:propose',
  'goals:attach-pot',
  'pot:create',
  'pot:create_from_repo',
  'templates:new-app',
  'harness:generate-from-repo',
  'plans:new',
  'plans:add-item',
  'work_items:create',
] as const;

/**
 * PLACE — work that existed is now somebody's.
 *
 * The facet a reading-and-reporting steward most conspicuously never reaches.
 * Starting, assigning, dispatching and launching are the acts that convert a
 * portfolio into motion.
 */
export const PORTFOLIO_PLACE_TOOLS = [
  'goals:start',
  'goals:start-from-package',
  'goals:arm-schedule',
  'plans:start',
  'plan_items:assign',
  'coord:dispatch',
  'fleet:create',
  'fleet:place_batch',
  'fleet:launch-on-plan',
  'capability:launch-agent',
] as const;

/**
 * STEER — the shape, priority or existence of work in flight changed.
 *
 * Includes ENDING. `goals:update` carries both the amendment and the kill (the
 * two verbs the rubric prose invented separate names for), and a judgement to
 * stop is portfolio management, not its absence.
 */
export const PORTFOLIO_STEER_TOOLS = [
  'goals:update',
  'goals:detach-pot',
  'goals:apply-package-update',
  'plans:add-decision',
  'plans:set-status',
  'blender:route-idea',
  'blender:grade-idea',
  'blender:ideate-pass-record',
  'scorecards:emit',
] as const;

/**
 * THE CANONICAL SET. Import this; never re-spell it.
 *
 * Sorted and de-duplicated at module load so callers may rely on the order (it
 * reaches SQL as an array parameter and appears in evidence output).
 */
export const PORTFOLIO_ACT_TOOLS: readonly string[] = Object.freeze(
  [
    ...new Set<string>([
      ...PORTFOLIO_CREATE_TOOLS,
      ...PORTFOLIO_PLACE_TOOLS,
      ...PORTFOLIO_STEER_TOOLS,
    ]),
  ].sort(),
);

/** The facet each act belongs to — for evidence that says WHICH kind of act landed. */
export type PortfolioActFacet = 'create' | 'place' | 'steer';

const FACET_BY_TOOL: ReadonlyMap<string, PortfolioActFacet> = new Map<string, PortfolioActFacet>([
  ...PORTFOLIO_CREATE_TOOLS.map((t) => [t, 'create'] as const),
  ...PORTFOLIO_PLACE_TOOLS.map((t) => [t, 'place'] as const),
  ...PORTFOLIO_STEER_TOOLS.map((t) => [t, 'steer'] as const),
]);

const ACTS = new Set<string>(PORTFOLIO_ACT_TOOLS);

/** Is this tool name a portfolio act? Exact match — the ledger stores canonical names. */
export function isPortfolioAct(toolName: string | null | undefined): boolean {
  return toolName != null && ACTS.has(toolName);
}

/**
 * Which facet, or null for a non-act.
 *
 * Returns null rather than throwing so a caller folding a ledger row never has
 * to pre-filter: an unrecognised name is a measured non-act, not an error.
 */
export function portfolioActFacet(toolName: string | null | undefined): PortfolioActFacet | null {
  return toolName == null ? null : (FACET_BY_TOOL.get(toolName) ?? null);
}
