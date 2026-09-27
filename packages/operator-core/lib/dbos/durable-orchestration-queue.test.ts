import { describe, expect, it } from 'vitest';

import {
  DURABLE_ORCHESTRATION_QUEUE_MIN_POLL_MS,
  durableOrchestrationQueue,
} from './durable-orchestration-workflow';

/**
 * WI-10003560 / plan blueprint-backed D-023. DBOS dispatches a queued workflow only when its queue
 * runner next polls, and nothing wakes the runner on enqueue. At the SDK default (1000 ms) every
 * durable orchestrate:run waited U(0, 1 s) before its first step, which failed P-013 workload D
 * (warm p50 1010 ms against a 157 ms ceiling). These assertions stop the queue from silently
 * falling back to the default.
 */
describe('durable-orchestration queue poll floor', () => {
  it('configures the queue with the declared poll floor instead of the 1000 ms SDK default', () => {
    expect(durableOrchestrationQueue.name).toBe('durable-orchestration');
    expect(durableOrchestrationQueue.minPollingIntervalMs).toBe(DURABLE_ORCHESTRATION_QUEUE_MIN_POLL_MS);
  });

  it('keeps the expected dispatch wait well inside the D-016 workload-D p50 headroom', () => {
    // The D p50 ceiling is 1.5x control + 50 ms. A uniform wait over [0, floor] has mean floor/2,
    // so a floor above 100 ms would spend the whole +50 ms allowance on the poll alone.
    expect(DURABLE_ORCHESTRATION_QUEUE_MIN_POLL_MS).toBeGreaterThan(0);
    expect(DURABLE_ORCHESTRATION_QUEUE_MIN_POLL_MS).toBeLessThanOrEqual(100);
  });
});
