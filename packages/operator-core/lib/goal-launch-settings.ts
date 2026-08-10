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
 * WHY THE CEILINGS FAIL OPEN. A ceiling that cannot be READ does not refuse the
 * launch; it reports itself degraded and lets the launch through. This is a
 * governor over the owner's own fleet, not a security boundary, and the failure
 * modes are not symmetric: failing closed on a transient read error would brick
 * every launch in the workspace at once — including the launches needed to fix
 * whatever broke the read. The degraded reason is returned rather than swallowed
 * so a caller surfaces "the ceiling was not enforced" instead of quietly
 * reporting success. A ceiling that IS read and IS exceeded refuses, hard.
 */
import { z } from 'zod';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
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

/** The launch knobs a goal can pin, per role or as its across-the-board default. */
export const launchProfileSchema = z
  .object({
    agent: z.enum(['claude', 'codex', 'omp']).optional(),
    model: z.string().min(1).max(120).optional(),
    effort: z.string().min(1).max(40).optional(),
    account: z.string().min(1).max(120).optional(),
    carry: z.enum(['warm', 'cold']).optional(),
    contextSize: z.enum(['full', 'trimmed']).optional(),
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
    maxAgents: z
      .number()
      .int()
      .positive()
      .max(1000)
      .nullable()
      .optional()
      .describe('D-005: ceiling over EVERY live session associated with this goal, fleet members included'),
    maxPerFleet: z
      .number()
      .int()
      .positive()
      .max(1000)
      .nullable()
      .optional()
      .describe('D-005: ceiling on any ONE fleet pursuing this goal; composes with maxAgents'),
    defaults: launchProfileSchema.optional(),
    roles: z.record(z.string().min(1).max(64), launchProfileSchema).optional(),
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
  reason: 'goal_max_agents' | 'fleet_max_agents';
  limit: number;
  current: number;
  requested: number;
  message: string;
}

export interface GoalLaunchResolution {
  /** The goal this launch serves, resolved from the LAUNCHER (D-008). Null = no goal in scope. */
  goalId: string | null;
  settings: GoalLaunchSettings | null;
  /** Merged profile: caller request > per-role > goal defaults. Absent keys stay absent. */
  effective: LaunchProfile;
  ceilings: { maxAgents: number | null; maxPerFleet: number | null };
  headcount: GoalHeadcount;
  /** Non-null when this launch would breach a ceiling. The caller MUST NOT launch. */
  refusal: GoalLaunchRefusal | null;
  /** True when a ceiling could not be read or counted, so it was NOT enforced. */
  degraded: boolean;
  degradedReasons: string[];
}

/**
 * Read + validate one goal's launch settings. Returns null for "none declared"
 * (the common case, and the correct default), and reports invalid stored JSON as
 * an error rather than silently treating a malformed document as absent — a
 * settings blob that fails to parse means the owner's ceiling is NOT in force,
 * which they must hear about.
 */
export async function readGoalLaunchSettings(
  goalId: string,
  sql?: Sql,
): Promise<{ settings: GoalLaunchSettings | null; error: string | null }> {
  if (!goalId) return { settings: null, error: null };
  try {
    const rows = await pg(sql)`
      SELECT launch_settings FROM harness_shared.goals WHERE id = ${goalId} LIMIT 1`;
    if (!rows.length) return { settings: null, error: null };
    const raw = (rows[0] as { launch_settings?: unknown }).launch_settings;
    if (raw == null) return { settings: null, error: null };
    const parsed = goalLaunchSettingsSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    if (!parsed.success) {
      return { settings: null, error: `goal ${goalId} launch_settings is invalid: ${parsed.error.message}` };
    }
    return { settings: parsed.data, error: null };
  } catch (e) {
    return { settings: null, error: e instanceof Error ? e.message : String(e) };
  }
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
  role: string | null | undefined,
  requested?: LaunchProfile | null,
): LaunchProfile {
  const out: LaunchProfile = {};
  const layers: Array<LaunchProfile | undefined> = [
    settings?.defaults,
    role ? settings?.roles?.[role] : undefined,
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
  role?: string | null;
  fleetSlug?: string | null;
  /** How many agents this launch will start. Default 1. */
  count?: number;
  requested?: LaunchProfile | null;
  sql?: Sql;
}): Promise<GoalLaunchResolution> {
  const count = Math.max(1, Math.floor(args.count ?? 1));
  const degradedReasons: string[] = [];
  const base: GoalLaunchResolution = {
    goalId: null,
    settings: null,
    effective: foldLaunchProfile(null, args.role, args.requested),
    ceilings: { maxAgents: null, maxPerFleet: null },
    headcount: { total: 0, fleet: args.fleetSlug ? 0 : null },
    refusal: null,
    degraded: false,
    degradedReasons: [],
  };

  let goalId: string | null = null;
  try {
    goalId = await resolveGoalContext(args.workspaceId, args.launcherOwnerId, args.sql);
  } catch (e) {
    // resolveGoalContext is itself fail-soft, so reaching here means something
    // below it broke hard. No goal context = no ceiling and no profile, which is
    // exactly the pre-P-004 behaviour — but say so.
    degradedReasons.push(`goal context unresolved: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!goalId) {
    return { ...base, degraded: degradedReasons.length > 0, degradedReasons };
  }

  const { settings, error: settingsError } = await readGoalLaunchSettings(goalId, args.sql);
  if (settingsError) degradedReasons.push(`launch settings not applied: ${settingsError}`);

  const effective = foldLaunchProfile(settings, args.role, args.requested);
  const ceilings = {
    maxAgents: settings?.maxAgents ?? null,
    maxPerFleet: settings?.maxPerFleet ?? null,
  };

  // Only pay for the count when a ceiling actually exists to check it against.
  const needsCount = ceilings.maxAgents != null || ceilings.maxPerFleet != null;
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
  let refusal: GoalLaunchRefusal | null = null;
  if (enforceable) {
    if (ceilings.maxAgents != null && headcount.total + count > ceilings.maxAgents) {
      refusal = {
        reason: 'goal_max_agents',
        limit: ceilings.maxAgents,
        current: headcount.total,
        requested: count,
        message:
          `goal ${goalId} allows ${ceilings.maxAgents} concurrent agent(s); ${headcount.total} live, ` +
          `so launching ${count} more would exceed it. Raise maxAgents in the goal's launch settings, ` +
          `or wind down finished sessions first.`,
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
          `goal ${goalId} allows ${ceilings.maxPerFleet} agent(s) per fleet; fleet ${args.fleetSlug} has ` +
          `${headcount.fleet ?? 0} live, so launching ${count} more would exceed it. Raise maxPerFleet in the ` +
          `goal's launch settings, or split the work across another fleet (it still counts against maxAgents).`,
      };
    }
  }

  return {
    goalId,
    settings,
    effective,
    ceilings,
    headcount,
    refusal,
    degraded: degradedReasons.length > 0,
    degradedReasons,
  };
}
