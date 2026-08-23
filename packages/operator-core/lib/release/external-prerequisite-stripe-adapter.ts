/**
 * external-prerequisite-stripe-adapter.ts — typed-external-prerequisite-attestations-for-release-gates-2026-08-15 P-004(a).
 *
 * The Stripe endpoint / webhook-binding adapter: a {@link ExternalPrerequisiteProbe}
 * that reports whether the Stripe wall is standing, and how it is bound.
 *
 * ## The rule this adapter exists to obey (plan Decision D-002, ruling 1)
 *
 * `absent` is reserved for "I successfully determined the wall is DOWN". Anything
 * this adapter could not determine — an unreachable binding source, a source that
 * threw, a descriptor it cannot interpret — is `indeterminate`.
 *
 * The temptation is to collapse them, because both fail the gate and "absent"
 * sounds like the safe default. It is not safe: `absent` is written to the store
 * as `present: false`, a durable positive claim that the probe RAN and observed
 * the wall down, and later transitions are computed against it. Reporting that
 * because an API call timed out teaches the store something untrue. The runner
 * defends itself (it converts a throw into indeterminate), but an adapter that
 * deliberately returns absent-on-error defeats the invariant at the one place no
 * downstream guard can recover the distinction.
 *
 * ## Zero-secret: an explicit allowlist, not a spread
 *
 * The emitted `binding` is built field-by-field from named descriptor properties.
 * It is deliberately NOT `{ ...descriptor }`. A spread would mean that the day the
 * binding source starts returning one more field — a webhook signing secret, say —
 * the adapter would begin copying it into the attestation store, and nothing in
 * this file would have changed to cause it. The allowlist makes that impossible by
 * construction rather than by review. (`buildAttestation` still screens values
 * downstream; this is the layer that stops the value being offered at all.)
 */

import type { ExternalPrerequisiteSpec } from './external-prerequisites';
import type { ExternalPrerequisiteProbe, ProbeOutcome } from './external-prerequisite-probe-runner';

/**
 * Presence of required environment-variable NAMES. Presence only — this interface
 * deliberately cannot return a value, so the adapter is structurally incapable of
 * reading a credential it might then leak into `binding`.
 */
export interface EnvPresenceReader {
  has(name: string): boolean;
}

/** Non-secret description of a bound Stripe webhook endpoint. */
export interface StripeEndpointDescriptor {
  /** The endpoint id, e.g. `we_1234`. An identifier, not a credential. */
  readonly endpointId: string;
  /** Stripe reports `enabled` or `disabled`. */
  readonly status: string;
  /** Pinned API version, when the endpoint declares one. */
  readonly apiVersion?: string;
  /** Event names the endpoint subscribes to. Only the COUNT is emitted. */
  readonly enabledEvents?: readonly string[];
}

/**
 * Where endpoint binding metadata comes from. Injected so tests are fixture-backed
 * and never touch a real credential or the network (P-004's stated constraint).
 *
 * Contract: return `null` when no endpoint is bound (a determinate absence).
 * THROW when the answer could not be obtained — the adapter converts that to
 * `indeterminate`. Do not return null to signal a failed lookup.
 */
export interface StripeEndpointSource {
  describeEndpoint(spec: ExternalPrerequisiteSpec): Promise<StripeEndpointDescriptor | null>;
}

export interface StripeAdapterDeps {
  readonly env: EnvPresenceReader;
  readonly source: StripeEndpointSource;
}

/** An env reader over `process.env`, for production wiring. */
export function processEnvPresenceReader(): EnvPresenceReader {
  return {
    has(name: string): boolean {
      const value = process.env[name];
      return typeof value === 'string' && value.length > 0;
    },
  };
}

/**
 * Build the Stripe endpoint probe.
 *
 * Order matters: the local, cheap, always-determinable check (are the required
 * env NAMES present?) runs first. A missing name is a real observed absence — we
 * looked, and the credential the release needs is not configured — so it is
 * reported as `absent` and does not require the binding source to be reachable.
 */
export function createStripeEndpointProbe(deps: StripeAdapterDeps): ExternalPrerequisiteProbe {
  return async (spec: ExternalPrerequisiteSpec): Promise<ProbeOutcome> => {
    const missing = spec.requiredNames.filter((name) => !deps.env.has(name));
    if (missing.length > 0) {
      // Determinate: the names are not set. Report the NAMES (safe — they are
      // names by contract, and assertZeroSecretSpec guards that upstream).
      return { status: 'absent', detail: `required env not set: ${missing.join(', ')}` };
    }

    let descriptor: StripeEndpointDescriptor | null;
    try {
      descriptor = await deps.source.describeEndpoint(spec);
    } catch (err) {
      return {
        status: 'indeterminate',
        reason: `stripe endpoint lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (descriptor === null) {
      return { status: 'absent', detail: 'no webhook endpoint bound for this target' };
    }
    if (!descriptor || typeof descriptor.endpointId !== 'string' || descriptor.endpointId.length === 0) {
      // A descriptor we cannot interpret is NOT an absence — we did not learn
      // that the wall is down, we learned that we cannot read the answer.
      return { status: 'indeterminate', reason: 'stripe endpoint descriptor missing endpointId' };
    }
    if (descriptor.status !== 'enabled') {
      return {
        status: 'absent',
        detail: `webhook endpoint ${descriptor.endpointId} is ${descriptor.status || 'in an unknown state'}`,
      };
    }

    // Allowlisted, non-secret binding metadata — see the file header.
    const binding: Record<string, string> = {
      endpointId: descriptor.endpointId,
      status: descriptor.status,
    };
    if (typeof descriptor.apiVersion === 'string' && descriptor.apiVersion.length > 0) {
      binding.apiVersion = descriptor.apiVersion;
    }
    if (Array.isArray(descriptor.enabledEvents)) {
      // The COUNT, not the list: the list is unbounded and would bloat the row
      // without telling a gate anything it can act on.
      binding.enabledEventCount = String(descriptor.enabledEvents.length);
    }

    return { status: 'present', binding };
  };
}
