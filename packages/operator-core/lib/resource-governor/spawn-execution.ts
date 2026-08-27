import type { ChildProcess } from 'node:child_process';

import type { SpawnChildExit, SpawnConsoleResult } from '../console-spawn';
import type { AdmissionContext, AdmissionMetadataValue, ResourceDemand } from './admission';
import { beginGovernedExecution, governedExecutionRuntime, type GovernedExecution } from './execution';

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
};

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
 */
export async function spawnGovernedAgentProcess(
  input: GovernedProcessSpawnInput,
  spawnProcess: (context: AdmissionContext) => Promise<SpawnConsoleResult>,
): Promise<GovernedSpawnResult> {
  const execution = await beginGovernedExecution(
    {
      idempotencyKey: input.idempotencyKey,
      admissionClass: 'agent',
      demand: input.demand ?? { cpuWeight: 1 },
      payloadRef: input.payloadRef,
      parent: input.parent,
      metadata: input.metadata,
    },
    { owner: input.owner },
    governedExecutionRuntime(input.workspaceId, 'agent-process'),
  );

  let result: SpawnConsoleResult;
  try {
    result = await spawnProcess(execution.context);
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
  return { ...result, admissionContext: execution.context };
}
