/**
 * external-prerequisite-apple-adapter.ts — typed-external-prerequisite-attestations-for-release-gates-2026-08-15 P-004(b).
 *
 * The Apple signing adapter: a {@link ExternalPrerequisiteProbe} reporting whether
 * a usable signing identity exists for a bundle id, and how it is bound.
 *
 * ## Why this adapter has more `absent` cases than the Stripe one
 *
 * Apple signing fails in several ways that are all genuinely OBSERVABLE, and each
 * is a determinate absence rather than an unknown: the certificate has expired,
 * the provisioning profile has expired, or the profile does not cover the bundle
 * id being shipped. In every one of those the probe DID establish that the wall is
 * down, so `absent` is the honest report (see plan Decision D-002, ruling 1 — the
 * reverse error, reporting absent when we merely failed to look, is the one that
 * corrupts the store).
 *
 * Only an unreachable/throwing source, or a descriptor this adapter cannot
 * interpret, is `indeterminate`.
 *
 * ## Two different expiries, deliberately not conflated
 *
 * The CERTIFICATE's expiry (and the profile's) is a fact about the external wall:
 * once past, you cannot sign, so readiness is `absent`. The ATTESTATION's expiry
 * (`expiresAt`, set by the runner from `spec.expirySec`) is a fact about how long
 * we are willing to trust a past observation before re-probing. They are unrelated
 * clocks and must not be collapsed: a cert valid for another year still needs
 * re-probing on the attestation cadence, because it can be revoked in the interim.
 *
 * ## Zero-secret
 *
 * The emitted binding is fingerprint/binding metadata built from an explicit
 * allowlist — a certificate SHA-256, a bundle id, a profile name and expiry. Never
 * the certificate itself, never a private key, and never the team identifier
 * (the P-002 contract warns specifically against account identifiers that are
 * themselves sensitive, and nothing in the gate needs it to decide readiness).
 */

import type { ExternalPrerequisiteSpec } from './external-prerequisites';
import type { ExternalPrerequisiteProbe, ProbeOutcome } from './external-prerequisite-probe-runner';

/** Non-secret description of an installed signing identity. */
export interface AppleSigningDescriptor {
  /** SHA-256 fingerprint of the signing certificate — a digest, never the cert. */
  readonly certificateSha256: string;
  /** ISO-8601 instant the certificate stops being valid. */
  readonly certificateNotAfter: string;
  /** Human-readable provisioning profile name. */
  readonly provisioningProfileName: string;
  /** ISO-8601 instant the provisioning profile expires. */
  readonly provisioningProfileExpiresAt: string;
  /** The bundle id the profile covers. May be a wildcard, e.g. `com.example.*`. */
  readonly profileBundleId: string;
}

/**
 * Where signing metadata comes from (in production: the keychain / profile store).
 * Injected so tests are fixture-backed and never touch a real credential.
 *
 * Contract, as for the Stripe source: return `null` for a determinate "no signing
 * identity installed"; THROW when the answer could not be obtained.
 */
export interface AppleSigningSource {
  describeSigningIdentity(spec: ExternalPrerequisiteSpec): Promise<AppleSigningDescriptor | null>;
}

export interface AppleAdapterDeps {
  readonly source: AppleSigningSource;
  /** Evaluation clock, injected so expiry checks are deterministic in tests. */
  readonly now: () => number;
  /**
   * The bundle id being shipped. Taken from the spec's signing context when not
   * supplied here.
   */
  readonly bundleId?: string;
}

/**
 * Does a profile's bundle id cover the shipped bundle id?
 *
 * Apple wildcards are a trailing `*` only (`com.example.*`), so this is not a
 * general glob. Implemented narrowly on purpose: a permissive matcher here would
 * quietly let a profile that does NOT cover the app read as satisfied, which is
 * the failure the gate exists to catch.
 */
export function profileCoversBundleId(profileBundleId: string, bundleId: string): boolean {
  if (typeof profileBundleId !== 'string' || typeof bundleId !== 'string') return false;
  if (profileBundleId.length === 0 || bundleId.length === 0) return false;
  if (profileBundleId === bundleId) return true;
  if (!profileBundleId.endsWith('.*')) return false;
  const prefix = profileBundleId.slice(0, -1); // keep the trailing dot: "com.example."
  // A bare wildcard must still cover a non-empty remainder, so `com.example.*`
  // does not match `com.example.` itself.
  return bundleId.startsWith(prefix) && bundleId.length > prefix.length;
}

function parseInstant(iso: string | undefined): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Build the Apple signing probe. */
export function createAppleSigningProbe(deps: AppleAdapterDeps): ExternalPrerequisiteProbe {
  return async (spec: ExternalPrerequisiteSpec): Promise<ProbeOutcome> => {
    const bundleId = deps.bundleId ?? spec.target.signingContext;
    if (!bundleId) {
      // A spec that does not say WHAT is being signed cannot be evaluated. That is
      // a declaration defect, not an observation that the wall is down.
      return {
        status: 'indeterminate',
        reason: 'no bundle id: spec.target.signingContext is unset and none was supplied',
      };
    }

    let descriptor: AppleSigningDescriptor | null;
    try {
      descriptor = await deps.source.describeSigningIdentity(spec);
    } catch (err) {
      return {
        status: 'indeterminate',
        reason: `signing identity lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (descriptor === null) return { status: 'absent', detail: 'no signing identity installed' };
    if (!descriptor || typeof descriptor.certificateSha256 !== 'string' || descriptor.certificateSha256.length === 0) {
      return { status: 'indeterminate', reason: 'signing descriptor missing certificateSha256' };
    }

    const nowMs = deps.now();
    if (!Number.isFinite(nowMs)) {
      return { status: 'indeterminate', reason: 'unusable evaluation instant' };
    }

    const certNotAfter = parseInstant(descriptor.certificateNotAfter);
    if (certNotAfter === null) {
      // An unreadable validity window is not "valid" and is not "expired" — it is
      // unknown. Guessing either way is the silent widening this plan guards.
      return {
        status: 'indeterminate',
        reason: `unparseable certificateNotAfter: ${String(descriptor.certificateNotAfter)}`,
      };
    }
    if (nowMs >= certNotAfter) {
      return { status: 'absent', detail: `signing certificate expired at ${descriptor.certificateNotAfter}` };
    }

    const profileExpires = parseInstant(descriptor.provisioningProfileExpiresAt);
    if (profileExpires === null) {
      return {
        status: 'indeterminate',
        reason: `unparseable provisioningProfileExpiresAt: ${String(descriptor.provisioningProfileExpiresAt)}`,
      };
    }
    if (nowMs >= profileExpires) {
      return {
        status: 'absent',
        detail: `provisioning profile expired at ${descriptor.provisioningProfileExpiresAt}`,
      };
    }

    if (!profileCoversBundleId(descriptor.profileBundleId, bundleId)) {
      return {
        status: 'absent',
        detail: `provisioning profile covers '${descriptor.profileBundleId}', which does not cover '${bundleId}'`,
      };
    }

    // Allowlisted, non-secret binding metadata. Note the absence of any team
    // identifier — see the file header.
    const binding: Record<string, string> = {
      certificateSha256: descriptor.certificateSha256,
      certificateNotAfter: descriptor.certificateNotAfter,
      bundleId,
      provisioningProfileName: descriptor.provisioningProfileName,
      provisioningProfileExpiresAt: descriptor.provisioningProfileExpiresAt,
    };

    return { status: 'present', binding };
  };
}
