import { describe, it, expect } from 'vitest';
import { classifyGymRun } from '../pipeline-status';

/**
 * The runner polls the DBOS workflow status + the feature status until the run is
 * terminal. This pure classifier maps a snapshot → outcome, so the polling glue
 * stays trivial. The pipeline is fire-and-forget (no synchronous result), so the
 * DBOS terminal status is the authoritative "run finished" signal; the feature
 * status supplies the outcome. Outcome is observability (D-011), not a reward.
 */
const LONG = 60 * 60 * 1000; // 1h deadline

describe('classifyGymRun', () => {
  it('is running while the workflow is live and under the deadline', () => {
    expect(classifyGymRun({ workflowStatus: 'PENDING', featureStatus: 'in_progress', elapsedMs: 1000, timeoutMs: LONG }))
      .toEqual({ outcome: 'running', terminal: false });
    expect(classifyGymRun({ workflowStatus: 'ENQUEUED', featureStatus: null, elapsedMs: 0, timeoutMs: LONG }))
      .toEqual({ outcome: 'running', terminal: false });
  });

  it('times out when still live past the deadline (caller cancels)', () => {
    expect(classifyGymRun({ workflowStatus: 'PENDING', featureStatus: 'in_progress', elapsedMs: LONG + 1, timeoutMs: LONG }))
      .toEqual({ outcome: 'timeout', terminal: true });
  });

  it('maps workflow SUCCESS + feature passed/shipped → passed', () => {
    expect(classifyGymRun({ workflowStatus: 'SUCCESS', featureStatus: 'passed', elapsedMs: 5, timeoutMs: LONG }))
      .toEqual({ outcome: 'passed', terminal: true });
    expect(classifyGymRun({ workflowStatus: 'SUCCESS', featureStatus: 'shipped', elapsedMs: 5, timeoutMs: LONG }))
      .toEqual({ outcome: 'passed', terminal: true });
  });

  it('maps workflow SUCCESS + feature failing/failed → failed', () => {
    expect(classifyGymRun({ workflowStatus: 'SUCCESS', featureStatus: 'failing', elapsedMs: 5, timeoutMs: LONG }))
      .toEqual({ outcome: 'failed', terminal: true });
    expect(classifyGymRun({ workflowStatus: 'SUCCESS', featureStatus: 'failed', elapsedMs: 5, timeoutMs: LONG }))
      .toEqual({ outcome: 'failed', terminal: true });
  });

  it('maps workflow SUCCESS + blocked/no-clean-outcome → escalated', () => {
    expect(classifyGymRun({ workflowStatus: 'SUCCESS', featureStatus: 'blocked', elapsedMs: 5, timeoutMs: LONG }))
      .toEqual({ outcome: 'escalated', terminal: true });
    expect(classifyGymRun({ workflowStatus: 'SUCCESS', featureStatus: null, elapsedMs: 5, timeoutMs: LONG }))
      .toEqual({ outcome: 'escalated', terminal: true });
  });

  it('maps a workflow ERROR to errored regardless of feature status', () => {
    expect(classifyGymRun({ workflowStatus: 'ERROR', featureStatus: 'passed', elapsedMs: 5, timeoutMs: LONG }))
      .toEqual({ outcome: 'errored', terminal: true });
    expect(classifyGymRun({ workflowStatus: 'CANCELLED', featureStatus: 'validating', elapsedMs: 5, timeoutMs: LONG }))
      .toEqual({ outcome: 'errored', terminal: true });
  });

  it('normalizes status casing', () => {
    expect(classifyGymRun({ workflowStatus: 'success', featureStatus: 'PASSED', elapsedMs: 5, timeoutMs: LONG }))
      .toEqual({ outcome: 'passed', terminal: true });
  });
});
