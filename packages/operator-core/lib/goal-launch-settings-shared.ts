/**
 * CLIENT-SAFE half of goal-launch-settings: the launch-slot vocabulary.
 *
 * WHY THIS FILE EXISTS (WI-39514). `goal-launch-settings.ts` value-imports
 * `getOrgPg` from `@papercusp/db-org` for its async read/write/headcount
 * functions. On the SPA's Vite dev graph there is NO tree-shaking, so a client
 * component importing even ONE pure constant from that module dragged the whole
 * chain into the browser:
 *
 *   app/adv/hud/goal-launch-settings-model.ts
 *     -> operator-core/lib/goal-launch-settings
 *     -> @papercusp/db-org -> workspace-context -> connection
 *     -> operator-core/lib/resource-profile -> embedded-pg-discovery
 *     -> @papercusp/embedded-pg-discovery (imports `node:path`)
 *
 * `node:path` is externalized to a stub that THROWS on property access, so that
 * module threw at init inside a <Lazy> component, was swallowed by
 * CatchBoundaryImpl, and the entire /adv route never mounted its dock. It was
 * invisible for weeks because every e2e spec navigated to the shared standing
 * :3055 rather than an isolated server (fixed under EI-19917451944474469).
 *
 * The rule this file follows is the one in
 * `apps/operator-vite/src/__tests__/no-server-leak-in-client-graph.test.ts`:
 * client-needed types and PURE values live in a `*-shared.ts` with ZERO server
 * imports; the server module re-exports them so existing callers are unchanged.
 *
 * KEEP THIS FILE FREE OF IMPORTS. Anything added here ships to the browser.
 */

/**
 * The CLOSED set of launch SLOTS a goal can pin a profile for (D-016, WI-38048).
 *
 * A slot is a FUNCTION, not a persona. That distinction is the whole fix: a
 * plan-fleet leader and a drain-fleet member both run persona `su`, so keying
 * these profiles on psu `--role` (which is `su` for 121 of 124 live sessions)
 * could never express the contract — every profile the owner configured bound
 * nothing. `role` now means only "which persona prompt to load"; `goalRole`
 * means "which launch slot", and the two never share a spelling again.
 *
 * Keeping this closed is what makes a wrong key a WRITE-time refusal instead of
 * a stored setting that reads as configured and is silently ignored — the same
 * intent as `goalLaunchSettingsSchema`'s `.strict()`, one level up.
 *
 * The list is taken from the GOAL contract's own enumeration in
 * `modes/registry.ts` ("plan-fleet leader + member, drain-fleet leader +
 * member, grading, test, misc") PLUS `goal`, which `goals:start` already passes
 * for the goal's own agent. Note that is EIGHT: WI-38048's prose says "six",
 * and building to that number refuses two slots that are already in use.
 */
export const GOAL_LAUNCH_ROLES = [
  'goal',
  'plan-fleet-leader',
  'plan-fleet-member',
  'drain-fleet-leader',
  'drain-fleet-member',
  'grading',
  'test',
  'misc',
] as const;

export type GoalLaunchRole = (typeof GOAL_LAUNCH_ROLES)[number];

/** True for a string that is a real, bindable launch slot. */
export function isGoalLaunchRole(value: unknown): value is GoalLaunchRole {
  return typeof value === 'string' && (GOAL_LAUNCH_ROLES as readonly string[]).includes(value);
}

/**
 * What happens to a HOLDER-REQUIRED goal when its holder stops being live
 * (goal-live-holder-guarantee-2026-08-18 P-002, D-001).
 *
 * The closed set lives HERE, beside the launch slots, for two reasons. The first
 * is this file's original one: it is import-free, so a client surface can render
 * the choices without dragging `@papercusp/db-org` into the browser graph. The
 * second is new — `recovery-dependency-audit.ts` must enumerate these values to
 * assert that every one of them has a DECLARED disposition, and an audit that
 * had to value-import the server module to learn the set would be paying a PG
 * dependency to read two strings.
 *
 *  - `deactivate` — the goal stops reading `active`, derived at READ time from
 *    the holder resolver. No runtime actor: nothing polls, nothing sweeps, and
 *    there is no cached answer left to go stale. This is the whole thesis of the
 *    plan, which is why it is the default.
 *  - `respawn` — something relaunches a holder. That is a real actor spending
 *    real money unattended, so D-001 makes a goal EARN it by being named. The
 *    audit's disposition table is what stops the actor from being added without
 *    being declared.
 */
export const GOAL_HOLDER_ON_LOSS = ['deactivate', 'respawn'] as const;

export type GoalHolderOnLoss = (typeof GOAL_HOLDER_ON_LOSS)[number];

/** True for a string that is a real, bindable on-loss disposition. */
export function isGoalHolderOnLoss(value: unknown): value is GoalHolderOnLoss {
  return typeof value === 'string' && (GOAL_HOLDER_ON_LOSS as readonly string[]).includes(value);
}

/**
 * The holder policy a goal that has pinned nothing runs under (D-001, D-008).
 *
 * `requireLive: true` is the load-bearing default and the reason this resolves
 * at READ time rather than being stamped into the row by `goals:create`. A
 * default written at create time reaches only goals created after it ships —
 * i.e. none of the rows that were exposed — and the measured exposure is the
 * entire point: 4 of 6 `status='active'` goals had been dark for 2–5 days while
 * every surface called them held. A `false` default would cover none of them and
 * leave the bug in place for every goal that already exists. Same reasoning, and
 * the same shape, as `GOAL_LAUNCH_DEFAULTS` under D-015.
 *
 * `onLoss: 'deactivate'` is D-001, stated outright: most goals should not
 * resurrect themselves, and going quiet is often correct.
 *
 * A goal that genuinely runs unheld says so with an explicit
 * `holder: { requireLive: false }` — the opt-out has to be SAYABLE, or the
 * default becomes a trap for the goals it does not fit.
 */
export const GOAL_HOLDER_DEFAULTS = {
  requireLive: true,
  onLoss: 'deactivate',
} as const satisfies { requireLive: boolean; onLoss: GoalHolderOnLoss };

/**
 * The stored holder policy, typed STRUCTURALLY rather than as the zod-inferred
 * `GoalLaunchSettings`.
 *
 * That is what keeps this module dependency-free, which is the whole reason it
 * is split from `goal-launch-settings.ts`: that module statically imports
 * `@papercusp/db-org`, so anything importing it pays for the store's server
 * dependencies at load. `GoalLaunchSettings` is structurally assignable to this,
 * so callers pass it unchanged.
 */
export interface GoalHolderPolicyInput {
  holder?: { requireLive?: boolean | null; onLoss?: GoalHolderOnLoss | null } | null;
}

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
 * This is `resolveCeiling`'s sibling and follows `goal-launch-settings.ts`'s
 * "WHY IN THE RESOLVER AND NOT AT CREATE TIME" rule exactly: resolving here
 * governs every goal that already exists, with no migration and no backfill,
 * and keeps an absent key meaning exactly one thing.
 *
 * Absent and null both mean unpinned. Only an EXPLICIT `false` opts a goal out
 * of the live-holder requirement.
 *
 * Lives HERE rather than beside the schema so the pure read-side fold
 * (`goals/activity.ts`, P-004) can reach it without dragging the store in.
 */
export function resolveGoalHolderPolicy(
  settings: GoalHolderPolicyInput | null | undefined,
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
