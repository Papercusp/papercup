/**
 * read-admission — the read-admission decision (Model B substrate, Stage 3).
 *
 * D-004 (the security core): a peer aggregates another peer's log IFF
 *   (1) the announce `sig` verifies against `device_pubkey`  (→ `sigValid`), AND
 *   (2) `device_pubkey` ↔ `github_login` is a valid channel-2 binding for
 *       ANY real GitHub identity.
 *
 * There is deliberately NO repo-collaborator / permission gate here. GitHub's
 * PR-merge gate is the real authority over what lands; this advisory
 * replication layer is open to any device that proves a real GitHub identity.
 * Revocation is the only blocklist: a `revoked_pubkeys` set.
 *
 * D-002: admission verifies channel-2 ONLY (publicly-readable device-signed
 * contributor file). Channel-1 (OAuth GET /user) is a self-attestation the
 * LOCAL peer runs for publish/self; it is not applicable for remote admission
 * and always fails `oauth_user_id_mismatch` for any different engineer.
 *
 * D-006: `verifyBinding` now returns a 3-state `'verified' | 'pending' | 'fail'`.
 * A `'pending'` outcome (channel-2 file not yet visible on GitHub due to
 * propagation lag) maps to `reason:'pending'` — a RETRYABLE outcome that the
 * boot pending-retry loop handles within a grace window, rather than permanently
 * rejecting a peer whose file just hasn't propagated yet.
 *
 * This module is the PURE decider. The binding check is injected as
 * `verifyBinding(device_pubkey, github_login, github_user_id) => Promise<'verified'|'pending'|'fail'>`;
 * Stage 4 wires it to a thin adapter over `verifyAttestation(...)` — the
 * write-free gist gate (non-collaborator-join-fork-pr): it verifies the
 * announced attestation gist id with no shared-repo read. Do NOT call
 * binding-service.ts here — that's the repo↔harness ownership check and DOES
 * gate on collaborator permission, which is the wrong gate for read-admission
 * (Stage-0 spike correction #2).
 *
 * Decision precedence: revoked → bad_sig → verifyBinding → admit/pending/binding_invalid.
 * Revocation is checked first (a revoked key is denied regardless of sig/binding),
 * and the sig check short-circuits before the (network) binding check.
 */

export interface AdmissionInput {
  /** Raw 32-byte Ed25519 device pubkey, base64 (the announce's device_pubkey). */
  device_pubkey: string;
  github_login: string;
  /** The announce's numeric GitHub user id — the identity the attestation gist
   *  must be owned by. Threaded to `verifyBinding`. */
  github_user_id: number;
  /**
   * The announce's `attestation_gist_id` (write-free join). The binding gate
   * verifies this gist is owned by `github_user_id` and attests `device_pubkey`
   * — so it must be threaded to `verifyBinding`. Carried on the SIGNED announce,
   * so it cannot be substituted in transit.
   */
  attestation_gist_id: string;
  /** Whether the announce signature already verified (verifyAnnounce result). */
  sigValid: boolean;
}

export type AdmissionResult =
  | { admit: true }
  | { admit: false; reason: 'bad_sig' | 'binding_invalid' | 'revoked' | 'pending' };

export interface AdmissionDeciderOptions {
  /**
   * Verify that `device_pubkey` ↔ `github_user_id` is a valid binding, proven
   * from the `attestation_gist_id` carried on the announce (write-free join).
   * Stage 4c wires this to `buildVerifyBindingAdapter` over `verifyAttestation`
   * (the gist is public — no repo context). `githubLogin` is passed for parity
   * with the announce shape but the gist check does not need it.
   *
   * Returns:
   *   - `'verified'` : attestation valid → admit the peer.
   *   - `'pending'`  : OUR transient failure (GitHub unreachable) → retryable;
   *                   the boot retry loop re-checks within grace.
   *   - `'fail'`     : conclusive attestation failure (gist gone / owner or
   *                   pubkey mismatch / bad sig) → reject the peer.
   */
  verifyBinding: (
    devicePubkey: string,
    githubLogin: string,
    githubUserId: number,
    attestationGistId: string,
  ) => Promise<'verified' | 'pending' | 'fail'>;
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
    const bindingResult = await verifyBinding(
      input.device_pubkey,
      input.github_login,
      input.github_user_id,
      input.attestation_gist_id,
    );
    if (bindingResult === 'verified') return { admit: true };
    if (bindingResult === 'pending') return { admit: false, reason: 'pending' };
    return { admit: false, reason: 'binding_invalid' };
  };
}
