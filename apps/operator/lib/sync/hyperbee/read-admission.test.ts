/**
 * read-admission.test.ts — the read-admission decision (Model B substrate, Stage 3).
 *
 * D-004: a peer aggregates another's log IFF (1) the announce sig verifies AND
 * (2) device_pubkey ↔ github_login is a valid channel-2 binding (ANY real
 * GitHub identity). There is deliberately NO repo-collaborator gate — GitHub's
 * PR-merge gate is the real authority. Revocation = a `revoked_pubkeys` set.
 *
 * D-002: channel-2 only for admission (channel-1 is a self-attestation a remote
 * peer cannot run).
 *
 * D-006: verifyBinding returns a 3-state 'verified' | 'pending' | 'fail'.
 *   - 'verified'  → {admit: true}
 *   - 'pending'   → {admit: false, reason: 'pending'}   (retryable)
 *   - 'fail'      → {admit: false, reason: 'binding_invalid'}
 *
 * Decision precedence: revoked → bad_sig → verifyBinding → ...
 * revoked + bad_sig short-circuit BEFORE verifyBinding is called.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeAdmissionDecider } from './read-admission';

describe('read-admission', () => {
  it("admits a valid sig + 'verified' binding", async () => {
    const admit = makeAdmissionDecider({
      verifyBinding: async (pk, login) =>
        pk === 'good' && login === 'alice' ? 'verified' : 'fail',
    });
    expect(
      await admit({ device_pubkey: 'good', github_login: 'alice', github_user_id: 7, sigValid: true }),
    ).toEqual({ admit: true });
  });

  it("'pending' binding → {admit:false, reason:'pending'} (D-006 retryable)", async () => {
    const admit = makeAdmissionDecider({
      verifyBinding: async () => 'pending',
    });
    expect(
      await admit({ device_pubkey: 'pk', github_login: 'alice', github_user_id: 7, sigValid: true }),
    ).toEqual({ admit: false, reason: 'pending' });
  });

  it("'fail' binding → {admit:false, reason:'binding_invalid'}", async () => {
    const admit = makeAdmissionDecider({
      verifyBinding: async () => 'fail',
    });
    expect(
      await admit({ device_pubkey: 'bad', github_login: 'alice', github_user_id: 7, sigValid: true }),
    ).toMatchObject({ admit: false, reason: 'binding_invalid' });
  });

  it('rejects a bad signature with reason bad_sig (before checking binding)', async () => {
    const verifyBinding = vi.fn(async () => 'verified' as const);
    const admit = makeAdmissionDecider({ verifyBinding });
    expect(
      await admit({ device_pubkey: 'good', github_login: 'alice', github_user_id: 7, sigValid: false }),
    ).toMatchObject({ admit: false, reason: 'bad_sig' });
    // short-circuits: no network binding check when the sig is already bad
    expect(verifyBinding).not.toHaveBeenCalled();
  });

  it('rejects a revoked pubkey with reason revoked (highest precedence)', async () => {
    const admit = makeAdmissionDecider({
      verifyBinding: async () => 'verified',
      revoked: new Set(['x']),
    });
    expect(
      await admit({ device_pubkey: 'x', github_login: 'a', github_user_id: 7, sigValid: true }),
    ).toMatchObject({ admit: false, reason: 'revoked' });
  });

  it('revocation beats even a bad sig (revoked checked first, verifyBinding not called)', async () => {
    const verifyBinding = vi.fn(async () => 'verified' as const);
    const admit = makeAdmissionDecider({
      verifyBinding,
      revoked: new Set(['x']),
    });
    expect(
      await admit({ device_pubkey: 'x', github_login: 'a', github_user_id: 7, sigValid: false }),
    ).toMatchObject({ admit: false, reason: 'revoked' });
    expect(verifyBinding).not.toHaveBeenCalled();
  });

  it('bad_sig short-circuits before verifyBinding runs', async () => {
    const verifyBinding = vi.fn(async () => 'pending' as const);
    const admit = makeAdmissionDecider({ verifyBinding });
    await admit({ device_pubkey: 'any', github_login: 'a', github_user_id: 7, sigValid: false });
    expect(verifyBinding).not.toHaveBeenCalled();
  });

  it('NO collaborator gate: any login with a verified binding is admitted', async () => {
    // verifyBinding returns 'verified' for ANY identity — the decider must admit
    // without any further permission/collaborator check.
    const admit = makeAdmissionDecider({ verifyBinding: async () => 'verified' });
    expect(
      await admit({ device_pubkey: 'anyone', github_login: 'random-outsider', github_user_id: 7, sigValid: true }),
    ).toEqual({ admit: true });
  });
});
