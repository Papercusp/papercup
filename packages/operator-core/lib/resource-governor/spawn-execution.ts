import type { ChildProcess } from 'node:child_process';

import type { SpawnChildExit, SpawnConsoleResult } from '../console-spawn';
import type { AdmissionContext, AdmissionMetadataValue, ResourceDemand } from './admission';
import { beginGovernedExecution, governedExecutionRuntime, type GovernedExecution } from './execution';
import { withAgentSpawnPacing } from './spawn-pacing';

export interface GovernedProcessSpawnInput {
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly owner: string;
  readonly payloadRef?: string;
  readonly parent?: AdmissionContext;
  readonly demand?: ResourceDemand;
  readonly metadata?: Readonly<Record<string, AdmissionMetadataValue>>;
}

export type GovernedSpawnResult = SpawnConsoleResult & {
  /** Durable context for nested work started by the spawned process. */
  admissionContext?: AdmissionContext;
  goalAdmissionDegraded?: string[];
};

/**
 * Whether the resource governor can hold or refuse an agent launch at this door.
 *
 * 'observe-only': `beginGovernedExecution` enqueues the durable receipt and the caller
 * immediately takes a TARGETED lease on it; no controller decision is consulted, so the
 * governor records agent launches but never restricts them (spawn-door-governor-migration
 * P-003; its binding migration is P-005..P-012). Readers that judge "was an agent launch
 * admissible" (goal-placement-turn-receipts.ts, plan goal-brief D-031) treat an
 * unpublished agent-class admission state as open ONLY while this reads 'observe-only'.
 *
 * Flip to 'binding' in the same change that makes this door wait on a controller.
 * execution.test.ts pins the targeted-lease behavior against this value, so that change
 * fails there until the declaration moves with it.
 */
export const AGENT_ADMISSION_GOVERNOR_BINDING: 'observe-only' | 'binding' = 'observe-only';

function observeVisibleChild(child: ChildProcess): Promise<SpawnChildExit> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });
}

function settleOnExit(execution: GovernedExecution, exit: Promise<SpawnChildExit>): void {
  void exit.then(
    () => execution.finish(),
    () => execution.finish(),
  );
}

/**
 * Admit at the actual process-start boundary, then keep the durable lease for
 * the lifetime of the spawned terminal process. A spawn failure cancels the
 * visible receipt; a process exit exact-releases it. Callers receive the
 * context so nested fan-out can pass it back as `parent`.
 *
 * TWO DIFFERENT CEILINGS APPLY HERE, and only one of them is the governor's.
 * The durable lease above rations STEADY-STATE agent capacity and is held until the
 * process exits — a fleet is supposed to run twenty agents at once, so that lease
 * cannot also bound how many agents may be BOOTING at once. Boot is the scarcer
 * resource: a starting agent boots a CLI, restores its transcript and completes an MCP
 * handshake, and its kickoff brief survives only if that finishes inside psu-pty-host's
 * fixed submit-verify budget. `withAgentSpawnPacing` supplies the missing ceiling
 * (EI-21935016329074048 — a 21-way simultaneous burst blew that budget and dropped two
 * briefs while every launch reported success).
 *
 * The pacing wraps ONLY the spawn call, never admission: the durable receipt must be
 * taken first so a queued launch is still visible to the governor as intended work
 * rather than disappearing into an unaccounted local wait.
 */
export async function spawnGovernedAgentProcess(
  input: GovernedProcessSpawnInput,
  spawnProcess: (context: AdmissionContext) => Promise<SpawnConsoleResult>,
): Promise<GovernedSpawnResult> {
  const register = (goalId: string | null) => beginGovernedExecution(
    {
      idempotencyKey: input.idempotencyKey,
      admissionClass: 'agent',
      demand: input.demand ?? { cpuWeight: 1 },
      payloadRef: input.payloadRef,
      parent: input.parent,
      metadata: goalId ? { ...input.metadata, goalId, goalReservation: true } : input.metadata,
    },
    { owner: input.owner },
    governedExecutionRuntime(input.workspaceId, 'agent-process'),
  );

  // Both fleet launch and ad-hoc launch enter here. A tool-level preflight is
  // useful for a batch, but cannot reserve against another concurrent tool.
  const launchedBy = input.metadata?.launchedBy;
  const admitted = typeof launchedBy === 'string' && launchedBy
    ? await (await import('../goal-launch-settings')).registerGoalLaunch({
        workspaceId: input.workspaceId, launcherOwnerId: launchedBy,
        targetOwnerId: typeof input.metadata?.targetOwnerId === 'string' ? input.metadata.targetOwnerId : null,
        fleetSlug: typeof input.metadata?.fleetSlug === 'string' ? input.metadata.fleetSlug : null,
        excludeOwnerIds: typeof input.metadata?.replacesOwnerId === 'string' ? [input.metadata.replacesOwnerId] : [],
      }, register)
    : { value: await register(null), resolution: null, degradedReason: null };
  if (admitted.resolution?.refusal) {
    return { status: 'error', error: admitted.resolution.refusal.message, code: 409 };
  }
  const execution = admitted.value!;
  const goalAdmissionDegraded = [
    ...(admitted.resolution?.degradedReasons ?? []), ...(admitted.degradedReason ? [admitted.degradedReason] : []),
  ];

  let result: SpawnConsoleResult;
  try {
    result = await withAgentSpawnPacing(() => spawnProcess(execution.context));
  } catch (error) {
    await execution.cancel(`spawn threw: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  if (result.status === 'error') {
    await execution.cancel(result.error);
    return result;
  }

  const exit = result.childExit ?? (result.child ? observeVisibleChild(result.child) : null);
  if (exit) settleOnExit(execution, exit);
  return { ...result, admissionContext: execution.context,
    ...(goalAdmissionDegraded.length ? { goalAdmissionDegraded } : {}) };
}
