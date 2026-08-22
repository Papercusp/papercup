/** WI-2479: durable, dark-by-default fleet headcount repair action. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  claimFleetHeadcountAttempt,
  claimFleetLaunchSlot,
  getFleet,
  listFleetHeadcountTargets,
  recordFleetHeadcountAttempt,
  type FleetHeadcountConfig,
} from '../../agent-fleets-store';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole, spawnHeadless } from '../../console-spawn';
import { liveFleetMemberIds } from '../../fleet/fleet-roster';
import { composeMemberLaunchContext, memberLaunchCommand } from '../../agent-launch-core';
import { resolveGoalLaunch } from '../../goal-launch-settings';
import type { GoalLaunchRole } from '../../goal-launch-settings-shared';
import { resolveGoalContext } from '../../modes/goal-context';
import { papercuspPathForWorkspace } from '../../papercusp-root';
import { resolveSpawnHostOperatorBaseUrl } from '../../mcp-base-url';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const FLEET_HEADCOUNT_FLAG = FLAGS.FLEET_HEADCOUNT_GOVERNOR;
export const FLEET_HEADCOUNT_LAUNCH_WINDOW_MS = 300_000;

export function computeHeadcountDeficit(target: number, liveMembers: number): number {
  return Math.max(0, Math.floor(target) - Math.max(0, Math.floor(liveMembers)));
}

export function nextHeadcountBackoff(currentMs: number): number {
  return Math.min(15 * 60_000, Math.max(60_000, Math.max(0, currentMs) * 2));
}

/** Legacy target rows predate explicit placement. Fleet restoration is headless
 * unless a persisted profile deliberately requests visible terminals. */
export function resolveFleetHeadcountProfile(
  config: FleetHeadcountConfig,
): FleetHeadcountConfig & { headless: boolean } {
  return { ...config, headless: config.headless ?? true };
}

/**
 * D-016: resolve the launch SLOT for a governor refill from durable goal
 * context, not from `AgentFleetRecord` or `FleetHeadcountConfig` (neither
 * carries a slot). The goal's `metadata.drainFleet` declaration is the
 * canonical identity written by `mintDrainFleetForGoal`; every other fleet
 * attached to that goal is a plan-fleet member. Fleets outside a goal keep the
 * absent role layer rather than inheriting a persona's `--role`.
 */
export function resolveFleetHeadcountLaunchRole(args: {
  goalId: string | null;
  fleetSlug: string;
  drainFleetSlug: string | null;
}): GoalLaunchRole | null {
  if (!args.goalId) return null;
  return args.drainFleetSlug === args.fleetSlug ? 'drain-fleet-member' : 'plan-fleet-member';
}

/** Resolve the governor's slot from the launcher's goal and its declaration. */
async function resolveFleetHeadcountLaunchRoleForFleet(
  workspaceId: string,
  fleetSlug: string,
  launcherOwnerId: string,
): Promise<GoalLaunchRole | null> {
  let goalId: string | null;
  try {
    goalId = await resolveGoalContext(workspaceId, launcherOwnerId);
  } catch {
    return null;
  }
  if (!goalId) return null;

  try {
    const rows = await getOrgPg().sql<{ drain_fleet: string | null }[]>`
      SELECT metadata->>'drainFleet' AS drain_fleet
        FROM harness_shared.goals
       WHERE id = ${goalId} AND workspace_id = ${workspaceId}
       LIMIT 1`;
    return resolveFleetHeadcountLaunchRole({
      goalId,
      fleetSlug,
      drainFleetSlug: rows[0]?.drain_fleet ?? null,
    });
  } catch {
    // Preserve the resolver's fail-open launch behavior if the declaration
    // read is unavailable; applying a guessed slot could bind the wrong role.
    return null;
  }
}

// WI-6154: this-host identity (PAPERCUSP_HONO_PORT) must win over an inherited
// PAPERCUSP_OPERATOR_URL — see resolveSpawnHostOperatorBaseUrl's doc for why.
const operatorBaseUrl = resolveSpawnHostOperatorBaseUrl;

async function topUpOneFleet(workspaceId: string, fleetSlug: string): Promise<void> {
  const attempt = await claimFleetHeadcountAttempt({ workspaceId, fleetSlug });
  if (!attempt) return;
  const fleet = await getFleet(workspaceId, fleetSlug);
  if (!fleet) return;
  try {
    const live = (await liveFleetMemberIds(fleetSlug, workspaceId)).filter((id) => id !== fleet.leaderOwnerId).length;
    const deficit = computeHeadcountDeficit(attempt.target, live);
    if (deficit === 0) {
      await recordFleetHeadcountAttempt({ workspaceId, fleetSlug, succeeded: true });
      return;
    }
    const slot = await claimFleetLaunchSlot({
      workspaceId,
      fleetSlug,
      count: deficit,
      windowMs: FLEET_HEADCOUNT_LAUNCH_WINDOW_MS,
    });
    if (!slot.won) {
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: false,
        error: `top-up suppressed by launch window; prior wave at ${slot.priorAt}`,
      });
      return;
    }
    const config = resolveFleetHeadcountProfile(attempt.config);

    // ── The goal ceilings bind the GOVERNOR too (P-004/D-009) ─────────────────
    // This is the path that most needs them. Every other launch door is driven by
    // an agent or a human who would at least see a refusal; this one tops a fleet
    // back up to target on a routine, unattended, forever. Left unwired it would
    // quietly hold a fleet ABOVE a goal's maxAgents indefinitely — refusing the
    // owner's own launches while a background routine ignored the same ceiling.
    //
    // The launcher is the fleet's LEADER: the governor is acting on the leader's
    // behalf, so the goal it serves is the leader's goal context (D-008). The
    // launch slot is inferred from the goal's durable drainFleet declaration;
    // it is not present on the fleet registry/config rows.
    const goalRole = await resolveFleetHeadcountLaunchRoleForFleet(
      workspaceId,
      fleetSlug,
      fleet.leaderOwnerId ?? '',
    );
    const goalLaunch = await resolveGoalLaunch({
      workspaceId,
      launcherOwnerId: fleet.leaderOwnerId ?? '',
      // D-016 (WI-38048): `config.role` is psu `--role`, a persona — NOT a launch
      // slot, so it must not key the goal's profiles. The slot above is derived
      // from durable goal context instead.
      goalRole,
      fleetSlug,
      count: deficit,
    });
    if (goalLaunch.refusal) {
      // Recorded as a failed attempt rather than thrown: the governor must keep
      // running (the fleet may shrink back under the ceiling on its own), and the
      // reason belongs on the attempt so an operator sees WHY the fleet is being
      // held below target instead of reading it as the top-up silently breaking.
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: false,
        error: goalLaunch.refusal.message,
      });
      return;
    }

    const envelope = await buildConsoleEnvelope({
      workspaceId,
      slug: config.harness,
      operatorBaseUrl: operatorBaseUrl(),
      skipMcpJson: true,
    });
    let launchContext = config.launchContext;
    if (config.brief) {
      const contextDir = join(papercuspPathForWorkspace(workspaceId), 'launch-context');
      mkdirSync(contextDir, { recursive: true });
      launchContext = join(contextDir, `fleet-${fleetSlug}-headcount-context.md`);
      writeFileSync(
        launchContext,
        composeMemberLaunchContext({
          fleetSlug,
          plan: config.plan,
          count: attempt.target,
          carry: config.carry,
          customBriefText: config.brief,
        }),
        'utf8',
      );
    }
    const command = memberLaunchCommand({
      fleetSlug,
      agent: config.agent,
      harness: config.harness,
      plan: config.plan,
      headless: config.headless,
      // The goal's profile applies to a governor top-up exactly as it does to the
      // leader's own launches — otherwise a replaced member silently comes back
      // on a different model/account than the one the goal pinned.
      model: goalLaunch.effective.model ?? config.model,
      effort: goalLaunch.effective.effort ?? config.effort,
      account: goalLaunch.effective.account ?? config.account,
      role: config.role,
      launchContext,
      contextSize: config.contextSize,
      compactionLimit: config.compactionLimit,
      carry: config.carry,
      extraArgs: config.extraArgs,
    });
    const logDir = config.headless ? `${papercuspPathForWorkspace(workspaceId)}/fleet-logs` : null;
    const results = await Promise.all(
      Array.from({ length: deficit }, (_v, i) =>
        config.headless
          ? spawnHeadless({
              envelope: { ...envelope, greetingCmd: command, cwd: envelope.cwd },
              label: `${fleetSlug} · governor member ${i + 1}/${deficit} (${config.plan})`,
              logDir: logDir!,
            })
          : spawnConsole({
              envelope: { ...envelope, greetingCmd: command, cwd: envelope.cwd },
              label: `${fleetSlug} · governor member ${i + 1}/${deficit} (${config.plan})`,
              writeMcpJson: false,
              allowDesktopBridge: true,
            }),
      ),
    );
    const failed = results.filter((r) => r.status !== 'ok');
    if (failed.length === 0) {
      await recordFleetHeadcountAttempt({ workspaceId, fleetSlug, succeeded: true });
    } else {
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: false,
        error: `${failed.length}/${results.length} ${config.headless ? 'headless' : 'visible'} top-up spawns failed`,
      });
    }
  } catch (error) {
    await recordFleetHeadcountAttempt({
      workspaceId,
      fleetSlug,
      succeeded: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runFleetHeadcountGovernor(ctx: SystemActionCtx): Promise<void> {
  if (!(await getFlag(FLEET_HEADCOUNT_FLAG, 'system').catch(() => false))) return;
  const targets = await listFleetHeadcountTargets(ctx.workspaceId);
  // Bounded one-wave-per-tick: the durable per-fleet lease prevents duplicate
  // opens, while this cap prevents a large fleet registry from creating a burst.
  for (const target of targets.slice(0, 4)) {
    await topUpOneFleet(ctx.workspaceId, target.fleetSlug);
  }
}

registerSystemAction('fleet-headcount-governor', runFleetHeadcountGovernor);
