/**
 * work-item-replica-authority.test.ts — the HIVE-scoped replica-authority SEAM
 * (EI-266; mirrors work-item-claim-authority.test.ts).
 *
 * The redundancy store routes EVERY replica op through this singleton
 * (`getWorkItemReplicaAuthority().route(hiveSlug, op)`). On a single box the
 * default `LocalWorkItemReplicaAuthority` runs `op.local()` directly; the cutover
 * installs a real multi-peer router via `setWorkItemReplicaAuthority()` with zero
 * store changes. These tests lock the seam's contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthorityOp } from './authority';
import {
  LocalWorkItemReplicaAuthority,
  getWorkItemReplicaAuthority,
  setWorkItemReplicaAuthority,
  resetWorkItemReplicaAuthority,
  type WorkItemReplicaAuthority,
} from './work-item-replica-authority';

function op<T>(local: () => Promise<T>, remoteDecode = vi.fn()): AuthorityOp<T> {
  return { local, remote: { kind: 'work-item.replica.claim-slot', payload: { x: 1 }, decode: remoteDecode } };
}

afterEach(() => resetWorkItemReplicaAuthority());

describe('LocalWorkItemReplicaAuthority', () => {
  it('isSelf is always true (single-box: this peer is the replica authority for any Hive)', async () => {
    const local = new LocalWorkItemReplicaAuthority();
    expect(await local.isSelf('hive-a')).toBe(true);
    expect(await local.isSelf('any-other-hive')).toBe(true);
  });

  it('route runs the LOCAL leg and returns its value — never the remote envelope', async () => {
    const local = new LocalWorkItemReplicaAuthority();
    const decode = vi.fn();
    const result = await local.route('hive-a', op(async () => ({ replicaIndex: 0 }), decode));
    expect(result).toEqual({ replicaIndex: 0 });
    expect(decode).not.toHaveBeenCalled();
  });

  it('propagates an error thrown by the local op (no swallow)', async () => {
    const local = new LocalWorkItemReplicaAuthority();
    await expect(local.route('hive-a', op(async () => { throw new Error('replica store down'); }))).rejects.toThrow(
      /replica store down/,
    );
  });
});

describe('the mutable replica-authority singleton (cutover swap-in point)', () => {
  it('defaults to a local authority that reports isSelf=true', async () => {
    expect(await getWorkItemReplicaAuthority().isSelf('hive-a')).toBe(true);
  });

  it('setWorkItemReplicaAuthority installs a custom router the store would then use', async () => {
    const routed: Array<{ hive: string }> = [];
    const custom: WorkItemReplicaAuthority = {
      isSelf: async () => false,
      route: async (hiveSlug, o) => {
        routed.push({ hive: hiveSlug });
        return o.local();
      },
    };
    setWorkItemReplicaAuthority(custom);
    expect(getWorkItemReplicaAuthority()).toBe(custom);
    expect(await getWorkItemReplicaAuthority().isSelf('hive-a')).toBe(false);
    const r = await getWorkItemReplicaAuthority().route('hive-a', op(async () => 'ok'));
    expect(r).toBe('ok');
    expect(routed).toEqual([{ hive: 'hive-a' }]);
  });

  it('resetWorkItemReplicaAuthority restores the local authority (a cutover can be backed out)', async () => {
    setWorkItemReplicaAuthority({ isSelf: async () => false, route: async (_h, o) => o.local() });
    expect(await getWorkItemReplicaAuthority().isSelf('hive-a')).toBe(false);
    resetWorkItemReplicaAuthority();
    expect(getWorkItemReplicaAuthority()).toBeInstanceOf(LocalWorkItemReplicaAuthority);
    expect(await getWorkItemReplicaAuthority().isSelf('hive-a')).toBe(true);
  });
});
