/**
 * D-003 — "Accepted capacity pressure becomes a durable receipt": when persistence works,
 * capacity pressure must NOT surface as QueueFullError / a load-shed 429.
 *
 * These assert on PriorityAdmissionQueue directly rather than through startGatewayService. The
 * property under test is a property OF THE QUEUE CAP, and the gateway's own contribution is one
 * line (`deps.maxQueued ?? (payloadSpool ? 0 : DEFAULT_MAX_QUEUED)`). Driving a full HTTP gateway
 * to backlog saturation to observe it would test the harness, not the rule.
 */
import { describe, expect, it } from 'vitest';
// Same specifier gateway.ts imports these from, so the test cannot drift onto a second copy.
import { PriorityAdmissionQueue, QueueFullError } from '@papercusp/papercusp-shared/agent';

/** A task that never settles until released — the only way to hold every slot busy on purpose. */
function pendingTask(): { task: () => Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { task: () => gate, release };
}

describe('D-003 — load-shed retirement under a working payload spool', () => {
  it('sheds with QueueFullError when a backlog cap is set (the legacy, spool-less path)', async () => {
    // The control. Without a spool the gateway keeps DEFAULT_MAX_QUEUED, and this is the behaviour
    // that must be preserved for callers that have not opted into durable persistence.
    const queue = new PriorityAdmissionQueue({ maxConcurrent: 1, maxQueued: 1 });
    const held = pendingTask();

    void queue.run(0, held.task); // occupies the only slot
    void queue.run(0, async () => {}); // occupies the only backlog place
    const shed = queue.run(0, async () => {});

    await expect(shed).rejects.toBeInstanceOf(QueueFullError);
    held.release();
  });

  it('never sheds when the cap is disabled — the spool-active path', async () => {
    // maxQueued: 0 is what gateway.ts passes once a payloadSpool is configured. Capacity pressure
    // must then queue, not reject: the durable receipt is the backpressure, and the body is in
    // Postgres rather than resident memory, which is what makes an uncapped backlog safe.
    const queue = new PriorityAdmissionQueue({ maxConcurrent: 1, maxQueued: 0 });
    const held = pendingTask();
    void queue.run(0, held.task);

    const settled: number[] = [];
    // Far beyond any sane in-memory cap — none of these may be rejected.
    const waiters = Array.from({ length: 500 }, (_, i) =>
      queue.run(0, async () => {
        settled.push(i);
      }),
    );

    // Nothing rejects while every slot is busy and the backlog is 500 deep.
    await Promise.resolve();
    expect(queue.snapshot().queued).toBe(500);

    held.release();
    await Promise.all(waiters); // resolves — never a QueueFullError
    expect(settled).toHaveLength(500);
  });

  it('still limits CONCURRENCY when the backlog cap is off', async () => {
    // Retiring the rejection must not retire the concurrency bound — otherwise "no load-shed"
    // would mean "no admission control", which is not what D-003 says.
    const queue = new PriorityAdmissionQueue({ maxConcurrent: 2, maxQueued: 0 });
    let concurrent = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 25 }, () =>
        queue.run(0, async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 1));
          concurrent -= 1;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('runs a task immediately when a slot is free, cap or no cap', async () => {
    // Guards the queue's documented "a free slot always runs the task regardless of the cap"
    // clause, which the uncapped path must not change.
    const capped = new PriorityAdmissionQueue({ maxConcurrent: 1, maxQueued: 1 });
    const uncapped = new PriorityAdmissionQueue({ maxConcurrent: 1, maxQueued: 0 });

    await expect(capped.run(0, async () => 'ran')).resolves.toBe('ran');
    await expect(uncapped.run(0, async () => 'ran')).resolves.toBe('ran');
  });
});
