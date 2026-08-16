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
