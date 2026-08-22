/** WI-2479: durable, dark-by-default fleet headcount repair action. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    // behalf, so the goal it serves is the leader's goal context (D-008).
    const goalLaunch = await resolveGoalLaunch({
      workspaceId,
      launcherOwnerId: fleet.leaderOwnerId ?? '',
      // D-016 (WI-38048): `config.role` is psu `--role`, a persona — NOT a launch
      // slot, so it must not key the goal's profiles. The governor refills an
      // existing fleet without knowing whether it is a plan or drain fleet, so it
      // has no slot to name and folds no role layer. Ceilings are unaffected:
      // they never depended on a role.
      goalRole: null,
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
