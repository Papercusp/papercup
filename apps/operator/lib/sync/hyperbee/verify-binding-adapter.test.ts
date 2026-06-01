/**
 * verify-binding-adapter.test.ts — the Stage 4c read-admission adapter.
 *
 * D-002: the adapter now verifies channel-2 ONLY (publicly-readable device-signed
 * contributor file). Channel-1 OAuth is a self-attestation a remote peer cannot run
 * and is no longer invoked during admission.
 *
 * The adapter hits GitHub at runtime; here we stub BOTH the harness-context resolver
 * (owner/repo/token) AND `verifyChannel2` to assert ONLY the mapping:
 *   channel2 ok → 'verified' ; channel2 pending → 'pending' ; channel2 fail → 'fail'.
 *   no-context → 'fail' (fail-closed, verifyChannel2 not called).
 * Plus: the announce's per-peer inputs are threaded into channel-2 only, and the
 * context is resolved once + cached.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildVerifyBindingAdapter } from './verify-binding-adapter';
import type { VerifyChannel2Options } from '@/lib/identity/two-channel-verifier';
import type { ChannelResult } from '@/lib/identity/binding-verifier-types';

const CTX = { repoOwner: 'acme', repoName: 'widgets', token: 'gh-tok' };

function adapter(
  channelResult: ChannelResult,
  opts: {
    context?: { repoOwner: string; repoName: string; token: string } | null;
    capture?: (o: VerifyChannel2Options) => void;
  } = {},
) {
  const verifyChannel2Impl = vi.fn(async (o: VerifyChannel2Options) => {
    opts.capture?.(o);
    return channelResult;
  });
  const resolveContext = vi.fn(async () =>
    opts.context === undefined ? CTX : opts.context,
  );
  const verifyBinding = buildVerifyBindingAdapter({
    workspaceId: 'ws-1',
    harnessSlug: 's1',
    workspaceRoot: '/tmp',
    resolveContext,
    verifyChannel2Impl,
  });
  return { verifyBinding, verifyChannel2Impl, resolveContext };
}

describe('buildVerifyBindingAdapter (D-002: channel-2 only)', () => {
  it("channel2 ok → 'verified'", async () => {
    const { verifyBinding } = adapter({ kind: 'ok' });
    expect(await verifyBinding('pk', 'alice', 42)).toBe('verified');
  });

  it("channel2 pending → 'pending'", async () => {
    const { verifyBinding } = adapter({ kind: 'pending', reason: 'just_joined_channel2_propagating' });
    expect(await verifyBinding('pk', 'alice', 42)).toBe('pending');
  });

  it("channel2 fail → 'fail'", async () => {
    const { verifyBinding } = adapter({ kind: 'fail', reason: 'channel2_file_missing' });
    expect(await verifyBinding('pk', 'alice', 42)).toBe('fail');
  });

  it("no harness context (private / no gh auth) → 'fail', verifyChannel2 not called", async () => {
    const { verifyBinding, verifyChannel2Impl } = adapter({ kind: 'ok' }, { context: null });
    expect(await verifyBinding('pk', 'alice', 42)).toBe('fail');
    expect(verifyChannel2Impl).not.toHaveBeenCalled();
  });

  it('channel-1 (OAuth) is never invoked during admission (D-002)', async () => {
    // The adapter must call verifyChannel2Impl (not a verifyBoth-style call with channel1).
    // We verify this by checking verifyChannel2Impl is called (which takes only channel-2 opts),
    // and that the call does NOT contain channel1 fields (token + claimedGithubUserId shape).
    let captured: VerifyChannel2Options | null = null;
    const { verifyBinding } = adapter({ kind: 'ok' }, { capture: (o) => { captured = o; } });
    await verifyBinding('devpk-b64', 'bob', 99);
    expect(captured).not.toBeNull();
    // Verify channel-2 opts are present
    expect(captured!.repoOwner).toBe('acme');
    expect(captured!.githubLogin).toBe('bob');
    // Verify there is no channel-1 shape (no claimedGithubUserId separate from githubUserId)
    expect((captured as unknown as Record<string, unknown>)['channel1']).toBeUndefined();
    expect((captured as unknown as Record<string, unknown>)['claimedGithubUserId']).toBeUndefined();
  });

  it('threads announce inputs into channel-2 and harness context into channel-2', async () => {
    let captured: VerifyChannel2Options | null = null;
    const { verifyBinding } = adapter({ kind: 'ok' }, { capture: (o) => { captured = o; } });
    await verifyBinding('devpk-b64', 'bob', 99);
    const c = captured!;
    expect(c).toEqual({
      repoOwner: 'acme',
      repoName: 'widgets',
      githubLogin: 'bob',
      githubUserId: 99,
      devicePubkeyBase64: 'devpk-b64',
      token: 'gh-tok',
    });
  });

  it('resolves the harness context once + caches it across calls', async () => {
    const { verifyBinding, resolveContext } = adapter({ kind: 'ok' });
    await verifyBinding('pk', 'a', 1);
    await verifyBinding('pk', 'b', 2);
    await verifyBinding('pk', 'c', 3);
    expect(resolveContext).toHaveBeenCalledTimes(1);
  });

  it('retries context resolution after a no-context result', async () => {
    // First resolve null (fail-closed, not cached) → next call resolves again.
    let call = 0;
    const verifyChannel2Impl = vi.fn(async (): Promise<ChannelResult> => ({ kind: 'ok' }));
    const resolveContext = vi.fn(async () => (call++ === 0 ? null : CTX));
    const verifyBinding = buildVerifyBindingAdapter({
      workspaceId: 'ws-1',
      harnessSlug: 's1',
      workspaceRoot: '/tmp',
      resolveContext,
      verifyChannel2Impl,
    });
    expect(await verifyBinding('pk', 'a', 1)).toBe('fail'); // no context
    expect(await verifyBinding('pk', 'a', 1)).toBe('verified');  // context now resolves
    expect(resolveContext).toHaveBeenCalledTimes(2);
  });
});
