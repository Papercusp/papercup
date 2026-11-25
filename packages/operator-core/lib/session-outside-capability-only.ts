/**
 * A session on an outside plan changes files and runs commands through Papercusp's own tools.
 *
 * `papercusp-fleet-capability-only` already does this for the agents Papercusp spawns itself
 * (dbos/orchestrator-runner.ts): Claude Code's Bash, Edit, Write and WebFetch are withdrawn and
 * the `capability:*` tools stand in. A session an outside client hosts was left out, because
 * that client, not Papercusp, starts the process. It worked with Claude Code's own tools, and
 * two things followed. Its file locks were taken by a hook before the edit and released by a
 * hook after it, so an edit that was refused in between (a permission check, a failed match)
 * left its lock behind for the lease. And its shell was Claude Code's, where a write into the
 * shared folder goes around the lock unless a hook catches it.
 *
 * The bootstrap answers such a launch with what this module returns, and the client that hosts
 * the session applies it: it withdraws the named tools of Claude Code and gives the session the
 * named Papercusp tools beside whatever else it is seeded with. One answer carries both lists,
 * so a session is never left with a tool withdrawn and nothing in its place.
 */
import { FLEET_CAPABILITY_REPLACED_TOOLS } from '@papercusp/orchestrator';

/** The environment marker the flag is applied under, the same name a spawned agent is given. */
export const CAPABILITY_ONLY_ENV = 'PAPERCUSP_FLEET_CAPABILITY_ONLY';

/**
 * Claude Code's tools such a session loses. The flag's own list is the one a spawned agent's
 * allow-list is cut by, and that list never held `NotebookEdit`. A hosted session starts with
 * every tool Claude Code ships, and this one writes a file with no lock.
 */
export const OUTSIDE_SESSION_WITHDRAWN_NATIVE_TOOLS: readonly string[] = [
  ...FLEET_CAPABILITY_REPLACED_TOOLS,
  'NotebookEdit',
];

/**
 * What stands in. `capability:write`, `capability:edit` and `capability:patch` take the file's
 * lock in the same call as the write; `capability:patch` lands a change to several files as one
 * unit. `capability:bash` runs a command, and `capability:bash_output` reads a run that was
 * started in the background. There is no stand-in for WebFetch: a session building someone
 * else's plan has no errand on the network that its client did not give it.
 */
export const OUTSIDE_SESSION_STAND_IN_TOOLS: readonly string[] = [
  'capability:write',
  'capability:edit',
  'capability:patch',
  'capability:bash',
  'capability:bash_output',
];

/**
 * What the stand-ins need beside them. `capability:bash` holds a work-item's next slow run once
 * two of them have failed, until an audit note is on the item (verification-attempts/loop-gate.ts),
 * and `work_items:comment` is how that note is written. Claude Code's shell has no such rule, so
 * a session seeded for that shell may not have the tool: given the shell without it, a session
 * whose test suite failed twice could not run it a third time.
 */
export const OUTSIDE_SESSION_COMPANION_TOOLS: readonly string[] = ['work_items:comment'];

/** Everything a capability-only session is given beside its seed. */
export const OUTSIDE_SESSION_CAPABILITY_TOOLS: readonly string[] = [
  ...OUTSIDE_SESSION_STAND_IN_TOOLS,
  ...OUTSIDE_SESSION_COMPANION_TOOLS,
];

/** What a capability-only launch tells the client that hosts the session. */
export interface SessionCapabilityOnly {
  /** Claude Code's own tools to withdraw from the session. */
  withdrawnNativeTools: string[];
  /** The Papercusp tools the session is given in their place, and what those need beside them. */
  tools: string[];
}

async function flagOn(): Promise<boolean> {
  const [{ getFlag }, { FLAGS }] = await Promise.all([import('@papercusp/flags/server'), import('@papercusp/flags')]);
  return getFlag(FLAGS.FLEET_CAPABILITY_ONLY, 'system');
}

/**
 * The capability-only terms of a launch, or null when the session keeps Claude Code's own tools:
 * it is not on an outside plan, its agent is not Claude Code (the withdrawn names are Claude
 * Code's), or the flag is off. A flag that cannot be read counts as off, as it does for a
 * spawned agent: a session that keeps its own tools still works, and one that lost them to a
 * guess might not.
 */
export async function outsideSessionCapabilityOnly(
  session: { agent: string; outsidePlanRef: string | null },
  enabled: () => Promise<boolean> = flagOn,
): Promise<SessionCapabilityOnly | null> {
  if (session.agent !== 'claude' || session.outsidePlanRef === null) return null;
  try {
    if (!(await enabled())) return null;
  } catch {
    return null;
  }
  return {
    withdrawnNativeTools: [...OUTSIDE_SESSION_WITHDRAWN_NATIVE_TOOLS],
    tools: [...OUTSIDE_SESSION_CAPABILITY_TOOLS],
  };
}
