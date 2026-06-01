/**
 * read-admission — the read-admission decision (Model B substrate, Stage 3).
 *
 * D-004 (the security core): a peer aggregates another peer's log IFF
 *   (1) the announce `sig` verifies against `device_pubkey`  (→ `sigValid`), AND
 *   (2) `device_pubkey` ↔ `github_login` is a valid two-channel binding for
 *       ANY real GitHub identity.
 *
 * There is deliberately NO repo-collaborator / permission gate here. GitHub's
 * PR-merge gate is the real authority over what lands; this advisory
 * replication layer is open to any device that proves a real GitHub identity.
 * Revocation is the only blocklist: a `revoked_pubkeys` set.
 *
 * This module is the PURE decider. The binding check is injected as
 * `verifyBinding(device_pubkey, github_login) => Promise<boolean>`; Stage 4
 * wires it to a thin adapter over `verifyBoth(...)` (two-channel-verifier.ts)
 * that injects the local harness's `{repoOwner, repoName, token}` and admits on
 * `status === 'verified'`. Do NOT call binding-service.ts here — that's the
 * repo↔harness ownership check and DOES gate on collaborator permission, which
 * is the wrong gate for read-admission (Stage-0 spike correction #2).
 *
 * Decision precedence: revoked → bad_sig → binding_invalid → admit. Revocation
 * is checked first (a revoked key is denied regardless of sig/binding), and the
 * sig check short-circuits before the (network) binding check.
 */

export interface AdmissionInput {
  /** Raw 32-byte Ed25519 device pubkey, base64 (the announce's device_pubkey). */
  device_pubkey: string;
  github_login: string;
  /** Whether the announce signature already verified (verifyAnnounce result). */
  sigValid: boolean;
}

export type AdmissionResult =
  | { admit: true }
  | { admit: false; reason: 'bad_sig' | 'binding_invalid' | 'revoked' };

export interface AdmissionDeciderOptions {
  /**
   * Verify that `device_pubkey` ↔ `github_login` is a valid two-channel
   * binding (any real GitHub identity). Stage 4 wires this to verifyBoth.
   */
  verifyBinding: (devicePubkey: string, githubLogin: string) => Promise<boolean>;
  /** Revoked device pubkeys (base64). A match is denied with reason 'revoked'. */
  revoked?: Set<string>;
}

/**
 * Build the read-admission decider. The returned function applies the D-004
 * decision (sig + binding + revocation; no collaborator gate) to one announce.
 */
export function makeAdmissionDecider(
  opts: AdmissionDeciderOptions,
): (input: AdmissionInput) => Promise<AdmissionResult> {
  const { verifyBinding, revoked } = opts;

  return async (input: AdmissionInput): Promise<AdmissionResult> => {
    if (revoked?.has(input.device_pubkey)) {
      return { admit: false, reason: 'revoked' };
    }
    if (!input.sigValid) {
      return { admit: false, reason: 'bad_sig' };
    }
    if (!(await verifyBinding(input.device_pubkey, input.github_login))) {
      return { admit: false, reason: 'binding_invalid' };
    }
    return { admit: true };
  };
}
