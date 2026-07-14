/** WI-2479: durable, dark-by-default fleet headcount repair action. */
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
import { spawnHeadless } from '../../console-spawn';
import { liveFleetMemberIds } from '../../fleet/fleet-roster';
import { memberLaunchCommand } from '../../agent-launch-core';
import { papercuspPathForWorkspace } from '../../papercusp-root';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const FLEET_HEADCOUNT_FLAG = FLAGS.FLEET_HEADCOUNT_GOVERNOR;
export const FLEET_HEADCOUNT_LAUNCH_WINDOW_MS = 300_000;

export function computeHeadcountDeficit(target: number, liveMembers: number): number {
  return Math.max(0, Math.floor(target) - Math.max(0, Math.floor(liveMembers)));
}

export function nextHeadcountBackoff(currentMs: number): number {
  return Math.min(15 * 60_000, Math.max(60_000, Math.max(0, currentMs) * 2));
}

function operatorBaseUrl(): string {
  const fromEnv = process.env.PAPERCUSP_OPERATOR_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '');
  return `http://localhost:${process.env.PAPERCUSP_HONO_PORT?.trim() || '3070'}`;
}

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
    const config: FleetHeadcountConfig = attempt.config;
    const envelope = await buildConsoleEnvelope({
      workspaceId,
      slug: config.harness,
      operatorBaseUrl: operatorBaseUrl(),
      skipMcpJson: true,
    });
    const command = memberLaunchCommand({
      fleetSlug,
      agent: config.agent,
      harness: config.harness,
      plan: config.plan,
      headless: true,
      model: config.model,
      account: config.account,
      role: config.role,
      launchContext: config.launchContext,
      contextSize: config.contextSize,
      extraArgs: config.extraArgs,
    });
    const logDir = `${papercuspPathForWorkspace(workspaceId)}/fleet-logs`;
    const results = await Promise.all(
      Array.from({ length: deficit }, (_v, i) =>
        spawnHeadless({
          envelope: { ...envelope, greetingCmd: command, cwd: envelope.cwd },
          label: `${fleetSlug} · governor member ${i + 1}/${deficit} (${config.plan})`,
          logDir,
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
        error: `${failed.length}/${results.length} headless top-up spawns failed`,
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
