/** WI-2479: durable, dark-by-default fleet headcount repair action. */
import { randomUUID } from 'node:crypto';
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
  mergeFleetLaunchWorkerAttestations,
  recordFleetHeadcountAttempt,
  releaseFleetLaunchSlot,
  setFleetLaunchTransaction,
  type FleetHeadcountConfig,
  type FleetLaunchGovernorAction,
  type FleetLaunchGovernorState,
  type FleetLaunchGovernorVerdict,
  type FleetLaunchTransaction,
} from '../../agent-fleets-store';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole, spawnHeadless } from '../../console-spawn';
import { liveFleetMemberIds } from '../../fleet/fleet-roster';
import {
  composeModelSpec,
  composeMemberLaunchContext,
  injectLaunchedByArg,
  memberLaunchCommand,
  modelEffortFromSpec,
  verifyFreshLaunchStarted,
  type FreshLaunchExpectedAttestation,
} from '../../agent-launch-core';
import killTool from '../../agent-tools/fleet/kill';
import { resolveGoalLaunch } from '../../goal-launch-settings';
import {
  goalFleetFamily,
  goalFleetMemberSlot,
  type GoalLaunchRole,
} from '../../goal-launch-settings-shared';
import { resolveGoalContext } from '../../modes/goal-context';
import { papercuspPathForWorkspace } from '../../papercusp-root';
import { resolveSpawnHostOperatorBaseUrl } from '../../mcp-base-url';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const FLEET_HEADCOUNT_FLAG = FLAGS.FLEET_HEADCOUNT_GOVERNOR;
export const FLEET_HEADCOUNT_LAUNCH_WINDOW_MS = 300_000;
export const FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT = 3;
export const FLEET_HEADCOUNT_BULK_WAVE_SIZE = 3;
export const FLEET_HEADCOUNT_HISTORY_LIMIT = 32;
export const FLEET_HEADCOUNT_VERIFY_TIMEOUT_MS = 10_000;

export function computeHeadcountDeficit(target: number, liveMembers: number): number {
  return Math.max(0, Math.floor(target) - Math.max(0, Math.floor(liveMembers)));
}

export function nextHeadcountBackoff(currentMs: number): number {
  return Math.min(15 * 60_000, Math.max(60_000, Math.max(0, currentMs) * 2));
}

export function resolveProductiveCapacityFloor(target: number, configured?: number): number {
  const boundedTarget = Math.max(1, Math.floor(target));
  const raw = Number.isFinite(configured) ? Math.floor(configured as number) : 1;
  return Math.min(boundedTarget, Math.max(1, raw));
}

export interface FleetHeadcountGovernorAssessment {
  target: number;
  productiveCapacityFloor: number;
  liveMemberIds: string[];
  workerReadyMemberIds: string[];
  unreadyMemberIds: string[];
  unverifiedMemberIds: string[];
  pendingOpenedMemberIds: string[];
  pruneCandidateIds: string[];
  deficit: number;
  action: FleetLaunchGovernorAction;
  actionOwnerId: string | null;
  spawnCount: number;
  reason: string;
}

/** Pure P-004 policy. It consumes typed launch evidence but never substitutes it
 * for live roster state: readiness is intersected with the independently-read
 * live ids, and an unverified/slow boot can only produce wait/retry. */
export function assessFleetHeadcountGovernor(args: {
  target: number;
  productiveCapacityFloor?: number;
  liveMemberIds: readonly string[];
  transaction: FleetLaunchTransaction | null | undefined;
  retryLimit?: number;
  now?: number;
}): FleetHeadcountGovernorAssessment {
  const target = Math.max(1, Math.floor(args.target));
  const productiveCapacityFloor = resolveProductiveCapacityFloor(
    target,
    args.productiveCapacityFloor,
  );
  const liveMemberIds = [...new Set(args.liveMemberIds)];
  const live = new Set(liveMemberIds);
  const transaction = args.transaction ?? null;
  const retired = new Set(transaction?.governor?.retiredMemberIds ?? []);
  const attestationByOwner = new Map(
    (transaction?.workerAttestations ?? [])
      .filter((item) => typeof item.ownerId === 'string' && item.ownerId.length > 0)
      .map((item) => [item.ownerId as string, item]),
  );
  const workerReadyMemberIds = liveMemberIds.filter(
    (ownerId) => !retired.has(ownerId) && attestationByOwner.get(ownerId)?.ready === true,
  );
  const unreadyMemberIds = liveMemberIds.filter(
    (ownerId) => !retired.has(ownerId) && attestationByOwner.has(ownerId) && attestationByOwner.get(ownerId)?.ready !== true,
  );
  const unverifiedMemberIds = liveMemberIds.filter(
    (ownerId) => !retired.has(ownerId) && !attestationByOwner.has(ownerId),
  );
  const terminalFailureIds = new Set(
    (transaction?.failed ?? [])
      .filter((failure) => failure.phase === 'verification' || failure.phase === 'attestation')
      .map((failure) => failure.ownerId),
  );
  const verified = new Set(transaction?.verifiedMemberIds ?? []);
  const attempts = transaction?.governor?.attestationAttempts ?? {};
  const retryLimit = Math.max(1, Math.floor(args.retryLimit ?? FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT));
  const pruneCandidateIds = unreadyMemberIds.filter(
    (ownerId) =>
      (attempts[ownerId] ?? 0) >= retryLimit &&
      (verified.has(ownerId) || terminalFailureIds.has(ownerId)),
  );
  const pendingOpenedMemberIds = (transaction?.openedMemberIds ?? []).filter(
    (ownerId) =>
      !retired.has(ownerId) &&
      !live.has(ownerId) &&
      !terminalFailureIds.has(ownerId) &&
      (
        !verified.has(ownerId) ||
        (args.now ?? Date.now()) - (transaction?.requestedAt ?? 0) < FLEET_HEADCOUNT_LAUNCH_WINDOW_MS
      ),
  );
  const retryable = unreadyMemberIds.filter(
    (ownerId) => (attempts[ownerId] ?? 0) < retryLimit,
  );
  const deficit = computeHeadcountDeficit(target, liveMemberIds.length);

  if (pruneCandidateIds.length > 0) {
    return {
      target,
      productiveCapacityFloor,
      liveMemberIds,
      workerReadyMemberIds,
      unreadyMemberIds,
      unverifiedMemberIds,
      pendingOpenedMemberIds,
      pruneCandidateIds,
      deficit,
      action: 'prune',
      actionOwnerId: pruneCandidateIds[0],
      spawnCount: 1,
      reason: `typed worker stages stayed non-ready for ${retryLimit} governor observation(s)`,
    };
  }
  if (pendingOpenedMemberIds.length > 0) {
    return {
      target,
      productiveCapacityFloor,
      liveMemberIds,
      workerReadyMemberIds,
      unreadyMemberIds,
      unverifiedMemberIds,
      pendingOpenedMemberIds,
      pruneCandidateIds,
      deficit,
      action: 'wait',
      actionOwnerId: null,
      spawnCount: 0,
      reason: 'an opened member is still unverified; a late healthy boot must settle before replay',
    };
  }
  if (retryable.length > 0) {
    return {
      target,
      productiveCapacityFloor,
      liveMemberIds,
      workerReadyMemberIds,
      unreadyMemberIds,
      unverifiedMemberIds,
      pendingOpenedMemberIds,
      pruneCandidateIds,
      deficit,
      action: 'retry',
      actionOwnerId: retryable[0],
      spawnCount: 0,
      reason: 'worker stages are observed but not yet terminal; retry after durable backoff',
    };
  }
  if (unreadyMemberIds.length > 0) {
    return {
      target,
      productiveCapacityFloor,
      liveMemberIds,
      workerReadyMemberIds,
      unreadyMemberIds,
      unverifiedMemberIds,
      pendingOpenedMemberIds,
      pruneCandidateIds,
      deficit,
      action: 'wait',
      actionOwnerId: null,
      spawnCount: 0,
      reason: 'non-ready evidence lacks a verified-start or terminal-failure proof; prune is unsafe',
    };
  }
  if (deficit > 0) {
    const floorMet = workerReadyMemberIds.length >= productiveCapacityFloor;
    return {
      target,
      productiveCapacityFloor,
      liveMemberIds,
      workerReadyMemberIds,
      unreadyMemberIds,
      unverifiedMemberIds,
      pendingOpenedMemberIds,
      pruneCandidateIds,
      deficit,
      action: 'spawn',
      actionOwnerId: null,
      spawnCount: floorMet ? Math.min(deficit, FLEET_HEADCOUNT_BULK_WAVE_SIZE) : 1,
      reason: floorMet
        ? 'productive-capacity floor is evidenced; a bounded refill wave is safe'
        : 'productive-capacity floor is not yet evidenced; open one canary only',
    };
  }
  if (unverifiedMemberIds.length > 0) {
    return {
      target,
      productiveCapacityFloor,
      liveMemberIds,
      workerReadyMemberIds,
      unreadyMemberIds,
      unverifiedMemberIds,
      pendingOpenedMemberIds,
      pruneCandidateIds,
      deficit,
      action: 'wait',
      actionOwnerId: null,
      spawnCount: 0,
      reason: 'live members without typed worker attestation remain unknown and are never pruned',
    };
  }
  return {
    target,
    productiveCapacityFloor,
    liveMemberIds,
    workerReadyMemberIds,
    unreadyMemberIds,
    unverifiedMemberIds,
    pendingOpenedMemberIds,
    pruneCandidateIds,
    deficit,
    action: 'none',
    actionOwnerId: null,
    spawnCount: 0,
    reason: 'target and productive-capacity floor are both satisfied',
  };
}

export function governorVerdictForAssessment(
  assessment: FleetHeadcountGovernorAssessment,
  now: number,
  overrides: {
    action?: FleetLaunchGovernorAction;
    reason?: string;
    outcome?: FleetLaunchGovernorVerdict['outcome'];
  } = {},
): FleetLaunchGovernorVerdict {
  const action = overrides.action ?? assessment.action;
  const outcome = overrides.outcome ?? (
    action === 'none'
      ? 'productive'
      : action === 'wait' || action === 'retry'
        ? 'unverified'
        : 'repairing'
  );
  return {
    version: 1,
    outcome,
    decidedAt: now,
    target: assessment.target,
    productiveCapacityFloor: assessment.productiveCapacityFloor,
    liveMemberIds: assessment.liveMemberIds,
    workerReadyMemberIds: assessment.workerReadyMemberIds,
    unreadyMemberIds: assessment.unreadyMemberIds,
    unverifiedMemberIds: [
      ...new Set([...assessment.unverifiedMemberIds, ...assessment.pendingOpenedMemberIds]),
    ],
    action,
    reason: overrides.reason ?? assessment.reason,
  };
}

function ensureGovernorState(
  transaction: FleetLaunchTransaction,
  probeOwnerIds: readonly string[] = transaction.requestedMemberIds,
): FleetLaunchGovernorState {
  if (!transaction.governor) {
    transaction.governor = {
      version: 1,
      probeOwnerIds: [...new Set(probeOwnerIds)],
      attestationAttempts: {},
      retiredMemberIds: [],
      history: [],
      terminalVerdict: null,
    };
  }
  return transaction.governor;
}

function appendGovernorHistory(
  state: FleetLaunchGovernorState,
  event: FleetLaunchGovernorState['history'][number],
): void {
  state.history = [...state.history, event].slice(-FLEET_HEADCOUNT_HISTORY_LIMIT);
}

function recordGovernorVerdict(
  transaction: FleetLaunchTransaction,
  verdict: FleetLaunchGovernorVerdict,
): void {
  const state = ensureGovernorState(transaction);
  state.terminalVerdict = verdict;
  appendGovernorHistory(state, {
    at: verdict.decidedAt,
    action: 'terminal',
    transactionId: transaction.transactionId,
    reason: `${verdict.outcome}/${verdict.action}: ${verdict.reason}`,
  });
  transaction.updatedAt = verdict.decidedAt;
}

async function refreshGovernorWorkerAttestation(
  transaction: FleetLaunchTransaction,
  workspaceId: string,
  now: number,
  expectedAttestations?: FreshLaunchExpectedAttestation[],
): Promise<{ measured: boolean; error: string | null }> {
  const state = ensureGovernorState(transaction);
  const retired = new Set(state.retiredMemberIds);
  const ready = new Set(transaction.workerReadyMemberIds ?? []);
  const probeOwnerIds = state.probeOwnerIds.filter(
    (ownerId) => !retired.has(ownerId) && !ready.has(ownerId),
  );
  if (probeOwnerIds.length === 0) return { measured: true, error: null };
  if (!transaction.launcherOwnerId) {
    return {
      measured: false,
      error: 'legacy launch transaction has no launcherOwnerId/--launched-by correlation key',
    };
  }

  try {
    const verdict = await verifyFreshLaunchStarted(
      {
        workspaceId,
        launcherOwnerId: transaction.launcherOwnerId,
        since: transaction.requestedAt,
        expected: probeOwnerIds.length,
        expectedOwnerIds: probeOwnerIds,
        ...(expectedAttestations?.length ? { expectedAttestations } : {}),
      },
      { timeoutMs: FLEET_HEADCOUNT_VERIFY_TIMEOUT_MS },
    );
    mergeFleetLaunchWorkerAttestations(transaction, verdict.sessions);

    const byOwner = new Map(
      verdict.sessions
        .filter((session) => typeof session.ownerId === 'string')
        .map((session) => [session.ownerId as string, session]),
    );
    for (const ownerId of probeOwnerIds) {
      const session = byOwner.get(ownerId);
      if (!session) continue;
      state.attestationAttempts[ownerId] = session.workerAttestation.ready
        ? 0
        : (state.attestationAttempts[ownerId] ?? 0) + 1;
    }

    const verifiedNow = new Set(
      verdict.sessions
        .filter((session) => session.ownerId != null && session.successfulCalls > 0)
        .map((session) => session.ownerId as string),
    );
    transaction.verifiedMemberIds = [
      ...new Set([...transaction.verifiedMemberIds, ...verifiedNow]),
    ];
    const unconfirmed = new Set(transaction.unconfirmedMemberIds ?? []);
    for (const ownerId of probeOwnerIds) {
      if (verifiedNow.has(ownerId) || verdict.agentStarted === false) unconfirmed.delete(ownerId);
      else unconfirmed.add(ownerId);
    }
    transaction.unconfirmedMemberIds = [...unconfirmed];

    if (verdict.agentStarted === false) {
      const phase = verdict.note.includes('ATTESTATION MISMATCH') ? 'attestation' : 'verification';
      for (const ownerId of probeOwnerIds) {
        if (!transaction.failed.some((failure) => failure.ownerId === ownerId && failure.phase === phase)) {
          transaction.failed.push({ ownerId, phase, reason: verdict.note });
        }
      }
    }
    appendGovernorHistory(state, {
      at: now,
      action: verdict.workerReady ? 'observe' : 'retry',
      transactionId: transaction.transactionId,
      reason: verdict.note.slice(0, 500),
    });
    transaction.updatedAt = now;
    return { measured: true, error: null };
  } catch (error) {
    return {
      measured: false,
      error: `worker-attestation refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function killOutcome(res: unknown): { ok: boolean; alreadyGone: boolean; error: string | null } {
  const data = ((res as { data?: unknown }).data ?? {}) as Record<string, unknown>;
  const counts = data.counts as { failed?: number } | undefined;
  const results = data.results as { ok?: boolean; code?: string; error?: string }[] | undefined;
  const failed = counts?.failed ?? results?.filter((row) => row.ok === false).length ?? 0;
  const alreadyGone = failed > 0 && Boolean(results?.length) && results!.every(
    (row) => row.ok === false && (row.code === 'not_found' || row.error === 'not_found'),
  );
  return {
    ok: failed === 0,
    alreadyGone,
    error: failed === 0 || alreadyGone
      ? null
      : results?.find((row) => row.ok === false)?.error ?? 'fleet:kill failed',
  };
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
  // The family rule moved to goal-launch-settings-shared when the fleet-LAUNCH
  // boundary needed it too (P-006). Delegated rather than copied: a governor that
  // disagreed with the launch door about which fleet is the drain fleet would
  // refill a fleet under a different profile than the one it was opened with —
  // silently heterogeneous members, which is the bug EI-20219409083169975 fixed
  // here in the first place.
  return goalFleetMemberSlot(goalFleetFamily(args));
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

function transactionForGovernorVerdict(args: {
  transaction: FleetLaunchTransaction | null;
  liveMemberIds: readonly string[];
  launcherOwnerId: string | null;
  now: number;
}): FleetLaunchTransaction {
  if (args.transaction) return args.transaction;
  return {
    version: 1,
    transactionId: randomUUID(),
    state: 'partial',
    requestedAt: args.now,
    updatedAt: args.now,
    requestedMemberIds: [...new Set(args.liveMemberIds)],
    openedMemberIds: [],
    verifiedMemberIds: [],
    failed: [],
    waves: [],
    recovery: {
      retryOwnerIds: [],
      nextAction: 'await typed worker evidence; never replace an unverified legacy member',
    },
    ...(args.launcherOwnerId ? { launcherOwnerId: args.launcherOwnerId } : {}),
    governor: {
      version: 1,
      // These members were not launched by this observation transaction. An
      // empty probe cohort prevents a fabricated provenance correlation.
      probeOwnerIds: [],
      attestationAttempts: {},
      retiredMemberIds: [],
      history: [],
      terminalVerdict: null,
    },
  };
}

function governorLaunchTransaction(args: {
  prior: FleetLaunchTransaction | null;
  liveMemberIds: readonly string[];
  newMemberIds: readonly string[];
  launcherOwnerId: string;
  now: number;
  config: FleetHeadcountConfig & { headless: boolean };
  model: string | null;
  account: string;
  action: 'spawn' | 'respawn';
}): FleetLaunchTransaction {
  const live = new Set(args.liveMemberIds);
  const priorAttestations = (args.prior?.workerAttestations ?? []).filter(
    (attestation) => attestation.ownerId != null && live.has(attestation.ownerId),
  );
  const priorReady = (args.prior?.workerReadyMemberIds ?? []).filter((ownerId) => live.has(ownerId));
  const priorVerified = (args.prior?.verifiedMemberIds ?? []).filter((ownerId) => live.has(ownerId));
  const history = [...(args.prior?.governor?.history ?? [])];
  if (args.prior) {
    history.push({
      at: args.now,
      action: 'observe',
      transactionId: args.prior.transactionId,
      reason: `preserved prior launch transaction ${args.prior.transactionId} before governor ${args.action}`,
    });
  }
  history.push({
    at: args.now,
    action: args.action,
    reason: `${args.action} wave pre-pinned ${args.newMemberIds.length} replacement/refill identity(s)`,
  });
  const requestedMemberIds = [...new Set([...args.liveMemberIds, ...args.newMemberIds])];
  const transaction: FleetLaunchTransaction = {
    version: 1,
    transactionId: randomUUID(),
    ...(args.prior ? { previousTransactionId: args.prior.transactionId } : {}),
    launcherOwnerId: args.launcherOwnerId,
    state: 'launching',
    requestedAt: args.now,
    updatedAt: args.now,
    requestedMemberIds,
    openedMemberIds: [],
    verifiedMemberIds: priorVerified,
    unconfirmedMemberIds: [...args.newMemberIds],
    ...(priorReady.length ? { workerReadyMemberIds: priorReady } : {}),
    ...(priorAttestations.length ? { workerAttestations: priorAttestations } : {}),
    failed: [],
    waves: [{ index: 0, ownerIds: [...args.newMemberIds], state: 'opening' }],
    recovery: {
      retryOwnerIds: [...args.newMemberIds],
      nextAction: 'refresh typed worker attestation before any replay',
    },
    requestedMembers: args.newMemberIds.map((ownerId, index) => ({
      index,
      ownerId,
      agent: args.config.agent,
      model: args.model,
      account: args.account,
      carry: args.config.carry ?? 'warm',
      headless: args.config.headless,
    })),
    governor: {
      version: 1,
      probeOwnerIds: [...args.newMemberIds],
      attestationAttempts: {},
      retiredMemberIds: [...new Set(args.prior?.governor?.retiredMemberIds ?? [])],
      history: history.slice(-FLEET_HEADCOUNT_HISTORY_LIMIT),
      terminalVerdict: null,
    },
  };
  return transaction;
}

async function topUpOneFleet(workspaceId: string, fleetSlug: string): Promise<void> {
  const attempt = await claimFleetHeadcountAttempt({ workspaceId, fleetSlug });
  if (!attempt) return;
  const fleet = await getFleet(workspaceId, fleetSlug);
  if (!fleet) return;
  try {
    const config = resolveFleetHeadcountProfile(attempt.config);
    const productiveCapacityFloor = resolveProductiveCapacityFloor(
      attempt.target,
      config.productiveCapacityFloor,
    );
    const now = Date.now();
    let liveMemberIds = (await liveFleetMemberIds(fleetSlug, workspaceId, 'launch'))
      .filter((id) => id !== fleet.leaderOwnerId);
    let transaction = fleet.lastLaunchTransaction;

    if (transaction) {
      const refreshed = await refreshGovernorWorkerAttestation(transaction, workspaceId, now);
      if (!refreshed.measured) {
        const assessment = assessFleetHeadcountGovernor({
          target: attempt.target,
          productiveCapacityFloor,
          liveMemberIds,
          transaction,
          now,
        });
        const verdict = governorVerdictForAssessment(assessment, now, {
          action: 'wait',
          outcome: 'unverified',
          reason: refreshed.error ?? 'worker-attestation refresh is unverified',
        });
        recordGovernorVerdict(transaction, verdict);
        transaction.recovery.nextAction = verdict.reason;
        await setFleetLaunchTransaction({ workspaceId, fleetSlug, transaction });
        await recordFleetHeadcountAttempt({
          workspaceId,
          fleetSlug,
          succeeded: false,
          error: verdict.reason,
        });
        return;
      }
    }

    let assessment = assessFleetHeadcountGovernor({
      target: attempt.target,
      productiveCapacityFloor,
      liveMemberIds,
      transaction,
      now,
    });

    if (assessment.action === 'none' || assessment.action === 'wait' || assessment.action === 'retry') {
      transaction = transactionForGovernorVerdict({
        transaction,
        liveMemberIds,
        launcherOwnerId: fleet.leaderOwnerId,
        now,
      });
      const verdict = governorVerdictForAssessment(assessment, now);
      recordGovernorVerdict(transaction, verdict);
      transaction.recovery.nextAction = verdict.reason;
      await setFleetLaunchTransaction({ workspaceId, fleetSlug, transaction });
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: assessment.action === 'none',
        ...(assessment.action === 'none' ? {} : { error: assessment.reason }),
      });
      return;
    }

    const launcherOwnerId = fleet.leaderOwnerId;
    if (!launcherOwnerId) {
      transaction = transactionForGovernorVerdict({
        transaction,
        liveMemberIds,
        launcherOwnerId: null,
        now,
      });
      const verdict = governorVerdictForAssessment(assessment, now, {
        action: 'wait',
        outcome: 'failed',
        reason: 'fleet has no durable leader identity; unattended governor launch is refused',
      });
      recordGovernorVerdict(transaction, verdict);
      await setFleetLaunchTransaction({ workspaceId, fleetSlug, transaction });
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: false,
        error: verdict.reason,
      });
      return;
    }

    const pruneOwnerId = assessment.action === 'prune' ? assessment.actionOwnerId : null;
    const action: 'spawn' | 'respawn' = pruneOwnerId ? 'respawn' : 'spawn';
    const waveCount = pruneOwnerId ? 1 : assessment.spawnCount;

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
      launcherOwnerId,
    );
    const goalLaunch = await resolveGoalLaunch({
      workspaceId,
      launcherOwnerId,
      // D-016 (WI-38048): `config.role` is psu `--role`, a persona — NOT a launch
      // slot, so it must not key the goal's profiles. The slot above is derived
      // from durable goal context instead.
      goalRole,
      fleetSlug,
      count: waveCount,
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
    const effectiveModel = goalLaunch.effective.model ?? config.model;
    const effectiveEffort = goalLaunch.effective.effort ?? config.effort;
    const effectiveAccount = goalLaunch.effective.account ?? config.account ?? 'default';
    const modelSpec = composeModelSpec(effectiveModel, effectiveEffort) ?? null;
    const newMemberIds = Array.from({ length: waveCount }, () => `su-${randomUUID()}`);
    const commands = newMemberIds.map((ownerId) => injectLaunchedByArg(memberLaunchCommand({
      fleetSlug,
      agent: config.agent,
      harness: config.harness,
      plan: config.plan,
      headless: config.headless,
      ownerId,
      workspace: workspaceId,
      // The goal's profile applies to a governor top-up exactly as it does to the
      // leader's own launches — otherwise a replaced member silently comes back
      // on a different model/account than the one the goal pinned.
      model: effectiveModel,
      effort: effectiveEffort,
      account: effectiveAccount,
      role: config.role,
      launchContext,
      contextSize: config.contextSize,
      compactionLimit: config.compactionLimit,
      carry: config.carry,
      extraArgs: config.extraArgs,
    }), launcherOwnerId).command);
    const expectedAttestations: FreshLaunchExpectedAttestation[] = newMemberIds.map((ownerId) => ({
      ownerId,
      agent: config.agent,
      workspaceId,
      harnessSlug: config.harness,
      planSlug: config.plan,
      model: modelSpec,
      effort: modelEffortFromSpec(modelSpec),
      account: effectiveAccount,
      carry: config.carry ?? 'warm',
      visibility: config.headless ? 'headless' : 'visible',
      fleetSlug,
      fleetRole: 'member',
    }));

    const slot = await claimFleetLaunchSlot({
      workspaceId,
      fleetSlug,
      count: waveCount,
      windowMs: FLEET_HEADCOUNT_LAUNCH_WINDOW_MS,
    });
    if (!slot.won) {
      transaction = transactionForGovernorVerdict({
        transaction,
        liveMemberIds,
        launcherOwnerId,
        now,
      });
      const verdict = governorVerdictForAssessment(assessment, now, {
        action: 'wait',
        outcome: 'unverified',
        reason: `repair suppressed by launch window; prior wave at ${slot.priorAt}`,
      });
      recordGovernorVerdict(transaction, verdict);
      await setFleetLaunchTransaction({ workspaceId, fleetSlug, transaction });
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: false,
        error: verdict.reason,
      });
      return;
    }

    if (pruneOwnerId) {
      const killed = killOutcome(await killTool.handler(
        {
          owner: pruneOwnerId,
          reason: `fleet headcount governor: ${assessment.reason}`,
          close_terminal: true,
          workspace: workspaceId,
        } as never,
        {
          principal: {
            slug: 'system:fleet-headcount-governor',
            kind: 'system',
            workspaceId,
          },
          workspaceId,
          harnessSlug: config.harness,
        } as never,
      ));
      if (!killed.ok && !killed.alreadyGone) {
        await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at }).catch(() => {});
        transaction = transactionForGovernorVerdict({
          transaction,
          liveMemberIds,
          launcherOwnerId,
          now,
        });
        const verdict = governorVerdictForAssessment(assessment, now, {
          action: 'prune',
          outcome: 'failed',
          reason: `typed prune was refused: ${killed.error ?? 'unknown fleet:kill failure'}`,
        });
        recordGovernorVerdict(transaction, verdict);
        await setFleetLaunchTransaction({ workspaceId, fleetSlug, transaction });
        await recordFleetHeadcountAttempt({
          workspaceId,
          fleetSlug,
          succeeded: false,
          error: verdict.reason,
        });
        return;
      }
      if (transaction) {
        const state = ensureGovernorState(transaction);
        state.retiredMemberIds = [...new Set([...state.retiredMemberIds, pruneOwnerId])];
        transaction.workerReadyMemberIds = (transaction.workerReadyMemberIds ?? [])
          .filter((ownerId) => ownerId !== pruneOwnerId);
        transaction.unconfirmedMemberIds = (transaction.unconfirmedMemberIds ?? [])
          .filter((ownerId) => ownerId !== pruneOwnerId);
        appendGovernorHistory(state, {
          at: now,
          action: 'prune',
          transactionId: transaction.transactionId,
          ownerId: pruneOwnerId,
          replacementOwnerId: newMemberIds[0],
          reason: assessment.reason,
        });
        transaction.updatedAt = now;
        await setFleetLaunchTransaction({ workspaceId, fleetSlug, transaction });
      }
      liveMemberIds = liveMemberIds.filter((ownerId) => ownerId !== pruneOwnerId);
    }

    const launchTransaction = governorLaunchTransaction({
      prior: transaction,
      liveMemberIds,
      newMemberIds,
      launcherOwnerId,
      now,
      config,
      model: modelSpec,
      account: effectiveAccount,
      action,
    });
    if (pruneOwnerId) {
      appendGovernorHistory(launchTransaction.governor!, {
        at: now,
        action: 'respawn',
        transactionId: launchTransaction.transactionId,
        ownerId: pruneOwnerId,
        replacementOwnerId: newMemberIds[0],
        reason: assessment.reason,
      });
    }
    await setFleetLaunchTransaction({ workspaceId, fleetSlug, transaction: launchTransaction });

    const logDir = config.headless ? `${papercuspPathForWorkspace(workspaceId)}/fleet-logs` : null;
    const results = await Promise.all(
      newMemberIds.map((ownerId, i) =>
        config.headless
          ? spawnHeadless({
              envelope: { ...envelope, greetingCmd: commands[i], cwd: envelope.cwd },
              label: `${fleetSlug} · governor member ${i + 1}/${waveCount} (${config.plan})`,
              logDir: logDir!,
              launchedBy: launcherOwnerId,
              fleetSlug,
              coordOwnerId: ownerId,
            })
          : spawnConsole({
              envelope: { ...envelope, greetingCmd: commands[i], cwd: envelope.cwd },
              label: `${fleetSlug} · governor member ${i + 1}/${waveCount} (${config.plan})`,
              writeMcpJson: false,
              allowDesktopBridge: true,
            }),
      ),
    );
    const openedMemberIds: string[] = [];
    results.forEach((result, index) => {
      const ownerId = newMemberIds[index];
      if (result.status === 'ok') openedMemberIds.push(ownerId);
      else launchTransaction.failed.push({ ownerId, phase: 'spawn', reason: result.error });
    });
    launchTransaction.openedMemberIds = openedMemberIds;
    launchTransaction.waves[0].openedOwnerIds = [...openedMemberIds];
    launchTransaction.governor!.probeOwnerIds = [...openedMemberIds];
    launchTransaction.unconfirmedMemberIds = [...openedMemberIds];
    launchTransaction.recovery.retryOwnerIds = newMemberIds.filter(
      (ownerId) => !openedMemberIds.includes(ownerId),
    );
    launchTransaction.waves[0].state = openedMemberIds.length === newMemberIds.length ? 'partial' : 'partial';
    await setFleetLaunchTransaction({ workspaceId, fleetSlug, transaction: launchTransaction });

    if (openedMemberIds.length === 0) {
      await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at }).catch(() => {});
    }

    const refresh = openedMemberIds.length > 0
      ? await refreshGovernorWorkerAttestation(
          launchTransaction,
          workspaceId,
          Date.now(),
          expectedAttestations.filter((item) => openedMemberIds.includes(item.ownerId)),
        )
      : { measured: false, error: 'no member process opened' };
    const verified = new Set(launchTransaction.verifiedMemberIds);
    launchTransaction.recovery.retryOwnerIds = newMemberIds.filter((ownerId) => !verified.has(ownerId));
    if (openedMemberIds.length === newMemberIds.length && openedMemberIds.every((ownerId) => verified.has(ownerId))) {
      launchTransaction.state = 'verified';
      launchTransaction.waves[0].state = 'verified';
      launchTransaction.waves[0].verifiedOwnerIds = [...openedMemberIds];
    } else {
      launchTransaction.state = 'partial';
    }

    let rosterError: string | null = null;
    try {
      liveMemberIds = (await liveFleetMemberIds(fleetSlug, workspaceId, 'launch'))
        .filter((id) => id !== launcherOwnerId);
    } catch (error) {
      rosterError = `post-launch live roster read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    assessment = assessFleetHeadcountGovernor({
      target: attempt.target,
      productiveCapacityFloor,
      liveMemberIds,
      transaction: launchTransaction,
      now: Date.now(),
    });
    const spawnFailures = results.length - openedMemberIds.length;
    const terminalReason = spawnFailures > 0
      ? `${spawnFailures}/${results.length} ${config.headless ? 'headless' : 'visible'} governor spawn(s) failed`
      : refresh.error ?? rosterError ?? assessment.reason;
    const terminalVerdict = governorVerdictForAssessment(assessment, Date.now(),
      spawnFailures > 0
        ? { action, outcome: 'failed', reason: terminalReason }
        : refresh.error || rosterError
          ? { action: 'wait', outcome: 'unverified', reason: terminalReason }
          : {});
    recordGovernorVerdict(launchTransaction, terminalVerdict);
    launchTransaction.recovery.nextAction = terminalVerdict.reason;
    await setFleetLaunchTransaction({ workspaceId, fleetSlug, transaction: launchTransaction });
    await recordFleetHeadcountAttempt({
      workspaceId,
      fleetSlug,
      succeeded: terminalVerdict.outcome === 'productive',
      ...(terminalVerdict.outcome === 'productive' ? {} : { error: terminalVerdict.reason }),
    });
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
