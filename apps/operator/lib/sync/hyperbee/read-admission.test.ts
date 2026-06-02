/**
 * read-admission.test.ts — the read-admission decision (Model B substrate, Stage 3).
 *
 * D-004: a peer aggregates another's log IFF (1) the announce sig verifies AND
 * (2) device_pubkey ↔ github_user_id is a valid binding (ANY real GitHub
 * identity), proven from the attestation gist carried on the announce
 * (write-free join). There is deliberately NO repo-collaborator gate — GitHub's
 * PR-merge gate is the real authority. Revocation = a `revoked_pubkeys` set.
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
import { makeAdmissionDecider, type AdmissionInput } from './read-admission';

/** Build an AdmissionInput with defaults; override per test. */
function mkInput(over: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    device_pubkey: 'pk',
    github_login: 'alice',
    github_user_id: 7,
    attestation_gist_id: 'gist-1',
    sigValid: true,
    ...over,
  };
}

describe('read-admission', () => {
  it("admits a valid sig + 'verified' binding", async () => {
    const admit = makeAdmissionDecider({
      verifyBinding: async (pk, login) =>
        pk === 'good' && login === 'alice' ? 'verified' : 'fail',
    });
    expect(await admit(mkInput({ device_pubkey: 'good' }))).toEqual({ admit: true });
  });

  it("'pending' binding → {admit:false, reason:'pending'} (D-006 retryable)", async () => {
    const admit = makeAdmissionDecider({ verifyBinding: async () => 'pending' });
    expect(await admit(mkInput())).toEqual({ admit: false, reason: 'pending' });
  });

  it("'fail' binding → {admit:false, reason:'binding_invalid'}", async () => {
    const admit = makeAdmissionDecider({ verifyBinding: async () => 'fail' });
    expect(await admit(mkInput({ device_pubkey: 'bad' }))).toMatchObject({
      admit: false,
      reason: 'binding_invalid',
    });
  });

  it('threads the attestation_gist_id (+ pubkey, login, id) to verifyBinding', async () => {
    const verifyBinding = vi.fn(async () => 'verified' as const);
    const admit = makeAdmissionDecider({ verifyBinding });
    await admit(
      mkInput({
        device_pubkey: 'pk-x',
        github_login: 'bob',
        github_user_id: 99,
        attestation_gist_id: 'gist-xyz',
      }),
    );
    expect(verifyBinding).toHaveBeenCalledWith('pk-x', 'bob', 99, 'gist-xyz');
  });

  it('rejects a bad signature with reason bad_sig (before checking binding)', async () => {
    const verifyBinding = vi.fn(async () => 'verified' as const);
    const admit = makeAdmissionDecider({ verifyBinding });
    expect(await admit(mkInput({ device_pubkey: 'good', sigValid: false }))).toMatchObject({
      admit: false,
      reason: 'bad_sig',
    });
    // short-circuits: no network binding check when the sig is already bad
    expect(verifyBinding).not.toHaveBeenCalled();
  });

  it('rejects a revoked pubkey with reason revoked (highest precedence)', async () => {
    const admit = makeAdmissionDecider({
      verifyBinding: async () => 'verified',
      revoked: new Set(['x']),
    });
    expect(await admit(mkInput({ device_pubkey: 'x' }))).toMatchObject({
      admit: false,
      reason: 'revoked',
    });
  });

  it('revocation beats even a bad sig (revoked checked first, verifyBinding not called)', async () => {
    const verifyBinding = vi.fn(async () => 'verified' as const);
    const admit = makeAdmissionDecider({ verifyBinding, revoked: new Set(['x']) });
    expect(await admit(mkInput({ device_pubkey: 'x', sigValid: false }))).toMatchObject({
      admit: false,
      reason: 'revoked',
    });
    expect(verifyBinding).not.toHaveBeenCalled();
  });

  it('bad_sig short-circuits before verifyBinding runs', async () => {
    const verifyBinding = vi.fn(async () => 'pending' as const);
    const admit = makeAdmissionDecider({ verifyBinding });
    await admit(mkInput({ device_pubkey: 'any', sigValid: false }));
    expect(verifyBinding).not.toHaveBeenCalled();
  });

  it('NO collaborator gate: any login with a verified binding is admitted', async () => {
    // verifyBinding returns 'verified' for ANY identity — the decider must admit
    // without any further permission/collaborator check.
    const admit = makeAdmissionDecider({ verifyBinding: async () => 'verified' });
    expect(
      await admit(mkInput({ device_pubkey: 'anyone', github_login: 'random-outsider' })),
    ).toEqual({ admit: true });
  });
});
