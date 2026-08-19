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
import { resolveGoalContext } from './modes/goal-context';

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
export const LAUNCH_PROFILE_CONTEXT_SIZES = ['full', 'trimmed'] as const;

/** The option lists an editor must render, in one payload-shaped object. */
export const LAUNCH_PROFILE_OPTIONS = {
  agent: LAUNCH_PROFILE_AGENTS,
  carry: LAUNCH_PROFILE_CARRY,
  contextSize: LAUNCH_PROFILE_CONTEXT_SIZES,
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

/** A holder policy with every field resolved — no absent, no null, no guessing. */
export interface ResolvedGoalHolderPolicy {
  requireLive: boolean;
  onLoss: GoalHolderOnLoss;
  /**
   * True when the goal pinned NOTHING and is running entirely on defaults.
   * P-003 refuses at the write boundary on this; a surface that wants to show
   * "inherited" vs "pinned" reads it rather than re-deriving it from absence.
   */
  isDefault: boolean;
}

/**
 * Resolve one goal's holder policy at READ time (D-008).
 *
 * This is `resolveCeiling`'s sibling and follows the module header's "WHY IN THE
 * RESOLVER AND NOT AT CREATE TIME" rule exactly: resolving here governs every
 * goal that already exists, with no migration and no backfill, and keeps an
 * absent key meaning exactly one thing.
 *
 * Absent and null both mean unpinned. Only an EXPLICIT `false` opts a goal out
 * of the live-holder requirement.
 */
export function resolveGoalHolderPolicy(
  settings: GoalLaunchSettings | null | undefined,
): ResolvedGoalHolderPolicy {
  const stored = settings?.holder;
  const requireLive = stored?.requireLive;
  const onLoss = stored?.onLoss;
  return {
    requireLive: typeof requireLive === 'boolean' ? requireLive : GOAL_HOLDER_DEFAULTS.requireLive,
    onLoss: onLoss ?? GOAL_HOLDER_DEFAULTS.onLoss,
    isDefault: requireLive == null && onLoss == null,
  };
}

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
export function goalHolderPolicyProblem(
  settings: GoalLaunchSettings | null | undefined,
): string | null {
  const policy = resolveGoalHolderPolicy(settings);
  if (!policy.requireLive || !policy.isDefault) return null;
  return (
    'this goal would require a LIVE holder but declares no holder policy — ' +
    `it is inheriting the default (requireLive: ${GOAL_HOLDER_DEFAULTS.requireLive}, ` +
    `onLoss: '${GOAL_HOLDER_DEFAULTS.onLoss}') rather than stating one. ` +
    "Declare it: holder: { requireLive: true } if a live holder is what you mean, " +
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
}

export interface GoalLaunchResolution {
  /** The goal this launch serves, resolved from the LAUNCHER (D-008). Null = no goal in scope. */
  goalId: string | null;
  settings: GoalLaunchSettings | null;
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
 */
export function parseGoalLaunchSettings(
  raw: unknown,
  label = 'launch_settings',
): { settings: GoalLaunchSettings | null; error: string | null } {
  if (raw == null) return { settings: null, error: null };
  try {
    const parsed = goalLaunchSettingsSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    if (!parsed.success) return { settings: null, error: `${label} is invalid: ${parsed.error.message}` };
    return { settings: parsed.data, error: null };
  } catch (e) {
    // A string that is not JSON at all lands here rather than in safeParse.
    return { settings: null, error: `${label} is unreadable: ${e instanceof Error ? e.message : String(e)}` };
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
): Promise<{ settings: GoalLaunchSettings | null; budget: GoalBudgetTruth | null; error: string | null }> {
  if (!goalId) return { settings: null, budget: null, error: null };
  try {
    const rows = await pg(sql)`
      SELECT launch_settings, budget_cents,
             metadata->'spentCents' AS spent_cents,
             metadata->>'spentCentsAt' AS spent_cents_at
        FROM harness_shared.goals WHERE id = ${goalId} LIMIT 1`;
    if (!rows.length) return { settings: null, budget: null, error: null };
    const row = rows[0] as {
      launch_settings?: unknown;
      budget_cents?: unknown;
      spent_cents?: unknown;
      spent_cents_at?: unknown;
    };
    const parsed = parseGoalLaunchSettings(row.launch_settings, `goal ${goalId} launch_settings`);
    return {
      settings: parsed.settings,
      budget: {
        budgetCents: asFiniteCents(row.budget_cents),
        spentCents: asFiniteCents(row.spent_cents),
        spentCentsAt: typeof row.spent_cents_at === 'string' ? row.spent_cents_at : null,
      },
      error: parsed.error,
    };
  } catch (e) {
    return { settings: null, budget: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `budget_cents` is a bigint (postgres-js hands it over as a string);
 * `metadata->'spentCents'` is a jsonb scalar (a number when the rollup wrote
 * it, but historically agent-written values could be anything). Anything not a
 * finite number is null — "unknown", never 0, because 0 would read as "nothing
 * spent" and admit a launch on garbage.
 */
function asFiniteCents(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
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
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
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
    // resolveGoalContext is itself fail-soft, so reaching here means something
    // below it broke hard. No goal context = no ceiling and no profile, which is
    // exactly the pre-P-004 behaviour — but say so.
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
      effective: foldLaunchProfile(null, args.goalRole, args.requested),
      ceilings: { maxAgents: null, maxPerFleet: null },
      headcount: { total: 0, fleet: args.fleetSlug ? 0 : null },
      budget: null,
      refusal: null,
      degraded: degradedReasons.length > 0,
      degradedReasons,
    };
  }

  const { settings, budget, error: settingsError } = await readGoalLaunchSettings(goalId, args.sql);
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
      degradedReasons.push(
        `budget ceiling not enforced — flag read failed: ${gate.infraError}`,
      );
    } else if (gate.enabled) {
      if (budget.spentCents == null) {
        degradedReasons.push(
          `budget ceiling not enforced — goal ${goalId} declares budget_cents=${budget.budgetCents} but has no ` +
            `platform spend snapshot yet (metadata.spentCents is written by the goal-spend-rollup tick; D-003 ` +
            `forbids inventing one)`,
        );
      } else if (budget.spentCents >= budget.budgetCents) {
        refusal = {
          reason: 'goal_budget_exceeded',
          limit: budget.budgetCents,
          current: budget.spentCents,
          requested: count,
          message:
            `goal ${goalId} has spent ${budget.spentCents} of its ${budget.budgetCents} cent budget` +
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
        message:
          `goal ${goalId} allows ${ceilings.maxAgents} concurrent agent(s)${provenance(settings?.maxAgents)}; ` +
          `${headcount.total} live, so launching ${count} more would exceed it. Raise maxAgents in the goal's ` +
          `launch settings (or set it to '${UNLIMITED_CEILING}'), or wind down finished sessions first.`,
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
        message:
          `goal ${goalId} allows ${ceilings.maxPerFleet} agent(s) per fleet${provenance(settings?.maxPerFleet)}; ` +
          `fleet ${args.fleetSlug} has ${headcount.fleet ?? 0} live, so launching ${count} more would exceed it. ` +
          `Raise maxPerFleet in the goal's launch settings, or split the work across another fleet (it still ` +
          `counts against maxAgents).`,
      };
    }
  }

  return {
    goalId,
    settings,
    effective,
    ceilings,
    headcount,
    budget,
    refusal,
    degraded: degradedReasons.length > 0,
    degradedReasons,
  };
}
