/**
 * Unit tests for `principalFromLoopback` — the ONLY resolver that mints
 * `trust: 'unverified-loopback'`.
 *
 * The composite `require-principal.test.ts` only checks that loopback
 * fires last and that its trust level is rejected by a `trust: ['trusted']`
 * allowlist. This file pins the resolver body: the loopback gate, and the
 * exact capability-set / principal shape it produces.
 *
 * Hermetic: `isLoopbackRequest` + `activeWorkspaceId` are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../superuser-token', () => ({
  isLoopbackRequest: vi.fn(() => false),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-active'),
}));

import { principalFromLoopback } from './from-loopback';
import { isLoopbackRequest } from '../../superuser-token';
import { activeWorkspaceId } from '../../workspace-registry';

const h = (init: Record<string, string> = {}) => new Headers(init);

beforeEach(() => {
  vi.mocked(isLoopbackRequest).mockReturnValue(false);
  vi.mocked(activeWorkspaceId).mockReturnValue('ws-active');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('principalFromLoopback', () => {
  it('returns null when the request is not loopback', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(false);
    expect(principalFromLoopback(h())).toBeNull();
  });

  it('mints an unverified-loopback principal on a loopback request', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    const p = principalFromLoopback(h());
    expect(p).not.toBeNull();
    expect(p).toMatchObject({
      kind: 'loopback',
      slug: 'loopback',
      workspaceId: 'ws-active',
      authMethod: 'host-loopback',
      trust: 'unverified-loopback',
      label: 'loopback',
    });
  });

  it('is the resolver minting trust: unverified-loopback (the load-bearing invariant)', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    const p = principalFromLoopback(h());
    expect(p!.trust).toBe('unverified-loopback');
  });

  it('carries the wildcard capability set as a Set', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    const p = principalFromLoopback(h());
    expect(p!.capabilities).toBeInstanceOf(Set);
    expect(p!.capabilities.has('*')).toBe(true);
    expect([...p!.capabilities]).toEqual(['*']);
  });

  it('ignores any Authorization header — loopback is host-based, not token-based', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    const p = principalFromLoopback(h({ authorization: 'Bearer whatever' }));
    expect(p!.kind).toBe('loopback');
    expect(p!.authMethod).toBe('host-loopback');
  });

  it('reads the workspace id from activeWorkspaceId at mint time', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-xyz');
    const p = principalFromLoopback(h());
    expect(p!.workspaceId).toBe('ws-xyz');
  });
});
