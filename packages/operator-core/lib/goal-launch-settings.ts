/**
 * goal-launch-settings — the ONE resolution of "how should this goal launch an
 * agent, and may it launch another one at all?"
 * (goal-mode-hardening-2026-08-10 P-004, D-009.)
 *
 * D-004 removed the GOAL contract's "capacity preflight, ramp one at a time"
 * clause and made maximal parallelism the instruction instead. That is only safe
 * because D-005 replaced the preflight with two BINDING ceilings — a per-goal cap
 * over every session associated with the goal, and a per-fleet cap — enforced by
 * the machine rather than by an agent's judgement. This module is those ceilings
 * plus the per-role launch profile (model/effort/account/carry) the goal agent
 * hands down with them, and D-006 is why those numbers are editable DATA here
 * rather than prose an owner would have to rewrite the contract to change.
 *
 * THE RESOLVER RESOLVES THE GOAL; IT DOES NOT ACCEPT ONE. `resolveGoalLaunch`
 * takes the LAUNCHER's owner id and derives the goal through
 * `resolveGoalContext` (D-008). A door cannot forget to pass what it never
 * passes — the same structural move P-002 made when it put goal inheritance on
 * the existing `--launched-by` seam instead of minting a `--goal` flag that a
 * future spawn site could omit. This is what makes D-008's closing constraint
 * ("P-004's resolver must carry goal-context inheritance rather than composing
 * argv that silently drops it") a property of the shape rather than a rule
 * someone has to remember.
 *
 * THE CEILINGS HAVE SYSTEM DEFAULTS (D-015). They did not, originally, and the
 * gap was not "the numbers are unset" — it was that an unset pair DISABLED
 * enforcement outright: with both null, `needsCount` was false, the headcount was
 * never taken, and nothing could be refused. So D-004's removal of the capacity
 * preflight left maximal parallelism running against no governor at all on every
 * goal nobody had hand-edited (9 of 11 when this was found, including all three
 * active ones). Migration 786's column comment had promised "NULL = none declared
 * = system defaults" from the start; {@link GOAL_LAUNCH_DEFAULTS} is the first
 * thing to actually supply them.
 *
 * WHY IN THE RESOLVER AND NOT AT CREATE TIME. A default written into the row by
 * `goals:create` reaches only goals created after it ships — i.e. none of the
 * rows that were exposed, which is the entire point of having one. Resolving here
 * governs every goal on the next launch, and keeps a NULL column meaning exactly
 * one thing ("the owner has not pinned this") rather than two. Same shape as
 * DEFAULT_RATE_LIMIT_CONFIG: a seeded default that any stored value overrides.
 *
 * WHY THE CEILINGS FAIL OPEN. A ceiling that cannot be READ does not refuse the
 * launch; it reports itself degraded and lets the launch through. This is a
 * governor over the owner's own fleet, not a security boundary, and the failure
 * modes are not symmetric: failing closed on a transient read error would brick
 * every launch in the workspace at once — including the launches needed to fix
 * whatever broke the read. The degraded reason is returned rather than swallowed
 * so a caller surfaces "the ceiling was not enforced" instead of quietly
 * reporting success. A ceiling that IS read and IS exceeded refuses, hard.
 *
 * THE BUDGET IS A THIRD CEILING (goal-mode-design-intent-hardening-2026-08-16
 * P-006, flag GOAL_BUDGET_LAUNCH_GATE). `goals.budget_cents` binds against the
 * PLATFORM spend snapshot (`goals.metadata.spentCents`, written only by the
 * goal-spend-rollup tick — D-003) and refuses further launches once spent ≥
 * budget, with a per-goal-deduped owner escalation. It lives in this resolver
 * for the same D-001 reason the agent ceilings do: every launch door already
 * honors `refusal`, so the budget binds everywhere with no per-door obligation.
 * It follows the same fail-open rule — a budget that cannot be read, or that
 * has no platform snapshot yet, is reported degraded, never guessed at.
 */
import { z } from 'zod';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
// Re-exported below for the public surface; imported here because this module
// uses both internally (the schema's role enum + the resolver signatures).
import {
  GOAL_LAUNCH_ROLES,
  type GoalLaunchRole,
  GOAL_HOLDER_ON_LOSS,
  GOAL_HOLDER_DEFAULTS,
  type GoalHolderOnLoss,
} from './goal-launch-settings-shared';
import {
  isGoalHolderAuthorityError,
  resolveGoalContext,
} from './modes/goal-context';
// The fleet-shape vocabulary is owned by the fleet store; `fleetType` below
// derives its accepted values from it rather than declaring them a second time.
import { FLEET_TYPES } from './agent-fleets-store';
import { GOAL_KICKOFF_REQUIRED_READS } from './goals/kickoff-evidence';

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/**
 * How long a presence heartbeat may be stale before its session stops counting
 * against a ceiling. Mirrors the coord store's own window; a copy rather than an
 * import because this module must not drag the presence tool's dependency graph
 * into every launch path.
 */
export const GOAL_HEADCOUNT_STALE_MS = 10 * 60_000;

/**
 * A session that has been launched but has not yet written its first presence
 * row still counts for this long. Without it a burst of launches all read a
 * headcount of zero and every one of them is admitted — the exact overshoot the
 * ceiling exists to prevent. Mirrors `SEAT_BOOT_GRACE_MS` in
 * fleet/seat-accounting.ts, which solved the identical race for slot allotments.
 */
export const GOAL_HEADCOUNT_BOOT_GRACE_MS = 10 * 60_000;

/**
 * The closed sets a launch profile may name, as CONSTANTS the schema is then
 * built from — not as literals inside `z.enum(...)`.
 *
 * The editor (P-005) has to offer exactly the values this schema accepts, and a
 * hand-spelled option list in the UI is the drift D-011 is about: the panel and
 * the validator would be two declarations of one set, and the panel's copy would
 * fall behind silently — offering a value the write refuses, or hiding one it
 * accepts. Exporting the arrays lets the read path SHIP them (goals.detail's
 * `launchSettingsOptions`), so the editor renders what the validator enforces by
 * construction rather than by someone remembering to update both.
 */
export const LAUNCH_PROFILE_AGENTS = ['claude', 'codex', 'omp'] as const;
export const LAUNCH_PROFILE_CARRY = ['warm', 'cold'] as const;
// WI-2140338: 'steward' is the explicit opt-in intermediate tool seed (core
// spine + steward verb families — see STEWARD_MCP_TOOL_FAMILIES in
// role-launch-spec.ts) for goal-holder roles. 'trimmed' stays the default;
// 'full' stays retired (WI-4608) and is deliberately NOT in this set.
export const LAUNCH_PROFILE_CONTEXT_SIZES = ['trimmed', 'steward'] as const;

/**
 * Headed vs headless, as the EDITOR's three states (P-001, D-002).
 *
 * The stored key is a real `boolean` — that is the spelling the fleet layer
 * already uses (`PER_ROLE_KNOBS` in fleet_registry/pair-launch-options.ts), and
 * a goal profile that said `'true'` where a fleet role says `true` would be two
 * spellings of one concept, which is the drift the closed-set constants exist to
 * prevent. These strings are the editor's rendering of that boolean, converted at
 * the form boundary — never what lands in the document.
 *
 * ABSENT is the third state and it is not in this list: an unpinned `headless`
 * resolves to `true` (today's hardcoded behaviour), so blank must stay
 * distinguishable from an explicit `false` exactly as it is for the ceilings.
 *
 * The members are the WORDS, not `'true'`/`'false'`, because the editor renders
 * a closed set by mapping each member straight to its own label. Stringly
 * booleans would put "true" in a dropdown whose field reads "Window", and would
 * need a per-field label table to fix — a second declaration of this same set,
 * which is the drift these constants exist to prevent.
 */
export const LAUNCH_PROFILE_HEADLESS = ['headless', 'headed'] as const;

/** The option lists an editor must render, in one payload-shaped object. */
export const LAUNCH_PROFILE_OPTIONS = {
  agent: LAUNCH_PROFILE_AGENTS,
  carry: LAUNCH_PROFILE_CARRY,
  contextSize: LAUNCH_PROFILE_CONTEXT_SIZES,
  headless: LAUNCH_PROFILE_HEADLESS,
} as const;

/**
 * The system ceilings a goal that has pinned nothing launches under (D-015).
 *
 * These are not round numbers; they are what the GOAL contract in modes/registry
 * obliges a goal to be running, added up:
 *
 *   1  the goal agent itself
 *   4  the standing drain fleet (leader + 3) the contract requires per goal,
 *      "always maintained, not spun up on demand"
 *   3  a plan fleet (leader + 2)
 *   3  a SECOND plan fleet, concurrent — the row that makes "parallelize hard"
 *      true rather than merely permitted
 *   1  one judge: a GRADE or TEST agent
 *  ──
 *  12
 *
 * The floor matters more than the number. A goal cannot satisfy its own contract
 * below EIGHT (goal agent + drain fleet + one plan fleet), so a default under
 * that would make the default itself a bug — the goal agent refused while
 * establishing the standing drain fleet it was ordered to maintain. 12 is that
 * floor plus one more concurrent plan fleet.
 *
 * `maxPerFleet` is a leader + 4. Past that, members on one plan increasingly
 * touch the same files and serialize on the locks, so the fan-out buys
 * contention rather than throughput. It also composes: 12 over 5 means a goal
 * CANNOT pile everything into one fleet and must spread across two or three,
 * which is what D-004 asks for in prose.
 */
export const GOAL_LAUNCH_DEFAULTS = {
  maxAgents: 12,
  maxPerFleet: 5,
} as const;

/**
 * The explicit "no ceiling" a goal may declare (D-015, owner-directed).
 *
 * Once absent means "use the system default", ungoverned has to be SAYABLE — and
 * as a self-describing literal rather than a sentinel number, because the value
 * an owner reads back has to distinguish "deliberately unlimited" from "nobody
 * set this". `0` was never available (it parses as "forbid every launch") and a
 * magic 1000 would be indistinguishable from a very large deliberate ceiling.
 */
export const UNLIMITED_CEILING = 'unlimited' as const;

/** A stored ceiling: a hard number, or the explicit opt-out. */
export type GoalCeiling = number | typeof UNLIMITED_CEILING;

const ceilingSchema = z
  .union([z.number().int().positive().max(1000), z.literal(UNLIMITED_CEILING)])
  .nullable()
  .optional();

/**
 * One stored ceiling → the number to enforce, or null for genuinely no ceiling.
 *
 * The three-way distinction is the whole point, and collapsing any two of them
 * reintroduces the bug this replaced:
 *   absent / null  → the owner has not pinned one  → the system default
 *   'unlimited'    → the owner pinned "no ceiling" → null (nothing enforced)
 *   a number       → that number
 */
export function resolveCeiling(stored: GoalCeiling | null | undefined, fallback: number): number | null {
  if (stored === UNLIMITED_CEILING) return null;
  if (typeof stored === 'number') return stored;
  return fallback;
}

/**
 * The launch-slot vocabulary now lives in `goal-launch-settings-shared.ts` and is
 * re-exported here so every existing caller keeps working unchanged.
 *
 * WHY IT MOVED (WI-39514): this module value-imports `getOrgPg` from
 * `@papercusp/db-org`, whose chain reaches `embedded-pg-discovery` ->
 * `node:path`. With no tree-shaking on the SPA's Vite dev graph, a client
 * component importing just `GOAL_LAUNCH_ROLES` from here dragged all of that
 * into the browser, where `node:path` is a stub that throws on property access —
 * white-screening the whole /adv route via its error boundary. Client code must
 * import these three from the shared file; see that file's docblock and
 * `apps/operator-vite/src/__tests__/no-server-leak-in-client-graph.test.ts`.
 */
export {
  GOAL_LAUNCH_ROLES,
  isGoalLaunchRole,
  type GoalLaunchRole,
  GOAL_HOLDER_ON_LOSS,
  isGoalHolderOnLoss,
  GOAL_HOLDER_DEFAULTS,
  type GoalHolderOnLoss,
} from './goal-launch-settings-shared';

// A re-export creates no LOCAL binding, and `goalHolderPolicyProblem` below
// calls the resolver — so it is imported as well as re-exported.
import { resolveGoalHolderPolicy } from './goal-launch-settings-shared';

/**
 * The holder policy a goal declares (P-002 of
 * goal-live-holder-guarantee-2026-08-18).
 *
 * `requireLive` — must this goal be held by a LIVE agent to count as active?
 * `onLoss`      — what happens when it is not.
 *
 * Both are `.nullable().optional()` for the same reason `ceilingSchema` is: the
 * P-005 panel clears a field by writing `null`, and a cleared field means "the
 * owner has not pinned this" — which must resolve to the system default rather
 * than to `false`. Collapsing absent into `false` would silently opt a goal OUT
 * of the guarantee at exactly the moment its owner tried to reset it.
 */
export const goalHolderPolicySchema = z
  .object({
    requireLive: z.boolean().nullable().optional(),
    onLoss: z.enum(GOAL_HOLDER_ON_LOSS).nullable().optional(),
  })
  .strict();

export type GoalHolderPolicy = z.infer<typeof goalHolderPolicySchema>;

/**
 * `resolveGoalHolderPolicy` and its result type MOVED to
 * `goal-launch-settings-shared.ts` (P-004) and are re-exported here so every
 * existing importer is unaffected.
 *
 * WHY THE MOVE: the resolver is pure, but THIS module statically imports
 * `@papercusp/db-org`, so importing it costs the store's server dependencies at
 * load — which is why `resolveGoalDetail` reaches for it via `await import`.
 * The read-side activity fold (`goals/activity.ts`) is pure and SYNCHRONOUS, so
 * a dynamic import was not open to it; putting the resolver beside the defaults
 * it applies, in the module that already has no dependencies, is the fix that
 * keeps one definition rather than two.
 */
export {
  resolveGoalHolderPolicy,
  type GoalHolderPolicyInput,
  type ResolvedGoalHolderPolicy,
} from './goal-launch-settings-shared';

/**
 * The write-boundary refusal message, or null when the policy is acceptable
 * (P-003 of goal-live-holder-guarantee-2026-08-18).
 *
 * WHY A SHARED PREDICATE AND NOT A LINE AT EACH DOOR. Three doors install a
 * goal's holder policy — `goals:create`, `goals:start`, and GOAL-mode attach
 * (`mode:set { mode:'goal', subject }`) — and `killCriterionProblem`'s docblock
 * already records what happens when each writes its own copy: the door with the
 * looser copy quietly becomes the way to install what the others would have
 * refused. Same rule, same shape (a MESSAGE, not a boolean, because every
 * caller surfaces it verbatim).
 *
 * WHAT IT REFUSES, AND WHY THAT IS NOT THE SAME AS "REFUSE EVERY GOAL". D-008
 * makes `requireLive` default TRUE at READ time, which is what covers the 18
 * goals that already exist with no migration. That default is a rescue for the
 * legacy population, NOT a licence for the population to keep growing: this
 * refuses a NEW holder-required goal whose creator declared nothing, so the set
 * of goals whose holder semantics nobody chose can only shrink from here.
 *
 * The predicate is written as `requireLive && isDefault` rather than the
 * equivalent-today `isDefault` on purpose. They coincide only because the
 * default is true; stating both keeps the rule honest ("a goal that WILL require
 * a live holder, whose owner never said so") if D-008's default is ever revisited.
 *
 * Pinning EITHER field counts as declaring. A goal that pins only
 * `onLoss:'respawn'` has engaged with the policy deliberately and gets the
 * `requireLive` default knowingly — which is exactly the distinction `isDefault`
 * was added to carry, so it is read here rather than re-derived from absence.
 */
export function goalHolderPolicyProblem(settings: GoalLaunchSettings | null | undefined): string | null {
  const policy = resolveGoalHolderPolicy(settings);
  if (!policy.requireLive || !policy.isDefault) return null;
  return (
    'this goal would require a LIVE holder but declares no holder policy — ' +
    `it is inheriting the default (requireLive: ${GOAL_HOLDER_DEFAULTS.requireLive}, ` +
    `onLoss: '${GOAL_HOLDER_DEFAULTS.onLoss}') rather than stating one. ` +
    'Declare it: holder: { requireLive: true } if a live holder is what you mean, ' +
    'or holder: { requireLive: false } for a goal driven by routines rather than a held session.'
  );
}

/** The launch knobs a goal can pin, per slot or as its across-the-board default. */
export const launchProfileSchema = z
  .object({
    agent: z.enum(LAUNCH_PROFILE_AGENTS).optional(),
    model: z.string().min(1).max(120).optional(),
    effort: z.string().min(1).max(40).optional(),
    account: z.string().min(1).max(120).optional(),
    carry: z.enum(LAUNCH_PROFILE_CARRY).optional(),
    contextSize: z.enum(LAUNCH_PROFILE_CONTEXT_SIZES).optional(),
    /**
     * WI-2140338 [owner 2026-09-01]: the session's compaction ceiling in TOKENS,
     * threaded to the spawn as `--compaction-limit` (the same argv seam fleet
     * MemberSpec.compactionLimit rides). Lets a goal pin its holder to the model's
     * full window (e.g. 1_000_000 on a ~1M-window model) instead of the tier
     * default. Absent = unpinned = the tier/system default, per this schema's
     * absent-stays-absent rule. Distinct from `contextSize`, which sizes the
     * initial TOOL surface, not the token window.
     */
    compactionLimit: z.number().int().min(50_000).max(2_000_000).optional(),
    /**
     * D-002: ABSENT means UNPINNED, not `false`.
     *
     * Every existing goal document omits this key, and the one activation door
     * (harness/routines/goal-holder-launch-action.ts) hardcoded `headless: true`
     * before this landed. So unpinned MUST resolve to `true` or adding the key
     * would silently re-point every stored goal at a visible terminal — a
     * behaviour change wearing a schema addition's clothes. Only an explicit
     * `false` asks for a headed launch.
     */
    headless: z.boolean().optional(),
  })
  .strict();

export type LaunchProfile = z.infer<typeof launchProfileSchema>;

/**
 * The document stored in `harness_shared.goals.launch_settings`.
 *
 * `.strict()` on both levels is deliberate: these are hand-edited by an owner
 * through the P-005 panel, and a typo'd key that is silently accepted reads back
 * as "the setting is there" while the launch ignores it.
 */
export const goalLaunchSettingsSchema = z
  .object({
    maxAgents: ceilingSchema.describe(
      `D-005: ceiling over EVERY live session associated with this goal, fleet members included. ` +
        `Omit for the system default (${GOAL_LAUNCH_DEFAULTS.maxAgents}); '${UNLIMITED_CEILING}' for no ceiling at all`,
    ),
    maxPerFleet: ceilingSchema.describe(
      `D-005: ceiling on any ONE fleet pursuing this goal; composes with maxAgents. ` +
        `Omit for the system default (${GOAL_LAUNCH_DEFAULTS.maxPerFleet}); '${UNLIMITED_CEILING}' for no ceiling at all`,
    ),
    defaults: launchProfileSchema.optional(),
    /**
     * D-016: keyed by the CLOSED launch-slot vocabulary, never by psu `--role`.
     * Free-text keys were accepted before and bound nothing, which is precisely
     * the "reads as configured while doing nothing" state `.strict()` exists to
     * prevent. Measured before narrowing: 0 of 12 goals carried a `roles` key,
     * so no stored document is invalidated by closing this set.
     */
    roles: z.partialRecord(z.enum(GOAL_LAUNCH_ROLES), launchProfileSchema).optional(),
    /**
     * P-004: which SHAPE of fleet this goal's plan fleets are launched as.
     *
     * The accepted values are DERIVED from `FLEET_TYPES` (agent-fleets-store),
     * never re-spelled here — the fleet layer already owns this vocabulary, and
     * a second copy is the D-011 drift one level up: the goal panel would offer
     * a type the launch surface does not branch on.
     *
     * ABSENT ⇒ 'single', matching `asFleetType`'s defensive narrowing and
     * `resolveLaunchOptions`'s own rule that an omitted type is single. The
     * default must stay INVISIBLE so no existing goal has to learn the field
     * exists.
     */
    fleetType: z.enum(FLEET_TYPES).optional(),
    /**
     * P-002 (goal-live-holder-guarantee-2026-08-18): the goal's HOLDER policy.
     *
     * Purely additive, and measured so before shipping: of 18 goals in
     * papercusp-workspace, 3 carry any launch_settings at all and 0 carry a
     * `holder` key — so no stored document is invalidated by adding it, and no
     * migration is needed (this column is jsonb).
     *
     * Absent means UNPINNED, not "not required" — see
     * {@link resolveGoalHolderPolicy}, which supplies the defaults at read time
     * so goals that already exist are covered.
     */
    holder: goalHolderPolicySchema.nullable().optional(),
    /**
     * P-020 (work-on-everything-goal-2026-08-23, D-006): opt this goal INTO
     * automatic activation when its DAG becomes ready.
     *
     * Absent / null / false preserves D-003: readiness at goal level is a
     * surfaced OFFER, never a dispatch. With `autoStart: true`, the
     * goal-liveness watchdog's readiness leg dispatches the one
     * goal-activation primitive (`startGoalById`) when the goal BECOMES READY
     * with no live holder. The primitive still owns every guard (not-active /
     * already-held / readiness re-check under its own reads), so this flag can
     * never resurrect a closed goal or double-start a held one — a stale
     * classification costs a refusal, not a duplicate agent.
     *
     * `.nullable()` for the same reason as `holder`: the panel clears a field
     * by writing `null`, which must mean "unpinned", never a third state.
     */
    autoStart: z.boolean().nullable().optional(),
  })
  .strict();

export type GoalLaunchSettings = z.infer<typeof goalLaunchSettingsSchema>;

export interface GoalHeadcount {
  /** Live sessions whose resolved goal context is this goal. */
  total: number;
  /** Live sessions of this goal within `fleetSlug`, or null when no fleet was named. */
  fleet: number | null;
}

export interface GoalLaunchRefusal {
  reason: 'goal_max_agents' | 'fleet_max_agents' | 'goal_budget_exceeded';
  limit: number;
  current: number;
  requested: number;
  message: string;
  /**
   * What POPULATION `current` measured (spend-attribution…-2026-09-04 P-004).
   *
   * A ceiling refusal is a readout attached to a REFUSAL, so it is among the
   * worst places for a bare number. `has spent 6200 of its 10000 cent budget`
   * reads as a fact about what the goal cost; it is a fact about the goal's POT
   * SUBSET, which in this workspace is a small minority of the real figure.
   *
   * REQUIRED, not optional: a refusal that cannot say what it counted is the
   * defect, so a new refusal reason must choose a label rather than inherit a
   * silent default.
   */
  currentScope: string;
}

/**
 * Population labels for {@link GoalLaunchRefusal.currentScope}.
 *
 * ⚠ `BUDGET_POT` deliberately DUPLICATES `GOAL_SPEND_POT_SCOPE` from
 * `./goals/spend-rollup` rather than importing it. That module reaches
 * `@papercusp/agent-mcp`, which imports THIS file, so the import would close a
 * runtime cycle. Duplication is the lesser evil here, but only because it is
 * PINNED: `goal-launch-refusal-scopes.test.ts` fails if the two literals ever
 * diverge, which is the repo's rule for code-describing metadata that cannot be
 * derived.
 */
export const REFUSAL_SCOPES = {
  /** Mirrors GOAL_SPEND_POT_SCOPE — see the cycle note above. */
  BUDGET_POT: 'inside-goal-pots:authoritative',
  /**
   * The value carried no provenance marker, so its population is UNKNOWN. Not a
   * synonym for the pot scope: the gate's SELECT filters on nothing, so an
   * unmarked legacy figure reaches this ceiling identically to a rollup-written
   * one. Labelling it as pot-scoped would assert provenance nothing verified —
   * the precise error this plan exists to stop.
   */
  BUDGET_UNVERIFIED: 'unverified-provenance:unmarked-snapshot',
  LIVE_AGENTS_IN_GOAL: 'live-agents-in-goal',
  LIVE_AGENTS_IN_FLEET: 'live-agents-in-fleet',
} as const;

/**
 * The population a stored `spentCents` actually describes, judged from the
 * marker beside it rather than assumed. Both known writers
 * (`spend-rollup.ts`'s tick and `goals:update`'s verified rollup) persist a
 * pot-leg figure; anything unmarked is reported as unverified instead of being
 * granted their standing.
 */
export function budgetSpendScope(source: string | null): string {
  return source === 'goal-pots-rollup' || source === 'goal-spend-tick'
    ? REFUSAL_SCOPES.BUDGET_POT
    : REFUSAL_SCOPES.BUDGET_UNVERIFIED;
}

/**
 * P-006 (goal-mode-design-intent-hardening-2026-08-16): the budget truth read
 * beside the settings. `budgetCents` is the owner's declared ceiling
 * (`goals.budget_cents`, NULL = no budget declared = nothing enforced);
 * `spentCents` is the PLATFORM snapshot (`goals.metadata.spentCents`, written
 * only by the goal-spend-rollup tick — D-003: agents never hand-write it, and
 * this gate never trusts any other figure). A declared budget with no snapshot
 * is reported degraded rather than guessed at: a null from a careful platform
 * outranks an invented number.
 */
export interface GoalBudgetTruth {
  budgetCents: number | null;
  spentCents: number | null;
  spentCentsAt: string | null;
  /**
   * The provenance marker actually stored beside the number
   * (`goals.metadata.spentCentsSource`), or null when the value predates the
   * marker or was written by something that did not set one.
   *
   * Read (spend-attribution…-2026-09-04 P-004) so the ceiling refusal can NAME
   * the population its number measured instead of asserting one. The doc above
   * says this gate "never trusts any other figure", but the SELECT that feeds it
   * filters on nothing — so an unmarked legacy value reaches the ceiling exactly
   * like a rollup-written one, and the two are indistinguishable downstream
   * unless the marker travels with the cents. It now does.
   */
  spentCentsSource: string | null;
}

export type GoalPlanPlacementState =
  | 'unplaced'
  | 'admitting'
  | 'independently-led'
  | 'working'
  | 'blocked'
  | 'terminal';

export type GoalPlanPlacementRepairAction =
  | 'none'
  | 'launch-plan-fleet'
  | 'launch-spawned-leader'
  | 'resume-partial-launch'
  | 'restore-spawned-leader'
  | 'reconcile-plan-lane-holder'
  | 'resolve-plan-identity'
  | 'resolve-plan-blockers';

export interface GoalPlanPlacementToolCall {
  tool: 'fleet:launch-on-plan';
  args: {
    name: string;
    plan: string;
    harness: string;
    count: 1;
    leader: 'spawn';
    headless: true;
  };
}

/**
 * The compiled placement truth for one worklist plan. This is deliberately a
 * receipt over the existing plan-item lease + fleet launch ledgers, not a new
 * placement store. `reconciliation.action` is the one idempotent next repair a
 * GOAL holder should perform after refreshing the named canonical records.
 */
export interface GoalPlanPlacement {
  state: GoalPlanPlacementState;
  fleet: {
    slug: string;
    controlState: string | null;
    leaderOwnerId: string | null;
    leaderLive: boolean;
    liveMembers: number;
    target: number | null;
  } | null;
  activeLane: {
    itemId: string;
    ownerId: string;
    ownerFleet: string | null;
    holderLive: boolean;
    expiresAt: string | null;
  } | null;
  launchTransaction: {
    transactionId: string | null;
    state: 'launching' | 'partial' | 'verified' | null;
    retryOwnerIds: string[];
    nextAction: string | null;
  } | null;
  reconciliation: {
    consistent: boolean;
    action: GoalPlanPlacementRepairAction;
    reason: string;
    toolCall: GoalPlanPlacementToolCall | null;
  };
}

/**
 * P-012 (goal-mode-hardening-2026-08-10): the ONE compact portfolio snapshot
 * handed to a GOAL holder at launch and on every coord:orient. It is a read
 * projection over the canonical goal/plan/pot/fleet/work-item/learning stores;
 * none of these fields is a second ledger.
 */
export interface GoalPortfolioBrief {
  schemaVersion: 1;
  assembledAt: string;
  goal: {
    id: string;
    title: string;
    status: string | null;
    body: string | null;
    killCriterion: string | null;
    standing: boolean;
    parentId: string | null;
  };
  worklist: Array<{
    ref: string;
    ordinal: number;
    harness: string | null;
    slug: string;
    title: string | null;
    status: string | null;
    next: { id: string; text: string; phase: string | null; blockedBy: string[] } | null;
    counts: { todo: number; wip: number; blocked: number; needsHuman: number; done: number };
    ambiguousMatches: number;
    placement: GoalPlanPlacement;
  }>;
  pots: Array<{ harness: string; role: 'owner' | 'contributing'; note: string | null }>;
  drainFleet: {
    slug: string | null;
    exists: boolean | null;
    controlState: string | null;
    leaderOwnerId: string | null;
    live: number | null;
    working: number | null;
  };
  queue: {
    total: number;
    terminal: number;
    inFlight: number;
    blocked: number;
    needsHuman: number;
    claimable: number | null;
    claimabilityScope: 'issue-family' | 'none' | 'unknown';
  };
  launch: {
    settings: GoalLaunchSettings | null;
    ceilings: { maxAgents: number | null; maxPerFleet: number | null };
    headcount: GoalHeadcount;
  };
  budget: GoalBudgetTruth & { budgetWindowSec: number | null };
  tripwires: Array<{ metric: string; label?: string; threshold?: number; current?: number; unit?: string }>;
  pending: {
    blenderIdeas: number | null;
    acceptanceRubric: { id: string; status: string | null; latestScorecardAt: string | null } | null;
  };
  continuity: {
    checkpoint: { workItemId: string; updatedAt: string; note: string } | null;
    lastOwnerReportAt: string | null;
  };
  priorities: string[];
  degradedReasons: string[];
}

type GoalPortfolioSourceRow = {
  status?: unknown;
  parent_id?: unknown;
  tripwires?: unknown;
  properties?: unknown;
  metadata?: unknown;
  pots?: unknown;
  plans?: unknown;
  queue?: unknown;
  drain_fleet?: unknown;
  checkpoint?: unknown;
  last_owner_report_at?: unknown;
  blender_pending?: unknown;
  acceptance_rubric?: unknown;
};

const portfolioObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const portfolioArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const portfolioString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const portfolioBoolean = (value: unknown): boolean => value === true;
const portfolioNumber = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
};

const portfolioJsonObject = (value: unknown): Record<string, unknown> | null => {
  const direct = portfolioObject(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  try {
    return portfolioObject(JSON.parse(value));
  } catch {
    return null;
  }
};

/** Pure compiler over the canonical records already assembled by the portfolio read. */
export function compileGoalPlanPlacement(args: {
  plan: { harness: string | null; slug: string; ambiguousMatches: number };
  status: string | null;
  itemStatuses: readonly string[];
  actionableItemId: string | null;
  source: unknown;
  now?: Date;
}): GoalPlanPlacement {
  const source = portfolioObject(args.source) ?? {};
  const nowMs = (args.now ?? new Date()).getTime();
  const claims = portfolioArray(source.claims)
    .map(portfolioObject)
    .filter((claim): claim is Record<string, unknown> => claim !== null)
    .filter((claim) => {
      const expiresAt = portfolioString(claim.expiresAt);
      return !expiresAt || Date.parse(expiresAt) > nowMs;
    });
  const laneRaw = args.actionableItemId
    ? (claims.find((claim) => portfolioString(claim.itemId) === args.actionableItemId) ?? null)
    : null;
  const activeLane = laneRaw
    ? {
        itemId: portfolioString(laneRaw.itemId)!,
        ownerId: portfolioString(laneRaw.ownerId) ?? 'unknown',
        ownerFleet: portfolioString(laneRaw.fleetSlug),
        holderLive: portfolioBoolean(laneRaw.holderLive),
        expiresAt: portfolioString(laneRaw.expiresAt),
      }
    : null;
  const fleetRaw = portfolioObject(source.fleet);
  const fleetSlug = portfolioString(fleetRaw?.slug);
  const fleet =
    fleetRaw && fleetSlug
      ? {
          slug: fleetSlug,
          controlState: portfolioString(fleetRaw.controlState),
          leaderOwnerId: portfolioString(fleetRaw.leaderOwnerId),
          leaderLive: portfolioBoolean(fleetRaw.leaderLive),
          liveMembers: portfolioNumber(fleetRaw.liveMembers),
          target: fleetRaw.target == null ? null : portfolioNumber(fleetRaw.target),
        }
      : null;
  const transactionRaw = portfolioJsonObject(fleetRaw?.launchTransaction);
  const transactionState = portfolioString(transactionRaw?.state);
  const recoveryRaw = portfolioObject(transactionRaw?.recovery);
  const launchTransaction: GoalPlanPlacement['launchTransaction'] = transactionRaw
    ? {
        transactionId: portfolioString(transactionRaw.transactionId),
        state:
          transactionState === 'launching' || transactionState === 'partial' || transactionState === 'verified'
            ? transactionState
            : null,
        retryOwnerIds: portfolioArray(recoveryRaw?.retryOwnerIds).map(String).filter(Boolean),
        nextAction: portfolioString(recoveryRaw?.nextAction),
      }
    : null;

  const normalizedStatus = args.status?.trim().toLowerCase() ?? '';
  const normalizedItems = args.itemStatuses.map((status) => status.trim().toLowerCase());
  const terminal =
    normalizedStatus === 'done' ||
    normalizedStatus === 'shipped' ||
    normalizedStatus === 'superseded' ||
    (normalizedItems.length > 0 && normalizedItems.every((status) => status === 'done' || status === 'dropped'));
  // A draft plan may contain dependency-free todo items, but the plan start
  // oracle still refuses it until the owner approves the plan and supplies all
  // declared inputs. Treating that row as `unplaced` produced a launch action
  // that could never succeed and, worse, kept it as the first mandatory action
  // on every GOAL wake, starving later eligible worklist plans. Draft (and
  // paused/unknown operational) plans are therefore blocked at the portfolio
  // compiler; only an approved/active plan may emit a fleet launch call.
  const planStartable = normalizedStatus === 'ready' || normalizedStatus === 'active' || normalizedStatus === 'started';
  const blocked = !terminal && args.actionableItemId == null;
  const planHarness = args.plan.harness?.trim() || null;
  const planSlug = args.plan.slug.trim();
  const planIdentityProblem =
    args.plan.ambiguousMatches > 1
      ? `The worklist plan ${planSlug} is ambiguous across ${args.plan.ambiguousMatches} harnesses; qualify its plan ref before launch.`
      : !planHarness
        ? `The worklist plan ${planSlug} has no resolved harness; repair its plan ref before launch.`
        : !planSlug
          ? 'The worklist entry has no resolved plan slug; repair it before launch.'
          : null;
  const planFleetToolCall: GoalPlanPlacementToolCall | null =
    planIdentityProblem || !planHarness
      ? null
      : {
          tool: 'fleet:launch-on-plan',
          args: {
            // Initial placement gets one deterministic name. Recovery must use
            // the correlated fleet row's actual slug: launch-on-plan keys its
            // durable transaction/idempotency guard by that name-derived slug,
            // so synthesizing a new name here would fork a second fleet.
            name: fleet?.slug ?? `${planHarness}-${planSlug}-plan-fleet`,
            plan: planSlug,
            harness: planHarness,
            count: 1,
            leader: 'spawn',
            headless: true,
          },
        };

  let state: GoalPlanPlacementState;
  let action: GoalPlanPlacementRepairAction;
  let reason: string;
  if (terminal) {
    state = 'terminal';
    action = 'none';
    reason = 'The plan is terminal; no placement repair is required.';
  } else if (planIdentityProblem) {
    state = 'blocked';
    action = 'resolve-plan-identity';
    reason = planIdentityProblem;
  } else if (!planStartable) {
    state = 'blocked';
    action = 'resolve-plan-blockers';
    reason = `The plan is ${normalizedStatus || 'unresolved'} and cannot launch until its lifecycle/start gate is satisfied.`;
  } else if (blocked) {
    state = 'blocked';
    action = 'resolve-plan-blockers';
    reason = 'The plan has non-terminal work but no dependency-free todo item.';
  } else if (!activeLane) {
    state = 'unplaced';
    action = 'launch-plan-fleet';
    reason =
      `Launch the independently led plan fleet in one call. fleet:launch-on-plan owns promotion, ` +
      `plan-lane admission, the scheduler claim spec, and spawned leadership for ${args.actionableItemId}; ` +
      'the GOAL holder must not claim the plan item itself.';
  } else if (!fleet) {
    state = 'admitting';
    action = 'launch-spawned-leader';
    reason = `The ${activeLane.itemId} lease is held; launch its independently led fleet with leader:'spawn'.`;
  } else if (launchTransaction?.state === 'launching' || launchTransaction?.state === 'partial') {
    state = 'admitting';
    action = 'resume-partial-launch';
    reason =
      launchTransaction.nextAction ?? 'Resume the durable fleet launch transaction without replaying verified members.';
  } else if (!fleet.leaderLive) {
    state = 'admitting';
    action = 'restore-spawned-leader';
    reason = `Fleet ${fleet.slug} has no live delegated leader; restore one without moving the GOAL steward.`;
  } else if (!activeLane.holderLive) {
    state = 'blocked';
    action = 'reconcile-plan-lane-holder';
    reason = `The ${activeLane.itemId} lease holder is not live; restore it or reclaim the lane through the canonical lease authority.`;
  } else {
    const hasWip = normalizedItems.some((status) => status === 'wip');
    state = hasWip ? 'working' : 'independently-led';
    action = 'none';
    reason =
      state === 'working'
        ? `Fleet ${fleet.slug} has live delegated leadership and is working the leased plan lane.`
        : `Fleet ${fleet.slug} has live delegated leadership; the plan lane is ready for its next work transition.`;
  }

  return {
    state,
    fleet,
    activeLane,
    launchTransaction,
    reconciliation: {
      consistent: action === 'none',
      action,
      reason,
      toolCall:
        action === 'launch-plan-fleet' ||
        action === 'launch-spawned-leader' ||
        action === 'resume-partial-launch' ||
        action === 'restore-spawned-leader'
          ? planFleetToolCall
          : null,
    },
  };
}

function parsePortfolioWorklist(raw: unknown, now: Date): GoalPortfolioBrief['worklist'] {
  return portfolioArray(raw).flatMap((value) => {
    const row = portfolioObject(value);
    const ref = portfolioString(row?.ref);
    const slug = portfolioString(row?.slug);
    if (!row || !ref || !slug) return [];
    const harness = portfolioString(row.harness);
    const ambiguousMatches = portfolioNumber(row.ambiguousMatches);
    const items = portfolioArray(row.items)
      .map(portfolioObject)
      .filter((item): item is Record<string, unknown> => item !== null)
      .sort((a, b) => portfolioNumber(a.seq) - portfolioNumber(b.seq));
    const counts = { todo: 0, wip: 0, blocked: 0, needsHuman: 0, done: 0 };
    for (const item of items) {
      const status = portfolioString(item.status) ?? 'todo';
      if (status === 'wip') counts.wip += 1;
      else if (status === 'blocked') counts.blocked += 1;
      else if (status === 'needs-human' || status === 'needs_human') counts.needsHuman += 1;
      else if (status === 'done' || status === 'dropped') counts.done += 1;
      else counts.todo += 1;
    }
    const nextRow = items.find((item) => {
      const status = portfolioString(item.status) ?? 'todo';
      const blockedBy = portfolioArray(item.blockedBy).map(String).filter(Boolean);
      return status === 'todo' && blockedBy.length === 0;
    });
    // A WIP item is the fleet's current lane. Only fall through to the next
    // dependency-free todo when nothing is already underway; otherwise a live
    // WIP lease would be hidden behind the subsequent todo and compile as a
    // false `unplaced` state.
    const laneRow = items.find((item) => (portfolioString(item.status) ?? 'todo') === 'wip') ?? nextRow;
    const next = nextRow
      ? {
          id: portfolioString(nextRow.id) ?? 'unknown',
          text: portfolioString(nextRow.text) ?? '',
          phase: portfolioString(nextRow.phase),
          blockedBy: portfolioArray(nextRow.blockedBy).map(String).filter(Boolean),
        }
      : null;
    return [
      {
        ref,
        ordinal: portfolioNumber(row.ordinal),
        harness,
        slug,
        title: portfolioString(row.title),
        status: portfolioString(row.status),
        next,
        counts,
        ambiguousMatches,
        placement: compileGoalPlanPlacement({
          plan: { harness, slug, ambiguousMatches },
          status: portfolioString(row.status),
          itemStatuses: items.map((item) => portfolioString(item.status) ?? 'todo'),
          actionableItemId: laneRow ? (portfolioString(laneRow.id) ?? 'unknown') : null,
          source: row.placement,
          now,
        }),
      },
    ];
  });
}

/** Render the compact snapshot for a prompt without creating a second prose contract. */
export function renderGoalPortfolioBrief(brief: GoalPortfolioBrief): string {
  const plans = brief.worklist.length
    ? brief.worklist
        .map(
          (p) =>
            `${p.ordinal}. ${p.ref} [${p.status ?? 'missing'}; placement=${p.placement.state}]${p.next ? ` next=${p.next.id}` : ''}`,
        )
        .join('; ')
    : 'none declared';
  const priorities = brief.priorities.length
    ? brief.priorities.map((p, i) => `${i + 1}. ${p}`).join('\n')
    : '1. Re-read the goal before any write.';
  const mandatoryPlacement = brief.worklist.find((plan) => plan.placement.reconciliation.toolCall !== null);
  const mandatoryToolCall = mandatoryPlacement?.placement.reconciliation.toolCall ?? null;
  return [
    `GOAL PORTFOLIO SNAPSHOT — assembled ${brief.assembledAt} (schema v${brief.schemaVersion})`,
    `Goal: ${brief.goal.status ?? 'unknown'}; worklist: ${plans}`,
    `Pots: ${brief.pots.map((p) => `${p.harness}:${p.role}`).join(', ') || 'none'}`,
    `Drain fleet: ${brief.drainFleet.slug ?? 'not declared'}; live=${brief.drainFleet.live ?? 'unknown'}; working=${brief.drainFleet.working ?? 'unknown'}; control=${brief.drainFleet.controlState ?? 'unknown'}`,
    `Queue: total=${brief.queue.total}; terminal=${brief.queue.terminal}; in-flight=${brief.queue.inFlight}; blocked=${brief.queue.blocked}; needs-human=${brief.queue.needsHuman}; claimable=${brief.queue.claimable ?? 'unknown'} (${brief.queue.claimabilityScope})`,
    `Launch: headcount=${brief.launch.headcount.total}; maxAgents=${brief.launch.ceilings.maxAgents ?? 'unlimited'}; maxPerFleet=${brief.launch.ceilings.maxPerFleet ?? 'unlimited'}`,
    // P-004: NAME THE POPULATION. This line lands in the kickoff of every agent
    // that works the goal, which makes it the most-read rendering of this number
    // anywhere — and `spent=` unqualified reads as what the goal has cost. It is
    // the POT leg only. The scope is omitted when there is no figure to mislabel.
    `Budget: spent=${brief.budget.spentCents ?? 'unknown'}c${
      brief.budget.spentCents == null ? '' : ` [${budgetSpendScope(brief.budget.spentCentsSource)}]`
    } / ${brief.budget.budgetCents ?? 'undeclared'}c${brief.budget.spentCentsAt ? ` at ${brief.budget.spentCentsAt}` : ''}`,
    `Pending: Blender=${brief.pending.blenderIdeas ?? 'unknown'}; rubric=${brief.pending.acceptanceRubric ? `${brief.pending.acceptanceRubric.id}:${brief.pending.acceptanceRubric.status ?? 'unknown'}` : 'none'}`,
    `Continuity: checkpoint=${brief.continuity.checkpoint ? `${brief.continuity.checkpoint.workItemId}@${brief.continuity.checkpoint.updatedAt}` : 'none'}; last-owner-report=${brief.continuity.lastOwnerReportAt ?? 'none'}`,
    ...(brief.degradedReasons.length ? [`DEGRADED — ${brief.degradedReasons.join('; ')}`] : []),
    'GOAL KICKOFF EVIDENCE — REQUIRED BEFORE ANY PORTFOLIO MUTATION',
    `In the current GOAL window, successfully run ${GOAL_KICKOFF_REQUIRED_READS.join(', ')} on the goal's terms; then send an owner-facing report AFTER those reads (coord:send to ["human"] or coord:escalate) that names the exact goal id "${brief.goal.id}".`,
    'Only after those reads and the owner-facing report may you create, launch, or place portfolio work.',
    ...(mandatoryPlacement && mandatoryToolCall
      ? [
          'MANDATORY NEXT PLAN PLACEMENT',
          `${mandatoryPlacement.ref} is the highest-priority eligible worklist plan; placement=${mandatoryPlacement.placement.state}; repair=${mandatoryPlacement.placement.reconciliation.action}.`,
          `Call ${mandatoryToolCall.tool} exactly once with ${JSON.stringify(mandatoryToolCall.args)}.`,
          'Do not claim its plan item from the GOAL session; the one-call fleet door owns promotion, admission, scheduler custody, and spawned leadership.',
        ]
      : []),
    'CURRENT ACTION PRIORITIES',
    priorities,
    'This snapshot is orientation, not write authority: refresh the targeted canonical read immediately before each mutation.',
  ].join('\n');
}

/**
 * Assemble the authoritative GOAL portfolio projection. The launch-policy row is
 * supplied by resolveGoalLaunchForGoal so a holder launch does not re-read it;
 * coord:orient omits it and pays the same canonical read here.
 */
export async function readGoalPortfolioBrief(args: {
  workspaceId: string;
  goalId: string;
  sql?: Sql;
  now?: Date;
  launch?: {
    goalBrief: GoalLaunchBrief;
    settings: GoalLaunchSettings | null;
    budget: GoalBudgetTruth | null;
    ceilings: { maxAgents: number | null; maxPerFleet: number | null };
    headcount: GoalHeadcount;
    degradedReasons?: string[];
  };
}): Promise<GoalPortfolioBrief | null> {
  const degradedReasons = [...(args.launch?.degradedReasons ?? [])];
  let launch = args.launch;
  if (!launch) {
    const policy = await readGoalLaunchSettings(args.goalId, args.sql);
    if (!policy.brief) return null;
    if (policy.error) degradedReasons.push(`launch policy read degraded: ${policy.error}`);
    const ceilings = {
      maxAgents: resolveCeiling(policy.settings?.maxAgents, GOAL_LAUNCH_DEFAULTS.maxAgents),
      maxPerFleet: resolveCeiling(policy.settings?.maxPerFleet, GOAL_LAUNCH_DEFAULTS.maxPerFleet),
    };
    const counted = await goalHeadcount({
      workspaceId: args.workspaceId,
      goalId: args.goalId,
      fleetSlug: policy.drainFleetSlug,
      sql: args.sql,
    });
    if (counted.error) degradedReasons.push(`headcount degraded: ${counted.error}`);
    launch = {
      goalBrief: policy.brief,
      settings: policy.settings,
      budget: policy.budget,
      ceilings,
      headcount: counted.headcount,
    };
  }
  const sql = pg(args.sql);
  let liveHolderOwnerIds: string[] = [];
  try {
    // A durable GOAL mode row is not evidence that its session is still alive.
    // Reuse the canonical holder+liveness fold before attributing current
    // reports or Blender work; otherwise a dead holder's stale row keeps both
    // counters attached to it indefinitely.
    const { resolveGoalHolders } = await import('./goals/holder');
    const holders = await resolveGoalHolders(sql, {
      workspaceId: args.workspaceId,
      goalId: args.goalId,
    });
    liveHolderOwnerIds = holders.live.map((holder) => holder.ownerId);
    if (holders.liveness === 'unknown') {
      degradedReasons.push(
        'goal holder liveness unavailable; holder-scoped report and Blender counts may be incomplete',
      );
    }
  } catch (error) {
    degradedReasons.push(`goal holder liveness read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const rows = await sql<GoalPortfolioSourceRow[]>`
      WITH goal_row AS (
        SELECT * FROM harness_shared.goals
         WHERE workspace_id = ${args.workspaceId} AND id = ${args.goalId}
         LIMIT 1
      )
      SELECT g.status, g.parent_id, g.tripwires, g.properties, g.metadata,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'harness', gp.harness_slug, 'role', gp.role, 'note', gp.note
                     ) ORDER BY (gp.role = 'owner') DESC, gp.added_at), '[]'::jsonb)
                FROM harness_shared.goal_pots gp
               WHERE gp.workspace_id = g.workspace_id AND gp.goal_id = g.id AND gp.removed_at IS NULL) AS pots,
             (SELECT COALESCE(jsonb_agg(plan_row ORDER BY (plan_row->>'ordinal')::int), '[]'::jsonb)
                FROM (
                  SELECT jsonb_build_object(
                           'ref', wr.ref, 'ordinal', wr.ordinality,
                           'harness', p.harness_slug,
                           'slug', regexp_replace(wr.ref, '^plan:(?:[^/]+/)?', ''),
                           'title', p.title, 'status', COALESCE(p.op_status, p.status),
                           'ambiguousMatches', (
                             SELECT count(*) FROM harness_shared.harness_plans matches
                              WHERE matches.workspace_id = g.workspace_id
                                AND matches.plan_slug = regexp_replace(wr.ref, '^plan:(?:[^/]+/)?', '')
                           ),
                           'items', COALESCE((
                             SELECT jsonb_agg(jsonb_build_object(
                                      'id', pi.item_id, 'text', pi.item_text, 'status', pi.status,
                                      'phase', pi.phase, 'blockedBy', pi.blocked_by, 'seq', pi.seq
                                    ) ORDER BY pi.seq)
                               FROM harness_shared.plan_items pi
                              WHERE pi.workspace_id = p.workspace_id
                                AND pi.harness_slug = p.harness_slug
                                AND pi.plan_slug = p.plan_slug
                           ), '[]'::jsonb),
                           'placement', jsonb_build_object(
                             'claims', COALESCE((
                               SELECT jsonb_agg(jsonb_build_object(
                                        'itemId', pic.item_id,
                                        'ownerId', pic.owner,
                                        'expiresAt', pic.expires_ts,
                                        'fleetSlug', claim_presence.fleet_slug,
                                        'holderLive', claim_presence.heartbeat_at >= now() - interval '10 minutes'
                                      ) ORDER BY pic.item_id)
                                 FROM harness_shared.plan_item_claims pic
                                 LEFT JOIN LATERAL (
                                   SELECT cp.fleet_slug, cp.heartbeat_at
                                     FROM harness_shared.coord_presence cp
                                    WHERE cp.workspace_id = ANY(ARRAY[g.workspace_id, 'default', '*']::text[])
                                      AND cp.owner_id = pic.owner
                                    ORDER BY cp.heartbeat_at DESC
                                    LIMIT 1
                                 ) claim_presence ON true
                                WHERE pic.workspace_id = ANY(ARRAY[g.workspace_id, 'default', '*']::text[])
                                  AND pic.harness_slug = p.harness_slug
                                  AND pic.plan_slug = p.plan_slug
                                  AND pic.expires_ts > now()
                             ), '[]'::jsonb),
                             'fleet', (
                               SELECT jsonb_build_object(
                                        'slug', af.fleet_slug,
                                        'controlState', af.control_state,
                                        'leaderOwnerId', af.leader_owner_id,
                                        'leaderLive', leader_presence.heartbeat_at >= now() - interval '10 minutes',
                                        'liveMembers', (
                                          SELECT count(DISTINCT member_presence.owner_id)
                                            FROM harness_shared.coord_presence member_presence
                                           WHERE member_presence.workspace_id = ANY(ARRAY[g.workspace_id, 'default', '*']::text[])
                                             AND member_presence.fleet_slug = af.fleet_slug
                                             AND member_presence.heartbeat_at >= now() - interval '10 minutes'
                                        ),
                                        'target', af.headcount_target,
                                        'launchTransaction', af.last_launch_transaction
                                      )
                                 FROM harness_shared.agent_fleets af
                                 LEFT JOIN LATERAL (
                                   SELECT cp.heartbeat_at
                                     FROM harness_shared.coord_presence cp
                                    WHERE cp.workspace_id = ANY(ARRAY[g.workspace_id, 'default', '*']::text[])
                                      AND cp.owner_id = af.leader_owner_id
                                    ORDER BY cp.heartbeat_at DESC
                                    LIMIT 1
                                 ) leader_presence ON true
                                WHERE af.workspace_id = g.workspace_id
                                  AND (CASE jsonb_typeof(af.headcount_config)
                                         WHEN 'string' THEN (af.headcount_config #>> '{}')::jsonb
                                         ELSE af.headcount_config
                                       END)->>'plan' = p.plan_slug
                                  AND (CASE jsonb_typeof(af.headcount_config)
                                         WHEN 'string' THEN (af.headcount_config #>> '{}')::jsonb
                                         ELSE af.headcount_config
                                       END)->>'harness' = p.harness_slug
                                ORDER BY af.updated_at DESC
                                LIMIT 1
                             )
                           )
                         ) AS plan_row
                    FROM jsonb_array_elements_text(COALESCE(g.properties->'worklist'->'value', '[]'::jsonb))
                         WITH ORDINALITY AS wr(ref, ordinality)
                    LEFT JOIN LATERAL (
                      SELECT hp.* FROM harness_shared.harness_plans hp
                       WHERE hp.workspace_id = g.workspace_id
                         AND hp.plan_slug = regexp_replace(wr.ref, '^plan:(?:[^/]+/)?', '')
                         AND (
                           position('/' in regexp_replace(wr.ref, '^plan:', '')) = 0
                           OR hp.harness_slug = split_part(regexp_replace(wr.ref, '^plan:', ''), '/', 1)
                         )
                       ORDER BY hp.updated_at DESC NULLS LAST
                       LIMIT 1
                    ) p ON true
                ) plans) AS plans,
             (SELECT jsonb_build_object(
                       'total', count(*),
                       'terminal', count(*) FILTER (WHERE wi.status = ANY(ARRAY['done','passed','resolved','closed','deprecated','dropped']::text[])),
                       'inFlight', count(*) FILTER (WHERE wi.taken_by IS NOT NULL AND wi.status <> ALL(ARRAY['done','passed','resolved','closed','deprecated','dropped']::text[])),
                       'blocked', count(*) FILTER (WHERE wi.status IN ('blocked','cursed')),
                       'needsHuman', count(*) FILTER (WHERE wi.status IN ('needs-human','needs_human') OR COALESCE((wi.payload->>'needsHuman')::boolean, false)),
                       'issueCandidates', COALESCE(jsonb_agg(jsonb_build_object('id', wi.feature_id, 'harness', wi.harness_slug))
                         FILTER (WHERE wi.item_kind IN ('bug','change','task') AND wi.taken_by IS NULL AND wi.status IN ('open','failing','todo')), '[]'::jsonb)
                     )
                FROM harness_shared.work_items wi
               WHERE wi.workspace_id = g.workspace_id AND wi.goal_id = g.id) AS queue,
             (SELECT jsonb_build_object(
                       'slug', af.fleet_slug, 'controlState', af.control_state,
                       'leaderOwnerId', af.leader_owner_id,
                       'live', count(cp.owner_id) FILTER (WHERE cp.heartbeat_at >= now() - interval '10 minutes'),
                       'working', count(cp.owner_id) FILTER (WHERE cp.heartbeat_at >= now() - interval '10 minutes' AND EXISTS (
                         SELECT 1 FROM harness_shared.work_items wi2 WHERE wi2.workspace_id = g.workspace_id AND wi2.goal_id = g.id AND wi2.taken_by = cp.owner_id
                       ))
                     )
                FROM harness_shared.agent_fleets af
                LEFT JOIN harness_shared.coord_presence cp
                  ON cp.workspace_id = af.workspace_id AND cp.fleet_slug = af.fleet_slug
               WHERE af.workspace_id = g.workspace_id AND af.fleet_slug = g.metadata->>'drainFleet'
               GROUP BY af.fleet_slug, af.control_state, af.leader_owner_id) AS drain_fleet,
             (SELECT jsonb_build_object(
                       'workItemId', wi3.feature_id, 'updatedAtMs', cn.updated_ts, 'note', cn.note
                     )
                FROM harness_shared.work_items wi3
                JOIN harness_shared.carry_notes cn
                  ON cn.workspace_id = wi3.workspace_id
                 AND cn.scope = 'workitem:' || COALESCE(NULLIF(wi3.harness_slug, ''), '*') || ':' || wi3.feature_id
               WHERE wi3.workspace_id = g.workspace_id AND wi3.goal_id = g.id
               ORDER BY cn.updated_ts DESC LIMIT 1) AS checkpoint,
             (SELECT to_char(max(report_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                FROM (
                  SELECT max(e.ts) AS report_at FROM harness_shared.coord_event_log e
                   WHERE e.workspace_id = g.workspace_id AND e.surface = 'escalations'
                     AND e.body->>'from' = ANY(${liveHolderOwnerIds}::text[])
                  UNION ALL
                  SELECT max(a.created_at) FROM harness_shared.attention_notifications a
                   WHERE a.workspace_id = g.workspace_id AND a.data->>'goalId' = g.id
                ) reports) AS last_owner_report_at,
             (SELECT count(*) FROM harness_shared.scout_routed_ideas sri
               WHERE sri.workspace_id = g.workspace_id AND sri.origin = 'su-ideate'
                 AND sri.created_by = ANY(${liveHolderOwnerIds}::text[])
                 AND (sri.outcome IS NULL OR sri.outcome = 'pending')) AS blender_pending,
             (SELECT jsonb_build_object(
                       'id', hp.plan_slug, 'status', hp.status,
                       'latestScorecardAt', (
                         SELECT to_char(max(sc.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                           FROM harness_shared.engineer_issues sc
                          WHERE sc.workspace_id = g.workspace_id
                            AND sc.payload->'observation'->>'rubricRef' = hp.plan_slug
                            AND sc.payload->'observation'->'subject'->>'ref' = g.id
                       )
                     )
                FROM harness_shared.harness_plans hp
               WHERE hp.workspace_id = g.workspace_id AND hp.template = 'rubric'
                 AND hp.template_slug IS NULL
                 AND hp.template_data->>'kind' = 'acceptance'
                 AND hp.template_data->>'subjectGoal' = g.id
               ORDER BY hp.updated_at DESC LIMIT 1) AS acceptance_rubric
        FROM goal_row g`;
    const row = rows[0];
    if (!row) return null;

    const queueRaw = portfolioObject(row.queue) ?? {};
    const candidates = portfolioArray(queueRaw.issueCandidates)
      .map(portfolioObject)
      .filter((candidate): candidate is Record<string, unknown> => candidate !== null);
    let claimable: number | null = candidates.length === 0 ? 0 : null;
    let claimabilityScope: GoalPortfolioBrief['queue']['claimabilityScope'] =
      candidates.length === 0 ? 'none' : 'unknown';
    if (candidates.length > 0) {
      try {
        const { explainIssueClaimFloors } = await import('./work-items');
        let admissible = 0;
        const byHarness = new Map<string, string[]>();
        for (const candidate of candidates) {
          const id = portfolioString(candidate.id);
          const harness = portfolioString(candidate.harness);
          if (!id || !harness) continue;
          byHarness.set(harness, [...(byHarness.get(harness) ?? []), id]);
        }
        for (const [harness, ids] of byHarness) {
          const floors = await explainIssueClaimFloors(harness, ids);
          admissible += floors.filter((floor) => floor.admissible).length;
        }
        claimable = admissible;
        claimabilityScope = 'issue-family';
      } catch (error) {
        degradedReasons.push(
          `goal-scoped claimability unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const assembledAt = args.now ?? new Date();
    const worklist = parsePortfolioWorklist(row.plans, assembledAt);
    for (const plan of worklist) {
      if (!plan.title) degradedReasons.push(`worklist ref ${plan.ref} does not resolve`);
      if (plan.ambiguousMatches > 1 && !plan.ref.slice('plan:'.length).includes('/')) {
        degradedReasons.push(`worklist ref ${plan.ref} is ambiguous across ${plan.ambiguousMatches} harnesses`);
      }
    }
    const pots = portfolioArray(row.pots).flatMap((value) => {
      const pot = portfolioObject(value);
      const harness = portfolioString(pot?.harness);
      if (!pot || !harness) return [];
      return [
        {
          harness,
          role: pot.role === 'owner' ? ('owner' as const) : ('contributing' as const),
          note: portfolioString(pot.note),
        },
      ];
    });
    const fleetRaw = portfolioObject(row.drain_fleet);
    const declaredFleet = portfolioString(portfolioObject(row.metadata)?.drainFleet);
    const checkpointRaw = portfolioObject(row.checkpoint);
    const rubricRaw = portfolioObject(row.acceptance_rubric);
    const tripwires = portfolioArray(row.tripwires).flatMap((value) => {
      const tripwire = portfolioObject(value);
      const metric = portfolioString(tripwire?.metric);
      if (!tripwire || !metric) return [];
      return [
        {
          metric,
          ...(portfolioString(tripwire.label) ? { label: portfolioString(tripwire.label)! } : {}),
          ...(tripwire.threshold != null ? { threshold: portfolioNumber(tripwire.threshold) } : {}),
          ...(tripwire.current != null ? { current: portfolioNumber(tripwire.current) } : {}),
          ...(portfolioString(tripwire.unit) ? { unit: portfolioString(tripwire.unit)! } : {}),
        },
      ];
    });
    const queue = {
      total: portfolioNumber(queueRaw.total),
      terminal: portfolioNumber(queueRaw.terminal),
      inFlight: portfolioNumber(queueRaw.inFlight),
      blocked: portfolioNumber(queueRaw.blocked),
      needsHuman: portfolioNumber(queueRaw.needsHuman),
      claimable,
      claimabilityScope,
    };
    const priorities: string[] = [];
    if (!declaredFleet) priorities.push('Declare and delegate the standing drain fleet.');
    else if (!fleetRaw || portfolioNumber(fleetRaw.live) === 0)
      priorities.push(`Restore delegated leadership and live coverage for drain fleet ${declaredFleet}.`);
    if (queue.needsHuman > 0) priorities.push(`Report ${queue.needsHuman} owner-walled queue item(s) with exact asks.`);
    const executablePlacement = worklist.find((plan) => plan.placement.reconciliation.toolCall !== null);
    const repairPlan =
      executablePlacement ?? worklist.find((plan) => plan.placement.reconciliation.action !== 'none');
    if (repairPlan) priorities.push(`Reconcile ${repairPlan.ref}: ${repairPlan.placement.reconciliation.reason}`);
    if ((claimable ?? 0) > 0)
      priorities.push(`Place ${claimable} goal-scoped claimable issue(s) without implementing them yourself.`);
    if (queue.blocked > 0)
      priorities.push(`Triage ${queue.blocked} blocked/cursed queue item(s) and remove stranded blockers.`);
    if (portfolioNumber(row.blender_pending) > 0)
      priorities.push(`Grade or route ${portfolioNumber(row.blender_pending)} pending Blender idea(s).`);
    if (priorities.length === 0)
      priorities.push('Refresh the worklist and queue, then continue supervision; do not self-implement.');

    return {
      schemaVersion: 1,
      assembledAt: assembledAt.toISOString(),
      goal: {
        id: args.goalId,
        title: launch.goalBrief.title,
        status: portfolioString(row.status),
        body: launch.goalBrief.body,
        killCriterion: launch.goalBrief.killCriterion,
        standing: launch.goalBrief.standing,
        parentId: portfolioString(row.parent_id),
      },
      worklist,
      pots,
      drainFleet: {
        slug: declaredFleet,
        exists: declaredFleet ? Boolean(fleetRaw) : null,
        controlState: portfolioString(fleetRaw?.controlState),
        leaderOwnerId: portfolioString(fleetRaw?.leaderOwnerId),
        live: fleetRaw ? portfolioNumber(fleetRaw.live) : null,
        working: fleetRaw ? portfolioNumber(fleetRaw.working) : null,
      },
      queue,
      launch: { settings: launch.settings, ceilings: launch.ceilings, headcount: launch.headcount },
      budget: {
        budgetCents: launch.budget?.budgetCents ?? launch.goalBrief.budgetCents,
        spentCents: launch.budget?.spentCents ?? null,
        spentCentsAt: launch.budget?.spentCentsAt ?? null,
        spentCentsSource: launch.budget?.spentCentsSource ?? null,
        budgetWindowSec: launch.goalBrief.budgetWindowSec,
      },
      tripwires,
      pending: {
        blenderIdeas: row.blender_pending == null ? null : portfolioNumber(row.blender_pending),
        acceptanceRubric:
          rubricRaw && portfolioString(rubricRaw.id)
            ? {
                id: portfolioString(rubricRaw.id)!,
                status: portfolioString(rubricRaw.status),
                latestScorecardAt: portfolioString(rubricRaw.latestScorecardAt),
              }
            : null,
      },
      continuity: {
        checkpoint:
          checkpointRaw && portfolioString(checkpointRaw.workItemId)
            ? {
                workItemId: portfolioString(checkpointRaw.workItemId)!,
                updatedAt: new Date(portfolioNumber(checkpointRaw.updatedAtMs)).toISOString(),
                note: portfolioString(checkpointRaw.note) ?? '',
              }
            : null,
        lastOwnerReportAt: portfolioString(row.last_owner_report_at),
      },
      priorities: priorities.slice(0, 6),
      degradedReasons: [...new Set(degradedReasons)],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      assembledAt: (args.now ?? new Date()).toISOString(),
      goal: {
        id: args.goalId,
        title: launch.goalBrief.title,
        status: null,
        body: launch.goalBrief.body,
        killCriterion: launch.goalBrief.killCriterion,
        standing: launch.goalBrief.standing,
        parentId: null,
      },
      worklist: [],
      pots: [],
      drainFleet: { slug: null, exists: null, controlState: null, leaderOwnerId: null, live: null, working: null },
      queue: {
        total: 0,
        terminal: 0,
        inFlight: 0,
        blocked: 0,
        needsHuman: 0,
        claimable: null,
        claimabilityScope: 'unknown',
      },
      launch: { settings: launch.settings, ceilings: launch.ceilings, headcount: launch.headcount },
      budget: {
        budgetCents: launch.budget?.budgetCents ?? launch.goalBrief.budgetCents,
        spentCents: launch.budget?.spentCents ?? null,
        spentCentsAt: launch.budget?.spentCentsAt ?? null,
        spentCentsSource: launch.budget?.spentCentsSource ?? null,
        budgetWindowSec: launch.goalBrief.budgetWindowSec,
      },
      tripwires: [],
      pending: { blenderIdeas: null, acceptanceRubric: null },
      continuity: { checkpoint: null, lastOwnerReportAt: null },
      priorities: ['Re-read the goal portfolio before any placement or write.'],
      degradedReasons: [
        ...new Set([
          ...degradedReasons,
          `portfolio read failed: ${error instanceof Error ? error.message : String(error)}`,
        ]),
      ],
    };
  }
}

/**
 * The goal-owned fields needed to brief a freshly launched holder.
 *
 * This rides the SAME row read as launch settings and budget truth. A holder
 * launch already pays for that read, and keeping the brief there prevents a
 * recovery caller from opening a generic AUTO session before the later GOAL
 * attachment tells it which goal it owns (EI-21640746714079700).
 */
export interface GoalLaunchBrief {
  title: string;
  body: string | null;
  killCriterion: string | null;
  budgetCents: number | null;
  budgetWindowSec: number | null;
  standing: boolean;
  /** P-012: the same authoritative snapshot coord:orient folds on every wake. */
  portfolio?: GoalPortfolioBrief | null;
}

export interface GoalLaunchResolution {
  /** The goal this launch serves, resolved from the LAUNCHER (D-008). Null = no goal in scope. */
  goalId: string | null;
  settings: GoalLaunchSettings | null;
  /** Canonical source fields for the holder's first-turn brief. */
  goalBrief: GoalLaunchBrief | null;
  /** Merged profile: caller request > per-role > goal defaults. Absent keys stay absent. */
  effective: LaunchProfile;
  ceilings: { maxAgents: number | null; maxPerFleet: number | null };
  headcount: GoalHeadcount;
  /** P-006: the goal's budget ceiling + platform spend snapshot. Null = no goal in scope. */
  budget: GoalBudgetTruth | null;
  /** Non-null when this launch would breach a ceiling. The caller MUST NOT launch. */
  refusal: GoalLaunchRefusal | null;
  /** True when a ceiling could not be read or counted, so it was NOT enforced. */
  degraded: boolean;
  degradedReasons: string[];
}

export interface ParsedGoalLaunchSettings {
  /** The document with every KNOWN key in force; null only when it is truly invalid or absent. */
  settings: GoalLaunchSettings | null;
  /** Non-null ⇒ `settings` is null and NOTHING the owner declared is in force. */
  error: string | null;
  /**
   * WI-2140573: dotted paths of keys the strict schema did not recognise, which
   * the lenient READ stripped before re-parsing (`roles.goal.contextSize`).
   * Non-empty with `settings` non-null means every OTHER key IS in force and the
   * caller must surface these LOUDLY (the watchdog escalates, the panel shows
   * them) — never silently, which is the state `.strict()` exists to prevent.
   */
  unknownKeys: string[];
}

/**
 * How many strip-and-re-parse passes the lenient read may take. One pass strips
 * every key zod reported unrecognised at every level it reported; a second is
 * needed only when stripping exposes a strict object underneath, so 3 is
 * generous. A document still failing after that is invalid, not merely newer.
 */
const UNKNOWN_KEY_STRIP_PASSES = 3;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Delete, in place, every key zod reported as `unrecognized_keys`, at the path
 * it reported it. Returns the dotted paths removed. Only ever called on a CLONE
 * of the caller's document — a row's jsonb value is never mutated under it.
 */
function stripUnrecognizedKeys(doc: Record<string, unknown>, issues: readonly z.ZodIssue[]): string[] {
  const stripped: string[] = [];
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    let target: unknown = doc;
    for (const seg of issue.path) {
      target = isPlainObject(target) ? target[String(seg)] : undefined;
    }
    if (!isPlainObject(target)) continue;
    for (const key of issue.keys) {
      if (!Object.hasOwn(target, key)) continue;
      delete target[key];
      stripped.push([...issue.path.map(String), key].join('.'));
    }
  }
  return stripped;
}

/**
 * Validate one stored `launch_settings` value, however it was fetched.
 *
 * Split out from the reader below because there are two legitimate ways to hold
 * that value — this module SELECTs it, and goals.detail already has it on a row
 * it selected for other reasons (P-005) — and only one of them should own what
 * "valid" means. A second `safeParse` at the other call site would be a second
 * place for the definition to move.
 *
 * `null` in, `null` out and NO error: "none declared" is the common case and the
 * correct launch default, not a fault.
 *
 * READ-LENIENT on unknown keys, STRICT on everything else (WI-2140573). The
 * schema's `.strict()` is the WRITE boundary (`writeGoalLaunchSettings`), where
 * refusing a typo is right. On READ the same refusal was a safety-net kill:
 * a key written by a NEWER schema than the reading host runs — measured live
 * when `roles.goal.compactionLimit` landed before bg-host's bundle knew it —
 * made the whole document parse to null, so `holder.onLoss='respawn'` silently
 * stopped being in force on the one goal it protected. So: on failure, strip
 * exactly the keys zod reported unrecognised, re-parse, and REPORT the stripped
 * paths in `unknownKeys`. A document that still fails after stripping (a bad
 * VALUE, not merely a new key) is invalid as before.
 */
export function parseGoalLaunchSettings(raw: unknown, label = 'launch_settings'): ParsedGoalLaunchSettings {
  if (raw == null) return { settings: null, error: null, unknownKeys: [] };
  let doc: unknown;
  try {
    doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    // A string that is not JSON at all lands here rather than in safeParse.
    return {
      settings: null,
      error: `${label} is unreadable: ${e instanceof Error ? e.message : String(e)}`,
      unknownKeys: [],
    };
  }
  const unknownKeys: string[] = [];
  let working: unknown = doc;
  for (let pass = 0; ; pass++) {
    const parsed = goalLaunchSettingsSchema.safeParse(working);
    if (parsed.success) return { settings: parsed.data, error: null, unknownKeys };
    const invalid = `${label} is invalid: ${parsed.error.message}`;
    if (pass >= UNKNOWN_KEY_STRIP_PASSES || !isPlainObject(working)) {
      return { settings: null, error: invalid, unknownKeys };
    }
    // Never mutate the caller's value: it is usually a row still in use.
    if (pass === 0) working = structuredClone(working);
    const stripped = stripUnrecognizedKeys(working as Record<string, unknown>, parsed.error.issues);
    if (!stripped.length) return { settings: null, error: invalid, unknownKeys };
    unknownKeys.push(...stripped);
  }
}

/**
 * Read + validate one goal's launch settings, plus its budget truth (P-006) —
 * one row read for both, because every launch resolution needs both and a
 * second round-trip per launch would be pure overhead. Returns null settings
 * for "none declared" (the common case, and the correct default), and reports
 * invalid stored JSON as an error rather than silently treating a malformed
 * document as absent — a settings blob that fails to parse means the owner's
 * ceiling is NOT in force, which they must hear about.
 */
export async function readGoalLaunchSettings(
  goalId: string,
  sql?: Sql,
): Promise<{
  settings: GoalLaunchSettings | null;
  budget: GoalBudgetTruth | null;
  /** Goal-owned first-turn context, read atomically with its launch policy. */
  brief: GoalLaunchBrief | null;
  /**
   * P-006: the goal's declared drain fleet, for `goalFleetFamily`. Read from the
   * SAME row for the same reason the budget is — the launch boundary needs the
   * family to pick a slot, and a second round-trip per launch to fetch one jsonb
   * key would be pure overhead.
   */
  drainFleetSlug: string | null;
  error: string | null;
  /** WI-2140573: keys the lenient read stripped — see {@link ParsedGoalLaunchSettings.unknownKeys}. */
  unknownKeys: string[];
}> {
  if (!goalId) return { settings: null, budget: null, brief: null, drainFleetSlug: null, error: null, unknownKeys: [] };
  try {
    const rows = await pg(sql)`
      SELECT title, body, kill_criterion, standing,
             launch_settings, budget_cents, budget_window_sec,
             metadata->'spentCents' AS spent_cents,
             metadata->>'spentCentsAt' AS spent_cents_at,
             metadata->>'spentCentsSource' AS spent_cents_source,
             metadata->>'drainFleet' AS drain_fleet
        FROM harness_shared.goals WHERE id = ${goalId} LIMIT 1`;
    if (!rows.length) {
      return { settings: null, budget: null, brief: null, drainFleetSlug: null, error: null, unknownKeys: [] };
    }
    const row = rows[0] as {
      title?: unknown;
      body?: unknown;
      kill_criterion?: unknown;
      standing?: unknown;
      launch_settings?: unknown;
      budget_cents?: unknown;
      budget_window_sec?: unknown;
      spent_cents?: unknown;
      spent_cents_at?: unknown;
      spent_cents_source?: unknown;
      drain_fleet?: unknown;
    };
    const parsed = parseGoalLaunchSettings(row.launch_settings, `goal ${goalId} launch_settings`);
    const title = typeof row.title === 'string' && row.title.trim() ? row.title : null;
    const briefError = title ? null : `goal ${goalId} has no usable title for its holder kickoff`;
    return {
      settings: parsed.settings,
      budget: {
        budgetCents: asFiniteCents(row.budget_cents),
        spentCents: asFiniteCents(row.spent_cents),
        spentCentsAt: typeof row.spent_cents_at === 'string' ? row.spent_cents_at : null,
        spentCentsSource: typeof row.spent_cents_source === 'string' ? row.spent_cents_source : null,
      },
      brief: title
        ? {
            title,
            body: typeof row.body === 'string' ? row.body : null,
            killCriterion: typeof row.kill_criterion === 'string' ? row.kill_criterion : null,
            budgetCents: asFiniteCents(row.budget_cents),
            budgetWindowSec: asFiniteNumber(row.budget_window_sec),
            standing: row.standing === true,
          }
        : null,
      drainFleetSlug: typeof row.drain_fleet === 'string' ? row.drain_fleet : null,
      error: [parsed.error, briefError].filter(Boolean).join('; ') || null,
      unknownKeys: parsed.unknownKeys,
    };
  } catch (e) {
    return {
      settings: null,
      budget: null,
      brief: null,
      drainFleetSlug: null,
      error: e instanceof Error ? e.message : String(e),
      unknownKeys: [],
    };
  }
}

/** What the fleet-launch boundary needs from a goal BEFORE any headcount is known. */
export interface GoalLaunchSettingsRead {
  goalId: string | null;
  settings: GoalLaunchSettings | null;
  /** The goal's declared drain fleet, for `goalFleetFamily`. */
  drainFleetSlug: string | null;
  degraded: boolean;
  degradedReasons: string[];
}

/**
 * The goal's SETTINGS ONLY — no ceilings, no budget gate, no side effects (D-004).
 *
 * WHY THIS EXISTS RATHER THAN A SECOND `resolveGoalLaunch` CALL. The fleet-launch
 * door has to know the goal's `fleetType` and per-role profiles at the OPTION
 * boundary, which runs before the capacity clamp — so before `openCount`, the
 * number the D-005 ceilings are checked against, exists at all. `resolveGoalLaunch`
 * cannot be called there:
 *
 *   - it refuses on `count`, so calling it early with a provisional count would
 *     either double-count the fleet's headcount or refuse a launch that fits;
 *   - it has a live SIDE EFFECT — `escalateBudgetRefusal` opens an owner
 *     escalation — so a speculative second call can page the owner about a launch
 *     that was never actually attempted.
 *
 * So the two reads are split by PURPOSE, not duplicated: this one answers "what
 * shape did the goal ask for", early and freely; `resolveGoalLaunch` still answers
 * "may this many agents start", once, late, with the true count. Both derive the
 * goal from the LAUNCHER (D-008/D-009) rather than taking a `goalId` argument a
 * door could forget to pass.
 *
 * Fail-soft like every other read here: a goal that cannot be resolved yields no
 * settings and a degraded reason, never a thrown launch.
 */
/**
 * Is this an authority error that a FAIL-SOFT launch READ must still refuse?
 *
 * `GoalHolderAuthorityError` has covered two very different conditions since
 * 02d9c38d1f: a `superseded` VERDICT — the authority store spoke, and said this
 * owner is not the holder — and an `unreadable` STORE, which could not speak at
 * all. Only the verdict is an authority violation.
 *
 * The read doors below are documented fail-soft ("never a thrown launch"), so
 * rethrowing the storage failure there turns a transient DB blip into a hard
 * launch failure — and, because `pg()` refuses a real connection under Vitest,
 * it red-ed 94 launch-on-plan unit tests (WI-1195329).
 *
 * The MUTATION fence in `assertGoalHolderMutationAuthority` still refuses BOTH,
 * which is correct and deliberately untouched: on a write path, absence of
 * evidence must not become authority.
 */
function isFatalGoalHolderVerdict(e: unknown): boolean {
  return isGoalHolderAuthorityError(e) && e.code === 'goal_holder_superseded';
}

export async function readGoalLaunchSettingsForLauncher(args: {
  workspaceId: string;
  launcherOwnerId: string;
  sql?: Sql;
}): Promise<GoalLaunchSettingsRead> {
  const degradedReasons: string[] = [];
  let goalId: string | null = null;
  try {
    goalId = await resolveGoalContext(args.workspaceId, args.launcherOwnerId, args.sql);
  } catch (e) {
    if (isFatalGoalHolderVerdict(e)) throw e;
    degradedReasons.push(`goal context unresolved: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!goalId) {
    return {
      goalId: null,
      settings: null,
      drainFleetSlug: null,
      degraded: degradedReasons.length > 0,
      degradedReasons,
    };
  }
  const { settings, drainFleetSlug, error } = await readGoalLaunchSettings(goalId, args.sql);
  if (error) degradedReasons.push(`launch settings not applied: ${error}`);
  return {
    goalId,
    settings,
    drainFleetSlug,
    degraded: degradedReasons.length > 0,
    degradedReasons,
  };
}

/**
 * May a goal-scoped launcher place work in this harness?
 *
 * A `goal_pots.role='owner'` row is not sufficient on its own: terminal goals
 * intentionally retain their relationship history, so a killed owner's live
 * edge must not make the primary harness look permanently occupied.  The
 * authority question is therefore the intersection of the live edge and an
 * ACTIVE goal.  This is the shared read behind launch-time sovereignty checks;
 * callers must not reimplement it against `goal_pots` alone.
 */
export interface GoalPotPlacementAuthority {
  allowed: boolean;
  reason: 'no-active-owner' | 'caller-goal-owns-pot' | 'different-active-goal-owns-pot';
  ownerGoalId: string | null;
  ownerGoalTitle: string | null;
}

export async function resolveGoalPotPlacementAuthority(args: {
  workspaceId: string;
  launcherGoalId: string;
  harnessSlug: string;
  sql?: Sql;
}): Promise<GoalPotPlacementAuthority> {
  const sql = pg(args.sql);
  const rows = await sql<Array<{ owner_goal_id: string; owner_goal_title: string | null }>>`
    SELECT gp.goal_id AS owner_goal_id, g.title AS owner_goal_title
      FROM harness_shared.goal_pots gp
      JOIN harness_shared.goals g
        ON g.workspace_id = gp.workspace_id
       AND g.id = gp.goal_id
     WHERE gp.workspace_id = ${args.workspaceId}
       AND gp.harness_slug = ${args.harnessSlug}
       AND gp.role = 'owner'
       AND gp.removed_at IS NULL
       AND g.status = 'active'
     ORDER BY gp.added_at DESC
     LIMIT 2
  `;
  const owner = rows[0] ?? null;
  if (!owner) {
    return {
      allowed: true,
      reason: 'no-active-owner',
      ownerGoalId: null,
      ownerGoalTitle: null,
    };
  }
  if (owner.owner_goal_id === args.launcherGoalId) {
    return {
      allowed: true,
      reason: 'caller-goal-owns-pot',
      ownerGoalId: owner.owner_goal_id,
      ownerGoalTitle: owner.owner_goal_title,
    };
  }
  return {
    allowed: false,
    reason: 'different-active-goal-owns-pot',
    ownerGoalId: owner.owner_goal_id,
    ownerGoalTitle: owner.owner_goal_title,
  };
}

/**
 * `budget_cents` is a bigint (postgres-js hands it over as a string);
 * `metadata->'spentCents'` is a jsonb scalar (a number when the rollup wrote
 * it, but historically agent-written values could be anything). Anything not a
 * finite number is null — "unknown", never 0, because 0 would read as "nothing
 * spent" and admit a launch on garbage.
 */
function asFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function asFiniteCents(v: unknown): number | null {
  return asFiniteNumber(v);
}

/**
 * Replace one goal's launch settings. Pass null to clear them back to "none
 * declared". Validates before writing so an invalid document can never reach the
 * column — the read path's parse failure is for rows written before this
 * existed, not a licence to write junk.
 */
export async function writeGoalLaunchSettings(
  goalId: string,
  settings: GoalLaunchSettings | null,
  sql?: Sql,
): Promise<{ ok: boolean; error: string | null }> {
  if (!goalId) return { ok: false, error: 'goalId is required' };
  let payload: string | null = null;
  if (settings != null) {
    const parsed = goalLaunchSettingsSchema.safeParse(settings);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    payload = JSON.stringify(parsed.data);
  }
  try {
    await pg(sql)`
      UPDATE harness_shared.goals
         SET launch_settings = ${payload}::jsonb, updated_at = now()
       WHERE id = ${goalId}`;
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Declare (or revise) ONE goal's holder policy, leaving the rest of its launch
 * settings alone — the remediation P-003's refusals name.
 *
 * WHY THIS EXISTS RATHER THAN "JUST CALL writeGoalLaunchSettings". That writer
 * REPLACES the whole document, which is right for `goals:update
 * { launchSettings }` (the owner is editing the document as a document) and
 * wrong for every caller who only wants to answer the holder question: sending
 * `{ holder }` alone silently drops the goal's ceilings and launch profile. A
 * refusal whose stated fix destroys a ceiling is worse than the refusal, so the
 * fix gets its own merge-safe door.
 *
 * Read-modify-write, not a jsonb merge in SQL, so the merged document goes
 * through the SAME validation as any other write — the point of the strict
 * schema is that no path may install a typo'd key, including this one.
 */
export async function declareGoalHolderPolicy(
  goalId: string,
  holder: GoalHolderPolicy,
  sql?: Sql,
): Promise<{ ok: boolean; error: string | null }> {
  if (!goalId) return { ok: false, error: 'goalId is required' };
  const current = await readGoalLaunchSettings(goalId, sql);
  // A stored document that does not parse is NOT overwritten: it may hold a
  // ceiling the owner is relying on, and merging into `{}` would erase it while
  // reporting success. The caller hears the parse error instead.
  if (current.error) return { ok: false, error: current.error };
  return writeGoalLaunchSettings(goalId, { ...(current.settings ?? {}), holder }, sql);
}

/**
 * Live headcounts for a goal, and optionally for one of its fleets.
 *
 * The population is `session_briefs.goal_id` — every session whose WORK BELONGS
 * TO the goal — joined to presence for liveness. This is computable only because
 * of P-002: before that column existed the sole session attributable to a goal
 * was the goal's own agent, so D-005's "ALL agent sessions associated with that
 * goal" could not have been counted at all.
 *
 * A session counts when its heartbeat is fresh, OR when it was launched inside
 * the boot grace and has not yet registered presence. The second leg is what
 * makes a burst of concurrent launches converge instead of every one of them
 * reading zero.
 */
export async function goalHeadcount(args: {
  workspaceId: string;
  goalId: string;
  fleetSlug?: string | null;
  sql?: Sql;
}): Promise<{ headcount: GoalHeadcount; error: string | null }> {
  const empty: GoalHeadcount = { total: 0, fleet: args.fleetSlug ? 0 : null };
  if (!args.workspaceId || args.workspaceId === '*' || !args.goalId) {
    return { headcount: empty, error: null };
  }
  const staleSecs = Math.max(1, Math.floor(GOAL_HEADCOUNT_STALE_MS / 1000));
  const graceSecs = Math.max(1, Math.floor(GOAL_HEADCOUNT_BOOT_GRACE_MS / 1000));
  try {
    const rows = await pg(args.sql)`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE p.fleet_slug = ${args.fleetSlug || ''})::int AS fleet
      FROM harness_shared.session_briefs b
      LEFT JOIN harness_shared.coord_presence p ON p.owner_id = b.owner_id
      WHERE b.workspace_id = ${args.workspaceId}
        AND b.goal_id = ${args.goalId}
        AND (
          p.heartbeat_at > now() - ${`${staleSecs} seconds`}::interval
          OR (p.owner_id IS NULL AND b.updated_at > now() - ${`${graceSecs} seconds`}::interval)
        )`;
    const r = (rows[0] ?? {}) as { total?: unknown; fleet?: unknown };
    return {
      headcount: {
        total: Number(r.total ?? 0),
        fleet: args.fleetSlug ? Number(r.fleet ?? 0) : null,
      },
      error: null,
    };
  } catch (e) {
    return { headcount: empty, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * P-006: is the budget launch gate on? Tri-state on purpose: `infraError`
 * distinguishes "the owner turned it off" (deliberate config — silent) from
 * "the flag could not be read" (a declared budget silently unenforced — which
 * the resolution must report as degraded, same principle as an uncountable
 * ceiling). Fail OPEN on error, per the module header: a broken flag read must
 * not brick every launch in the workspace.
 *
 * Dynamic imports keep the flags dependency out of this module's static graph —
 * the same reasoning as the presence-window copy above (this module rides in
 * every launch path), and the same shape as windDownDispositionGateEnabled.
 */
async function budgetLaunchGateEnabled(): Promise<{ enabled: boolean; infraError: string | null }> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([import('@papercusp/flags/server'), import('@papercusp/flags')]);
    return { enabled: await getFlag(FLAGS.GOAL_BUDGET_LAUNCH_GATE, 'system'), infraError: null };
  } catch (e) {
    return { enabled: false, infraError: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * P-006: tell the owner their goal's budget is exhausted and launches are being
 * refused. Fire-and-forget: an escalation write must never delay or fail the
 * launch path (the refusal itself is already returned synchronously). Deduped
 * per goal ({dedupKind, subjectSignature}) so every subsequently refused launch
 * bumps the one card instead of stacking a new one — the
 * deliverGoalWindDownReport pattern.
 */
function escalateBudgetRefusal(args: {
  workspaceId: string;
  goalId: string;
  launcherOwnerId?: string | null;
  refusal: GoalLaunchRefusal;
}): void {
  void (async () => {
    const { openEscalation } = await import('./agent-tools/coordination/escalations');
    await openEscalation(
      {
        // Attributed to the refused launcher when known; otherwise the gate
        // itself. 'principal' = in-process caller, the closest source for a
        // platform gate speaking for itself.
        ownerId: args.launcherOwnerId || `goal-budget-gate:${args.goalId}`,
        ownerLabel: 'goal budget launch gate',
        source: 'principal',
        workspaceId: args.workspaceId,
        userId: null,
      },
      {
        // 'blocker': launches are actively being refused until the owner raises
        // the budget or winds the goal down (EscalationSeverity has no 'major').
        severity: 'blocker',
        summary: `goal ${args.goalId}: budget exhausted — further launches refused`,
        body: args.refusal.message,
        meta: {
          dedupKind: 'goal-budget-exceeded',
          subjectSignature: `${args.workspaceId}:${args.goalId}`,
          goalId: args.goalId,
          budgetCents: args.refusal.limit,
          spentCents: args.refusal.current,
        },
      },
    );
  })().catch((e: unknown) => {
    console.warn(
      `[goal-budget-gate] owner escalation failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

/**
 * Fold a goal's stored profiles into the effective one for a role.
 *
 * Precedence, most specific first: what the CALLER explicitly asked for, then the
 * per-role profile, then the goal's defaults. An explicitly requested value
 * always wins — the settings are the goal agent's standing policy, not an
 * override of a decision it just made deliberately for one launch.
 *
 * Absent stays absent: a key nobody set is left off so the launch composer
 * applies the SYSTEM default (e.g. `defaultLaunchAccount()`), rather than this
 * function inventing a value and pinning it.
 */
export function foldLaunchProfile(
  settings: GoalLaunchSettings | null,
  goalRole: GoalLaunchRole | null | undefined,
  requested?: LaunchProfile | null,
): LaunchProfile {
  const out: LaunchProfile = {};
  const layers: Array<LaunchProfile | undefined> = [
    settings?.defaults,
    goalRole ? settings?.roles?.[goalRole] : undefined,
    requested ?? undefined,
  ];
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * THE resolver every launch path calls.
 *
 * Note what it does NOT take: a `goalId`. It derives one from the launcher, so
 * no door can drop goal context by forgetting an argument (D-008/D-009).
 *
 * `count` is how many agents this launch intends to start, so a fleet asking for
 * 10 seats against a ceiling with room for 3 is refused ONCE here rather than
 * discovering it on the 4th spawn with 3 half-briefed members already running.
 */
export async function resolveGoalLaunch(args: {
  workspaceId: string;
  /** The owner id of the agent DOING the launching — the goal is derived from it. */
  launcherOwnerId: string;
  /**
   * D-016: the launch SLOT this spawn fills, NOT psu `--role`. Pass null when
   * the door cannot determine one — an absent role layer is correct, whereas a
   * psu role here silently mis-binds (that was WI-38048).
   */
  goalRole?: GoalLaunchRole | null;
  fleetSlug?: string | null;
  /** How many agents this launch will start. Default 1. */
  count?: number;
  requested?: LaunchProfile | null;
  sql?: Sql;
}): Promise<GoalLaunchResolution> {
  const degradedReasons: string[] = [];
  let goalId: string | null = null;
  try {
    goalId = await resolveGoalContext(args.workspaceId, args.launcherOwnerId, args.sql);
  } catch (e) {
    if (isFatalGoalHolderVerdict(e)) throw e;
    // resolveGoalContext USED to be fail-soft, so reaching here used to mean
    // something below it broke hard. Since 02d9c38d1f it also refuses when the
    // authority store is merely unreadable, so this leg is now the normal path
    // for a storage blip too (WI-1195329). Either way: no goal context = no
    // ceiling and no profile, which is exactly the pre-P-004 behaviour — but
    // say so, rather than failing the launch.
    degradedReasons.push(`goal context unresolved: ${e instanceof Error ? e.message : String(e)}`);
  }
  return resolveGoalLaunchForGoal({ ...args, goalId, priorDegraded: degradedReasons });
}

/**
 * The same resolution for a goal named EXPLICITLY.
 *
 * Exists for exactly one shape of caller: the door that is MINTING the
 * association rather than inheriting it. `goals:start` launches a goal's own
 * agent, so at that moment the goal is the SUBJECT of the launch and not yet
 * anybody's context — `resolveGoalContext(caller)` correctly returns null there,
 * and the goal's own settings (which model its agent runs at, how many agents it
 * may go on to spawn) must still apply.
 *
 * Prefer {@link resolveGoalLaunch} everywhere else. Taking a `goalId` is exactly
 * the thing a door can forget to pass, which is why the launcher-derived form is
 * the default and this one is the documented exception rather than the general
 * API.
 */
export async function resolveGoalLaunchForGoal(args: {
  workspaceId: string;
  goalId: string | null;
  /** D-016: the launch SLOT, not psu `--role`. See {@link resolveGoalLaunch}. */
  goalRole?: GoalLaunchRole | null;
  fleetSlug?: string | null;
  count?: number;
  requested?: LaunchProfile | null;
  sql?: Sql;
  /** Degraded reasons accumulated by a caller before delegating here. */
  priorDegraded?: string[];
  /**
   * P-006: the owner id of the agent DOING the launching, when known — flows in
   * from {@link resolveGoalLaunch}'s spread. Used ONLY to attribute the budget
   * escalation; never consulted for the decision itself.
   */
  launcherOwnerId?: string | null;
}): Promise<GoalLaunchResolution> {
  const count = Math.max(1, Math.floor(args.count ?? 1));
  const degradedReasons: string[] = [...(args.priorDegraded ?? [])];
  const goalId = args.goalId;
  if (!goalId) {
    return {
      goalId: null,
      settings: null,
      goalBrief: null,
      effective: foldLaunchProfile(null, args.goalRole, args.requested),
      ceilings: { maxAgents: null, maxPerFleet: null },
      headcount: { total: 0, fleet: args.fleetSlug ? 0 : null },
      budget: null,
      refusal: null,
      degraded: degradedReasons.length > 0,
      degradedReasons,
    };
  }

  const {
    settings,
    budget,
    brief: rawGoalBrief,
    error: settingsError,
  } = await readGoalLaunchSettings(goalId, args.sql);
  let goalBrief = rawGoalBrief;
  if (settingsError) degradedReasons.push(`launch settings not applied: ${settingsError}`);

  // P-006 (D-001/D-003): goals.budget_cents is a BINDING ceiling over the
  // platform spend snapshot, checked FIRST — an exhausted budget refuses the
  // launch regardless of agent headroom, and a formed refusal skips the
  // headcount read entirely. Same fail-open stance as the agent ceilings (see
  // the module header): a truth this gate cannot read is reported degraded,
  // never silently enforced and never silently skipped. `>=` and not `>`: the
  // budget is a ceiling, so a goal that has REACHED it is out of budget — an
  // off-by-one here admits one launch past every budget in the workspace.
  let refusal: GoalLaunchRefusal | null = null;
  if (budget?.budgetCents != null) {
    const gate = await budgetLaunchGateEnabled();
    if (gate.infraError) {
      degradedReasons.push(`budget ceiling not enforced — flag read failed: ${gate.infraError}`);
    } else if (gate.enabled) {
      if (budget.spentCents == null) {
        degradedReasons.push(
          `budget ceiling not enforced — goal ${goalId} declares budget_cents=${budget.budgetCents} but has no ` +
            `platform spend snapshot yet (metadata.spentCents is written by the goal-spend-rollup tick; D-003 ` +
            `forbids inventing one)`,
        );
      } else if (budget.spentCents >= budget.budgetCents) {
        const spendScope = budgetSpendScope(budget.spentCentsSource);
        refusal = {
          reason: 'goal_budget_exceeded',
          limit: budget.budgetCents,
          current: budget.spentCents,
          requested: count,
          currentScope: spendScope,
          message:
            // NAME THE POPULATION (P-004). Unqualified, this line reads as the
            // goal's total cost. It is the pot subset — which is why the scope
            // travels in the sentence, not just in the structured field a human
            // reading the refusal will never see.
            `goal ${goalId} has spent ${budget.spentCents} of its ${budget.budgetCents} cent budget ` +
            `[measured over ${spendScope}` +
            `${
              spendScope === REFUSAL_SCOPES.BUDGET_UNVERIFIED
                ? ' — this figure carries no provenance marker, so what it counted is unknown'
                : "; spend billed OUTSIDE this goal's pots is not in this number"
            }]` +
            `${budget.spentCentsAt ? ` (platform snapshot at ${budget.spentCentsAt})` : ''}; further agent/fleet ` +
            `launches are refused. Review spend and raise budget_cents on the goal, or wind the goal down. ` +
            `The owner has an open escalation for this (deduped per goal).`,
        };
        escalateBudgetRefusal({
          workspaceId: args.workspaceId,
          goalId,
          launcherOwnerId: args.launcherOwnerId,
          refusal,
        });
      }
    }
  }

  const effective = foldLaunchProfile(settings, args.goalRole, args.requested);
  // D-015: an unpinned ceiling resolves to the SYSTEM DEFAULT, not to null.
  // Only an explicit 'unlimited' still lands on null here.
  const ceilings = {
    maxAgents: resolveCeiling(settings?.maxAgents, GOAL_LAUNCH_DEFAULTS.maxAgents),
    maxPerFleet: resolveCeiling(settings?.maxPerFleet, GOAL_LAUNCH_DEFAULTS.maxPerFleet),
  };

  // Only pay for the count when a ceiling actually exists to check it against
  // AND no budget refusal already formed (a refused launch needs no headcount).
  // Since D-015 the ceiling half is the normal case — it goes false only for a
  // goal that has explicitly declared BOTH ceilings unlimited.
  const needsCount = !refusal && (ceilings.maxAgents != null || ceilings.maxPerFleet != null);
  let headcount: GoalHeadcount = { total: 0, fleet: args.fleetSlug ? 0 : null };
  if (needsCount) {
    const counted = await goalHeadcount({
      workspaceId: args.workspaceId,
      goalId,
      fleetSlug: args.fleetSlug ?? null,
      sql: args.sql,
    });
    headcount = counted.headcount;
    if (counted.error) degradedReasons.push(`ceiling not enforced — headcount failed: ${counted.error}`);
  }

  // A ceiling we could not count is not enforced. Fail OPEN and say so (see the
  // module header): refusing every launch on a transient count failure would take
  // out the whole workspace, including whatever would fix it.
  const enforceable = needsCount && !degradedReasons.some((r) => r.startsWith('ceiling not enforced'));
  // Name the SOURCE of the number in the refusal. The first time a default fires
  // it refuses a launch against a ceiling the owner never typed, and "raise
  // maxAgents" sends them looking for a value that is not in the panel.
  const provenance = (pinned: unknown): string =>
    pinned == null ? ' (the system default — this goal has not pinned one)' : '';
  if (enforceable) {
    if (ceilings.maxAgents != null && headcount.total + count > ceilings.maxAgents) {
      refusal = {
        reason: 'goal_max_agents',
        limit: ceilings.maxAgents,
        current: headcount.total,
        requested: count,
        // Already named inline ("N live") in the prose below; carried structurally
        // too so a consumer never has to parse a sentence to learn the population.
        currentScope: REFUSAL_SCOPES.LIVE_AGENTS_IN_GOAL,
        message:
          `goal ${goalId} allows ${ceilings.maxAgents} concurrent agent(s)${provenance(settings?.maxAgents)}; ` +
          `${headcount.total} live, so launching ${count} more would exceed it. Raise maxAgents in the goal's ` +
          `launch settings (or set it to '${UNLIMITED_CEILING}'), or wind down finished sessions first. ` +
          `To free a slot, end each finished session with \`session:end\` (self-only). If the direct ` +
          `\`session:end\` wrapper is unavailable, use \`tools:find\` to locate \`session:end\`, then ` +
          `\`tools:invoke\` the returned exact tool name with \`{}\`. Do not idle or park the session: ` +
          `idle/parked sessions still retain this goal's concurrency slot until \`session:end\` completes.`,
      };
    } else if (
      ceilings.maxPerFleet != null &&
      args.fleetSlug &&
      (headcount.fleet ?? 0) + count > ceilings.maxPerFleet
    ) {
      refusal = {
        reason: 'fleet_max_agents',
        limit: ceilings.maxPerFleet,
        current: headcount.fleet ?? 0,
        requested: count,
        currentScope: REFUSAL_SCOPES.LIVE_AGENTS_IN_FLEET,
        message:
          `goal ${goalId} allows ${ceilings.maxPerFleet} agent(s) per fleet${provenance(settings?.maxPerFleet)}; ` +
          `fleet ${args.fleetSlug} has ${headcount.fleet ?? 0} live, so launching ${count} more would exceed it. ` +
          `Raise maxPerFleet in the goal's launch settings, or split the work across another fleet (it still ` +
          `counts against maxAgents).`,
      };
    }
  }

  // P-012: only the goal-holder slot pays for the portfolio read. Ordinary
  // descendant launches still use this resolver for policy/ceilings, but their
  // kickoff is not a portfolio-manager kickoff and must not assemble the whole
  // goal on every child spawn.
  if (args.goalRole === 'goal' && goalBrief) {
    const portfolio = await readGoalPortfolioBrief({
      workspaceId: args.workspaceId,
      goalId,
      sql: args.sql,
      launch: {
        goalBrief,
        settings,
        budget,
        ceilings,
        headcount,
        degradedReasons,
      },
    });
    if (portfolio) goalBrief = { ...goalBrief, portfolio };
  }

  return {
    goalId,
    settings,
    goalBrief,
    effective,
    ceilings,
    headcount,
    budget,
    refusal,
    degraded: degradedReasons.length > 0,
    degradedReasons,
  };
}
