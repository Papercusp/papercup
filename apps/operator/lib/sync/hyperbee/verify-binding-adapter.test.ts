/**
 * verify-binding-adapter.test.ts — the Stage 4c read-admission adapter.
 *
 * The adapter maps `verifyBoth(...)` → boolean for the read-admission decider.
 * It hits GitHub at runtime, so here we stub BOTH the harness-context resolver
 * (owner/repo/token) AND `verifyBoth` to assert ONLY the mapping:
 *   verified → true ; pending → false ; failed → false ; no-context → false.
 * Plus: the announce's per-peer inputs are threaded into both channels, and the
 * context is resolved once + cached.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildVerifyBindingAdapter } from './verify-binding-adapter';
import type { VerifyBothOptions } from '@/lib/identity/two-channel-verifier';

const CTX = { repoOwner: 'acme', repoName: 'widgets', token: 'gh-tok' };

function adapter(
  status: 'verified' | 'pending' | 'failed' | null,
  opts: {
    context?: { repoOwner: string; repoName: string; token: string } | null;
    capture?: (o: VerifyBothOptions) => void;
  } = {},
) {
  const verifyBothImpl = vi.fn(async (o: VerifyBothOptions) => {
    opts.capture?.(o);
    return { status: status ?? 'failed' };
  });
  const resolveContext = vi.fn(async () =>
    opts.context === undefined ? CTX : opts.context,
  );
  const verifyBinding = buildVerifyBindingAdapter({
    workspaceId: 'ws-1',
    harnessSlug: 's1',
    workspaceRoot: '/tmp',
    resolveContext,
    verifyBothImpl,
  });
  return { verifyBinding, verifyBothImpl, resolveContext };
}

describe('buildVerifyBindingAdapter', () => {
  it('verified → admits (true)', async () => {
    const { verifyBinding } = adapter('verified');
    expect(await verifyBinding('pk', 'alice', 42)).toBe(true);
  });

  it('pending → NOT admitted (false)', async () => {
    const { verifyBinding } = adapter('pending');
    expect(await verifyBinding('pk', 'alice', 42)).toBe(false);
  });

  it('failed → NOT admitted (false)', async () => {
    const { verifyBinding } = adapter('failed');
    expect(await verifyBinding('pk', 'alice', 42)).toBe(false);
  });

  it('no harness context (private / no gh auth) → fail-closed (false), verifyBoth not called', async () => {
    const { verifyBinding, verifyBothImpl } = adapter('verified', { context: null });
    expect(await verifyBinding('pk', 'alice', 42)).toBe(false);
    expect(verifyBothImpl).not.toHaveBeenCalled();
  });

  it('threads announce inputs into channel1 + channel2 and harness context into channel2', async () => {
    let captured: VerifyBothOptions | null = null;
    const { verifyBinding } = adapter('verified', { capture: (o) => { captured = o; } });
    await verifyBinding('devpk-b64', 'bob', 99);
    const c = captured! as VerifyBothOptions;
    expect(c.channel1).toEqual({ token: 'gh-tok', claimedGithubUserId: 99 });
    expect(c.channel2).toEqual({
      repoOwner: 'acme',
      repoName: 'widgets',
      githubLogin: 'bob',
      githubUserId: 99,
      devicePubkeyBase64: 'devpk-b64',
      token: 'gh-tok',
    });
  });

  it('resolves the harness context once + caches it across calls', async () => {
    const { verifyBinding, resolveContext } = adapter('verified');
    await verifyBinding('pk', 'a', 1);
    await verifyBinding('pk', 'b', 2);
    await verifyBinding('pk', 'c', 3);
    expect(resolveContext).toHaveBeenCalledTimes(1);
  });

  it('retries context resolution after a no-context result', async () => {
    // First resolve null (fail-closed, not cached) → next call resolves again.
    let call = 0;
    const verifyBothImpl = vi.fn(async () => ({ status: 'verified' as const }));
    const resolveContext = vi.fn(async () => (call++ === 0 ? null : CTX));
    const verifyBinding = buildVerifyBindingAdapter({
      workspaceId: 'ws-1',
      harnessSlug: 's1',
      workspaceRoot: '/tmp',
      resolveContext,
      verifyBothImpl,
    });
    expect(await verifyBinding('pk', 'a', 1)).toBe(false); // no context
    expect(await verifyBinding('pk', 'a', 1)).toBe(true);  // context now resolves
    expect(resolveContext).toHaveBeenCalledTimes(2);
  });
});
