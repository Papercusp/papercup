/**
 * Launch the holder of an EXISTING goal from a deterministic system action.
 *
 * `goals:start` and `goal-auto-start` create a goal and its first holder in one
 * operation. Recovery is a different shape: the goal row already exists, so a
 * system caller must resolve that goal's launch policy explicitly and open a
 * fresh tracked session through the same `launch-su` door the GUI uses.
 *
 * Keep the launch and the later attachment separate. This action returns the
 * pre-pinned owner id; the holder-loss reconciler owns attaching that identity
 * to the goal only after the launch succeeds.
 */
import { composeLaunchModelSpec } from '../../agent-config-constants';
import {
  resolveGoalLaunchForGoal,
  type GoalLaunchResolution,
} from '../../goal-launch-settings';
import { launchAgent, type LaunchAgentResult } from '../../launch-agent';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export interface GoalHolderLaunchInput {
  workspaceId: string;
  goalId: string;
  harnessSlug: string;
  /** Best-effort attribution for a budget-refusal escalation. */
  launcherOwnerId?: string | null;
  /** Test/probe seam: record the launch without opening a process. */
  deferSpawn?: boolean;
}

export interface GoalHolderLaunchResult {
  ownerId: string;
  /** Fail-open policy reads and launch-su process warnings, never swallowed. */
  warnings: string[];
}

export interface GoalHolderLaunchDeps {
  resolveGoalLaunch: (args: {
    workspaceId: string;
    goalId: string;
    launcherOwnerId?: string | null;
    goalRole: 'goal';
    requested: Record<string, never>;
  }) => Promise<GoalLaunchResolution>;
  launch: (opts: Parameters<typeof launchAgent>[0]) => Promise<LaunchAgentResult>;
}

const DEFAULT_DEPS: GoalHolderLaunchDeps = {
  resolveGoalLaunch: resolveGoalLaunchForGoal,
  launch: launchAgent,
};

function required(value: string | null | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`goal-holder-launch requires ${name}`);
  return trimmed;
}

/**
 * Resolve one existing goal and launch its replacement holder.
 *
 * A formed refusal is hard: launching anyway would bypass the goal's budget or
 * headcount ceiling. A degraded resolution is fail-open by the resolver's
 * contract, but every reason is returned to the action log/caller so the launch
 * is never reported as fully governed when it was not.
 */
export async function launchGoalHolderSession(
  input: GoalHolderLaunchInput,
  deps: GoalHolderLaunchDeps = DEFAULT_DEPS,
): Promise<GoalHolderLaunchResult> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const goalId = required(input.goalId, 'goalId');
  const harnessSlug = required(input.harnessSlug, 'harnessSlug');

  const resolved = await deps.resolveGoalLaunch({
    workspaceId,
    goalId,
    launcherOwnerId: input.launcherOwnerId ?? null,
    goalRole: 'goal',
    requested: {},
  });
  if (resolved.refusal) {
    throw new Error(`goal-holder-launch refused for ${goalId}: ${resolved.refusal.message}`);
  }

  const model = composeLaunchModelSpec(resolved.effective.model, resolved.effective.effort);
  const launched = await deps.launch({
    slug: harnessSlug,
    agent: resolved.effective.agent,
    model,
    account: resolved.effective.account,
    contextSize: resolved.effective.contextSize,
    headless: true,
    mode: 'auto',
    deferSpawn: input.deferSpawn ?? false,
  });
  if (!launched.ok) {
    throw new Error(
      `goal-holder-launch failed for ${goalId}: ${launched.error ?? 'launch-su returned no error detail'}`,
    );
  }
  if (!launched.ownerId) {
    throw new Error(
      `goal-holder-launch failed for ${goalId}: launch-su succeeded without the pre-pinned ownerId needed to attach the holder`,
    );
  }

  return {
    ownerId: launched.ownerId,
    warnings: [
      ...resolved.degradedReasons.map((reason) => `launch policy degraded: ${reason}`),
      ...(launched.warning ? [`launch-su warning: ${launched.warning}`] : []),
    ],
  };
}

function optionalPayloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function runGoalHolderLaunchAction(
  ctx: SystemActionCtx,
  deps: GoalHolderLaunchDeps = DEFAULT_DEPS,
): Promise<GoalHolderLaunchResult> {
  const goalId = optionalPayloadString(ctx.payloadTemplate, 'goalId');
  const launcherOwnerId = optionalPayloadString(ctx.payloadTemplate, 'launcherOwnerId');
  const result = await launchGoalHolderSession(
    {
      workspaceId: ctx.workspaceId,
      goalId: goalId ?? '',
      harnessSlug: ctx.installSlug,
      launcherOwnerId,
    },
    deps,
  );
  for (const warning of result.warnings) {
    console.warn(`[goal-holder-launch] ${goalId}: ${warning}`);
  }
  return result;
}

registerSystemAction('goal-holder-launch', async (ctx) => {
  await runGoalHolderLaunchAction(ctx);
});
