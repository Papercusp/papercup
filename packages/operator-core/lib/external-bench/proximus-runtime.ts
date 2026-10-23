/** D-059/D-060: bind the official host loop to the existing task/grade contract.
 * This specification grants no process, credential, request or spend authority.
 */
import { requireCurrentBenchmarkAssignment } from './reproducibility/schema';
import type { FrontierSweEnvHandle } from './frontier-swe-seam';

export function proximusRunSpec(config: unknown, execution: Parameters<typeof requireCurrentBenchmarkAssignment>[1] & {
  handle: Pick<FrontierSweEnvHandle, 'containerId' | 'image' | 'instanceId'>;
  /** Host-measured installed dependency digest; never obtained from agent output. */
  runtimeRevision: string;
  /** Hard process deadline, including finalization. */
  maxWallClockMs: number;
  outputTokenLimit: number;
}) {
  const protocol = requireCurrentBenchmarkAssignment(config, execution);
  const arm = protocol.arms.find(arm => arm.id === execution.armId)!;
  const runtime = arm.runtime.proximus;
  if (arm.agent !== 'proximus' || !runtime || execution.runtimeRevision !== arm.runtime.runtimeRevision ||
      !execution.handle.containerId.trim() || execution.handle.instanceId !== execution.taskId ||
      execution.handle.image !== protocol.grader.images?.[execution.taskId]) {
    throw new Error('Proximus requires its exact installed runtime and immutable FrontierSWE task image.');
  }
  const rate = protocol.priceSchedule.rates.find(rate => rate.model === arm.model)!;
  if (!Number.isSafeInteger(execution.maxWallClockMs) || execution.maxWallClockMs <= 0 ||
      execution.maxWallClockMs > arm.generationBudget.maxWallClockMs ||
      !Number.isSafeInteger(execution.outputTokenLimit) || execution.outputTokenLimit <= 0 ||
      execution.outputTokenLimit > rate.outputTokenCeiling! ||
      arm.generationBudget.maxTokens !== undefined && execution.outputTokenLimit > arm.generationBudget.maxTokens) {
    throw new Error('Proximus hard time/output allowance is invalid or wider than its frozen caps.');
  }
  // The host process deadline remains exact. Upstream hard_timeout_sec adds
  // finalization headroom; it must never replace/widen this hard allowance.
  return Object.freeze({
    agent: 'harbor_proximus:Proximus' as const,
    sourceRevision: arm.runtime.sourceRevision, runtimeRevision: arm.runtime.runtimeRevision,
    clientVersion: arm.runtime.clientVersion, harborVersion: runtime.harborVersion,
    containerId: execution.handle.containerId, taskId: execution.taskId, image: execution.handle.image,
    model: arm.model, modelName: `${runtime.provider}/${arm.model}`, provider: runtime.provider,
    maxWallClockMs: execution.maxWallClockMs, maxUsd: arm.generationBudget.maxUsd,
    options: Object.freeze({
      time_budget_sec: execution.maxWallClockMs / 1000, reasoning_effort: arm.effort,
      model_info: Object.freeze({ max_input_tokens: runtime.maxInputTokens, supports_vision: runtime.supportsVision,
        ...(runtime.provider === 'openai' ? { mode: 'responses' } : {}) }),
      llm_call_kwargs: Object.freeze({ max_tokens: execution.outputTokenLimit }),
    }),
  });
}

export type ProximusRunSpec = ReturnType<typeof proximusRunSpec>;
