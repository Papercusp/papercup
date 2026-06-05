/**
 * Unit tests for `principalFromSuperuserToken` — the superuser bearer-file
 * resolver INTERNALS.
 *
 * The composite `require-principal.test.ts` stubs `isLoopbackRequest` /
 * `isValidSuperuserBearer` / `activeWorkspaceId` at the boundary and only
 * asserts fall-through order. This file drills the resolver body itself:
 *   - non-loopback request short-circuits to null (loopback gate first);
 *   - a valid bearer on a loopback request mints the trusted system
 *     principal with the wildcard capability set;
 *   - the `Bearer ` prefix is stripped before validation, and a raw
 *     (prefix-less) token is passed through verbatim.
 *
 * Hermetic: the three named deps are mocked; nothing touches PG/FS.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../superuser-token', () => ({
  isLoopbackRequest: vi.fn(() => false),
  isValidSuperuserBearer: vi.fn(() => false),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-active'),
}));

import { principalFromSuperuserToken } from './from-superuser-token';
import { isLoopbackRequest, isValidSuperuserBearer } from '../../superuser-token';
import { activeWorkspaceId } from '../../workspace-registry';

const h = (init: Record<string, string> = {}) => new Headers(init);

beforeEach(() => {
  vi.mocked(isLoopbackRequest).mockReturnValue(false);
  vi.mocked(isValidSuperuserBearer).mockReturnValue(false);
  vi.mocked(activeWorkspaceId).mockReturnValue('ws-active');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('principalFromSuperuserToken', () => {
  it('returns null for a non-loopback request even with a valid bearer', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(false);
    vi.mocked(isValidSuperuserBearer).mockReturnValue(true);
    const p = principalFromSuperuserToken(h({ authorization: 'Bearer su_token' }));
    expect(p).toBeNull();
    // Loopback gate is first — bearer validity is never consulted.
    expect(isValidSuperuserBearer).not.toHaveBeenCalled();
  });

  it('returns null on a loopback request with no Authorization header', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    const p = principalFromSuperuserToken(h());
    expect(p).toBeNull();
    expect(isValidSuperuserBearer).not.toHaveBeenCalled();
  });

  it('returns null when the bearer is present but invalid', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    vi.mocked(isValidSuperuserBearer).mockReturnValue(false);
    const p = principalFromSuperuserToken(h({ authorization: 'Bearer nope' }));
    expect(p).toBeNull();
    expect(isValidSuperuserBearer).toHaveBeenCalledWith('nope');
  });

  it('mints a trusted system principal with wildcard caps for a valid loopback bearer', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    vi.mocked(isValidSuperuserBearer).mockReturnValue(true);
    const p = principalFromSuperuserToken(h({ authorization: 'Bearer su_token' }));
    expect(p).not.toBeNull();
    expect(p).toMatchObject({
      kind: 'system',
      slug: 'system:superuser',
      workspaceId: 'ws-active',
      authMethod: 'bearer-token',
      trust: 'trusted',
      label: 'superuser shell',
    });
    expect(p!.capabilities).toBeInstanceOf(Set);
    expect(p!.capabilities.has('*')).toBe(true);
    expect([...p!.capabilities]).toEqual(['*']);
  });

  it('strips the "Bearer " prefix before validating', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    vi.mocked(isValidSuperuserBearer).mockReturnValue(true);
    principalFromSuperuserToken(h({ authorization: 'Bearer the_secret' }));
    expect(isValidSuperuserBearer).toHaveBeenCalledWith('the_secret');
  });

  it('passes a raw (prefix-less) Authorization value through verbatim', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    vi.mocked(isValidSuperuserBearer).mockReturnValue(true);
    principalFromSuperuserToken(h({ authorization: 'raw_token_no_prefix' }));
    expect(isValidSuperuserBearer).toHaveBeenCalledWith('raw_token_no_prefix');
  });

  it('reads the workspace id from activeWorkspaceId at mint time', () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    vi.mocked(isValidSuperuserBearer).mockReturnValue(true);
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-other');
    const p = principalFromSuperuserToken(h({ authorization: 'Bearer t' }));
    expect(p!.workspaceId).toBe('ws-other');
  });
});
