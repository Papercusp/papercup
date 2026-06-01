/**
 * read-admission.test.ts — the read-admission decision (Model B substrate, Stage 3).
 *
 * D-004: a peer aggregates another's log IFF (1) the announce sig verifies AND
 * (2) device_pubkey ↔ github_login is a valid two-channel binding (ANY real
 * GitHub identity). There is deliberately NO repo-collaborator gate — GitHub's
 * PR-merge gate is the real authority. Revocation = a `revoked_pubkeys` set.
 *
 * The decider is pure: it takes an injected `verifyBinding` (Stage 4 wires it
 * to a verifyBoth adapter) + an optional `revoked` set. Decision precedence:
 *   revoked → bad_sig → binding_invalid → admit.
 */

import { describe, it, expect } from 'vitest';
import { makeAdmissionDecider } from './read-admission';

describe('read-admission', () => {
  it('admits a valid sig + valid binding (no collaborator check)', async () => {
    const admit = makeAdmissionDecider({
      verifyBinding: async (pk, login) => pk === 'good' && login === 'alice',
    });
    expect(await admit({ device_pubkey: 'good', github_login: 'alice', github_user_id: 7, sigValid: true })).toEqual({
      admit: true,
    });
  });

  it('rejects a bad signature with reason bad_sig (before checking binding)', async () => {
    let bindingCalled = false;
    const admit = makeAdmissionDecider({
      verifyBinding: async () => {
        bindingCalled = true;
        return true;
      },
    });
    expect(
      await admit({ device_pubkey: 'good', github_login: 'alice', github_user_id: 7, sigValid: false }),
    ).toMatchObject({ admit: false, reason: 'bad_sig' });
    // short-circuits: no network binding check when the sig is already bad
    expect(bindingCalled).toBe(false);
  });

  it('rejects an invalid binding with reason binding_invalid', async () => {
    const admit = makeAdmissionDecider({
      verifyBinding: async (pk, login) => pk === 'good' && login === 'alice',
    });
    expect(
      await admit({ device_pubkey: 'bad', github_login: 'alice', github_user_id: 7, sigValid: true }),
    ).toMatchObject({ admit: false, reason: 'binding_invalid' });
  });

  it('rejects a revoked pubkey with reason revoked (highest precedence)', async () => {
    const admit = makeAdmissionDecider({
      verifyBinding: async () => true,
      revoked: new Set(['x']),
    });
    expect(
      await admit({ device_pubkey: 'x', github_login: 'a', github_user_id: 7, sigValid: true }),
    ).toMatchObject({ admit: false, reason: 'revoked' });
  });

  it('revocation beats even a bad sig (revoked checked first)', async () => {
    let bindingCalled = false;
    const admit = makeAdmissionDecider({
      verifyBinding: async () => {
        bindingCalled = true;
        return true;
      },
      revoked: new Set(['x']),
    });
    expect(
      await admit({ device_pubkey: 'x', github_login: 'a', github_user_id: 7, sigValid: false }),
    ).toMatchObject({ admit: false, reason: 'revoked' });
    expect(bindingCalled).toBe(false);
  });

  it('NO collaborator gate: any login with a valid binding is admitted', async () => {
    // verifyBinding returns true for ANY identity — the decider must admit
    // without any further permission/collaborator check.
    const admit = makeAdmissionDecider({ verifyBinding: async () => true });
    expect(
      await admit({ device_pubkey: 'anyone', github_login: 'random-outsider', github_user_id: 7, sigValid: true }),
    ).toEqual({ admit: true });
  });
});
