/**
 * bee-instance.test.ts — the P-001 runInstance await/terminal-mapping + the rate-limit RELAUNCH
 * loop (Apiary gen-0). Pure unit coverage with a fake clock + injected spawn/poll/failure-text
 * effects — zero spawn, zero spend.
 *
 * Proves: done/genuine-failure → a scoreable handle; cancelled/reaped/timeout → throw (errored);
 * and a bee that fails on a TRANSIENT rate-limit/overload is RELAUNCHED (a fresh bee) up to
 * maxRateRetries, then surfaced as rate_limited if it never clears — the owner's hit-limit →
 * relaunch loop (the fleet AIMD governor supplies the "lower cap" half in the live system).
 */
import { describe, it, expect, vi } from 'vitest';
import { makeBeeRunInstance, type BeeRunDeps } from './bee-instance';
import type { BeekeeperRunInput } from './beekeeper-runner';
import type { CorpusCase } from './corpus';
import type { InstanceBootSpec } from './instance-manifest';

const CFG = { timeoutMs: 1000, pollMs: 100, maxRateRetries: 2, rateBackoffMs: 50 };

const CASE = { id: 'c-1', variant: 'fix-injected-bug', title: 't', prompt: 'fix the bug' } as unknown as CorpusCase;
const SPEC = {
  manifest: { instanceId: 'inst', workspaceId: 'w', codeSha: 'sha', createdAt: new Date() },
  instanceUrl: 'mock://x',
} as InstanceBootSpec;
const INPUT: BeekeeperRunInput = { case: CASE, repeat: 0, instanceSpec: SPEC };

const RATE_TEXT = 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';
const TASK_FAIL_TEXT = 'TypeError: undefined is not a function';

interface Attempt {
  /** poll sequence for this attempt; the loop stops at the first terminal value. */
  poll: Array<string | null>;
  /** output_tail/error_message returned for a `failed` terminal (default: a genuine task failure). */
  failText?: string;
}

/** A fake clock advancing on each sleep; each spawn() advances to the next attempt (new spawn id). */
function fakeDeps(opts: {
  attempts: Attempt[];
  spawnOk?: boolean;
  spawnError?: string;
  cost?: number;
  onRetry?: BeeRunDeps['onRateLimitRetry'];
}): BeeRunDeps {
  let attemptIdx = -1;
  let pollIdx = 0;
  const clock = { t: 0 };
  const at = () => opts.attempts[Math.min(attemptIdx, opts.attempts.length - 1)];
  return {
    spawn: async () => {
      if (opts.spawnOk === false) return { ok: false, spawnId: null, error: opts.spawnError ?? 'rejected' };
      attemptIdx += 1;
      pollIdx = 0;
      return { ok: true, spawnId: `s-bee-${attemptIdx + 1}`, error: null };
    },
    pollStatus: async () => {
      const seq = at().poll;
      const s = seq[Math.min(pollIdx, seq.length - 1)];
      pollIdx += 1;
      return s;
    },
    loadFailureText: async () => at().failText ?? TASK_FAIL_TEXT,
    loadCost: async () => opts.cost ?? 0,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    now: () => clock.t,
    onRateLimitRetry: opts.onRetry,
  };
}

describe('makeBeeRunInstance — terminal mapping', () => {
  it('a bee that reaches done → handle keyed to the spawn id, with cost', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ attempts: [{ poll: ['running', 'running', 'done'] }], cost: 0.05 }));
    const h = await run(INPUT);
    expect(h.instanceId).toBe('s-bee-1');
    expect(h.instanceUrl).toBe('bee://s-bee-1');
    expect(h.targetSlug).toBe('fix-injected-bug');
    expect(h.costUsd).toBe(0.05);
  });

  it('a GENUINE task failure → handle (scoreable), NOT relaunched', async () => {
    const onRetry = vi.fn();
    const run = makeBeeRunInstance(CFG, fakeDeps({ attempts: [{ poll: ['running', 'failed'], failText: TASK_FAIL_TEXT }], onRetry }));
    const h = await run(INPUT);
    expect(h.instanceId).toBe('s-bee-1');
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('a cancelled bee → throws (invalid run)', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ attempts: [{ poll: ['cancelled'] }] }));
    await expect(run(INPUT)).rejects.toThrow(/invalid run/);
  });

  it('a reaped bee → throws (invalid run)', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ attempts: [{ poll: ['reaped'] }] }));
    await expect(run(INPUT)).rejects.toThrow(/invalid run/);
  });

  it('a bee that never reaches a terminal state → throws on timeout', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ attempts: [{ poll: ['running'] }] }));
    await expect(run(INPUT)).rejects.toThrow(/did not reach a terminal state/);
  });

  it('a rejected spawn → throws before polling', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ attempts: [], spawnOk: false, spawnError: 'over ceiling' }));
    await expect(run(INPUT)).rejects.toThrow(/spawn rejected/);
  });

  it('tolerates a not-yet-visible row (null status) before terminal', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ attempts: [{ poll: [null, null, 'done'] }] }));
    expect((await run(INPUT)).instanceId).toBe('s-bee-1');
  });
});

describe('makeBeeRunInstance — rate-limit relaunch loop (the owner hit-limit → relaunch)', () => {
  it('a rate-limited bee is RELAUNCHED, then succeeds → handle from the FRESH bee', async () => {
    const onRetry = vi.fn();
    const run = makeBeeRunInstance(
      CFG,
      fakeDeps({
        attempts: [
          { poll: ['failed'], failText: RATE_TEXT }, // attempt 0 rate-limited
          { poll: ['done'] }, // relaunch succeeds
        ],
        onRetry,
      }),
    );
    const h = await run(INPUT);
    expect(h.instanceId).toBe('s-bee-2'); // the relaunched bee
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ cls: 'rate_limited', attempt: 0 }));
  });

  it('an OVERLOADED (529) bee is also relaunched', async () => {
    const run = makeBeeRunInstance(
      CFG,
      fakeDeps({ attempts: [{ poll: ['failed'], failText: 'API Error: 529 overloaded' }, { poll: ['done'] }] }),
    );
    expect((await run(INPUT)).instanceId).toBe('s-bee-2');
  });

  it('rate-limited on EVERY attempt → exhausts maxRateRetries → throws rate-limited (errored, re-runnable)', async () => {
    // maxRateRetries=2 → 3 spawns total (initial + 2 relaunches), all rate-limited.
    const onRetry = vi.fn();
    const run = makeBeeRunInstance(
      CFG,
      fakeDeps({
        attempts: [
          { poll: ['failed'], failText: RATE_TEXT },
          { poll: ['failed'], failText: RATE_TEXT },
          { poll: ['failed'], failText: RATE_TEXT },
        ],
        onRetry,
      }),
    );
    await expect(run(INPUT)).rejects.toThrow(/rate-limited/);
    expect(onRetry).toHaveBeenCalledTimes(2); // two relaunches before giving up
  });

  it('honors a server retry-after over the floor backoff (no throw, relaunch succeeds)', async () => {
    const onRetry = vi.fn();
    const run = makeBeeRunInstance(
      CFG,
      fakeDeps({
        attempts: [{ poll: ['failed'], failText: '429 rate limit — retry after 90s' }, { poll: ['done'] }],
        onRetry,
      }),
    );
    await run(INPUT);
    // 90s > the 50ms floor → backoff is the server's 90_000ms.
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ backoffMs: 90_000 }));
  });
});
