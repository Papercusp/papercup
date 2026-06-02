/**
 * P-070 emit seam — coverage for emitUsageEventBestEffort: the single one-liner
 * every lifecycle call site uses. It resolves the local actor, emits one ledger
 * event, and — the load-bearing property — NEVER throws: a usage-event failure
 * must not break the feature/PR/plan/run action it rides on.
 */
import { describe, expect, it, vi } from 'vitest';
import { emitUsageEventBestEffort } from './emit-usage';
import type { EmitUsageEventInput } from './usage-events';

const actor = { githubUserId: 42, devicePubkey: 'PK==' };

describe('emitUsageEventBestEffort', () => {
  it('emits one event with the resolved actor identity', async () => {
    const emit = vi.fn(async (_i: EmitUsageEventInput) => ({ event_id: 'EVT' as string }));
    await emitUsageEventBestEffort('papercup', 'feature_authored', {
      ref_id: 'F-1',
      payload: { title: 'Do it' },
      deps: { resolveActor: async () => actor, emit },
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toEqual({
      harness_slug: 'papercup',
      github_user_id: 42,
      device_pubkey: 'PK==',
      kind: 'feature_authored',
      ref_id: 'F-1',
      payload: { title: 'Do it' },
    });
  });

  it('skips the emit silently when no actor (gh unauthenticated)', async () => {
    const emit = vi.fn(async (_i: EmitUsageEventInput) => ({ event_id: 'EVT' as string }));
    await emitUsageEventBestEffort('papercup', 'agent_run_completed', {
      deps: { resolveActor: async () => null, emit },
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('defaults ref_id and payload to null when omitted', async () => {
    const emit = vi.fn(async (_i: EmitUsageEventInput) => ({ event_id: 'EVT' as string }));
    await emitUsageEventBestEffort('papercup', 'pr_opened', {
      deps: { resolveActor: async () => actor, emit },
    });
    expect(emit.mock.calls[0][0]).toMatchObject({ ref_id: null, payload: null });
  });

  it('never throws when emit rejects — routes the error to onError', async () => {
    const onError = vi.fn();
    const emit = vi.fn(async () => {
      throw new Error('pg down');
    });
    await expect(
      emitUsageEventBestEffort('papercup', 'decision_added', {
        deps: { resolveActor: async () => actor, emit, onError },
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('pg down');
  });

  it('never throws when actor resolution rejects', async () => {
    const onError = vi.fn();
    await expect(
      emitUsageEventBestEffort('papercup', 'plan_authored', {
        deps: {
          resolveActor: async () => {
            throw new Error('keychain locked');
          },
          emit: vi.fn(),
          onError,
        },
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
