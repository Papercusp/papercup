/**
 * work-item-claim-authority.test.ts — the HIVE-scoped claim-authority SEAM
 * (work-item-claim-authority.ts; decentralized-dispatch-scaling-2026-06-08 D-002).
 *
 * The work-item-claims store routes EVERY claim op through this module's singleton
 * (`getWorkItemClaimAuthority().route(potSlug, op)`). On a single box the default
 * `LocalWorkItemClaimAuthority` runs `op.local()` directly; Track B installs a real
 * multi-peer router via `setWorkItemClaimAuthority()` with zero store changes. These
 * tests lock the seam's contract: local always self-authoritative, route runs the
 * LOCAL leg (never the serialisable `remote` envelope), failures propagate, and the
 * mutable singleton swaps + resets cleanly (so a Track-B install can be backed out).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthorityOp } from './authority';
import {
  LocalWorkItemClaimAuthority,
  getWorkItemClaimAuthority,
  setWorkItemClaimAuthority,
  resetWorkItemClaimAuthority,
  type WorkItemClaimAuthority,
} from './work-item-claim-authority';

/** An op whose remote leg, if ever invoked, is observable via the decode spy. */
function op<T>(local: () => Promise<T>, remoteDecode = vi.fn()): AuthorityOp<T> {
  return { local, remote: { kind: 'work-item.claim.acquire', payload: { x: 1 }, decode: remoteDecode } };
}

afterEach(() => resetWorkItemClaimAuthority());

describe('LocalWorkItemClaimAuthority', () => {
  it('isSelf is always true (single-box: this peer is the authority for any Hive)', async () => {
    const local = new LocalWorkItemClaimAuthority();
    expect(await local.isSelf('hive-a')).toBe(true);
    expect(await local.isSelf('any-other-hive')).toBe(true);
  });

  it('route runs the LOCAL leg and returns its value — never the remote envelope', async () => {
    const local = new LocalWorkItemClaimAuthority();
    const decode = vi.fn();
    const result = await local.route('hive-a', op(async () => ({ claimId: 'cid-1' }), decode));
    expect(result).toEqual({ claimId: 'cid-1' });
    expect(decode).not.toHaveBeenCalled(); // the remote leg is untouched on a local authority
  });

  it('propagates an error thrown by the local op (no swallow)', async () => {
    const local = new LocalWorkItemClaimAuthority();
    await expect(local.route('hive-a', op(async () => { throw new Error('claim store down'); }))).rejects.toThrow(
      /claim store down/,
    );
  });
});

describe('the mutable authority singleton (Track-B swap-in point)', () => {
  it('defaults to a local authority that reports isSelf=true', async () => {
    expect(await getWorkItemClaimAuthority().isSelf('hive-a')).toBe(true);
  });

  it('setWorkItemClaimAuthority installs a custom router that the store would then use', async () => {
    const routed: Array<{ hive: string }> = [];
    const custom: WorkItemClaimAuthority = {
      isSelf: async () => false,
      route: async (potSlug, o) => {
        routed.push({ hive: potSlug });
        return o.local();
      },
    };
    setWorkItemClaimAuthority(custom);

    expect(getWorkItemClaimAuthority()).toBe(custom);
    expect(await getWorkItemClaimAuthority().isSelf('hive-a')).toBe(false);
    const r = await getWorkItemClaimAuthority().route('hive-a', op(async () => 'ok'));
    expect(r).toBe('ok');
    expect(routed).toEqual([{ hive: 'hive-a' }]);
  });

  it('resetWorkItemClaimAuthority restores the local authority (a Track-B install can be backed out)', async () => {
    setWorkItemClaimAuthority({ isSelf: async () => false, route: async (_h, o) => o.local() });
    expect(await getWorkItemClaimAuthority().isSelf('hive-a')).toBe(false);

    resetWorkItemClaimAuthority();

    expect(getWorkItemClaimAuthority()).toBeInstanceOf(LocalWorkItemClaimAuthority);
    expect(await getWorkItemClaimAuthority().isSelf('hive-a')).toBe(true);
  });
});
