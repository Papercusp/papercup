/**
 * external-prerequisites.ts — typed-external-prerequisite-attestations-for-release-gates-2026-08-15 P-002.
 *
 * The typed contract for a release gate's EXTERNAL prerequisites — the walls that
 * live outside this repo (a Stripe endpoint binding, an Apple signing certificate)
 * and that no amount of green tests can observe.
 *
 * ## Why this exists
 *
 * Today an external wall is prose. An operator discovers "the Apple cert expired"
 * by reading work-items, and a release scorecard can sit GREEN across the whole
 * window in which the wall silently changed, because nothing in the gate models
 * the wall at all. This module makes the wall a typed, expiring, machine-readable
 * declaration, so an absent or stale prerequisite is a NAMED refusal rather than
 * something a human has to already know to go looking for.
 *
 * ## The one design constraint: an ABSENCE must never read as READY
 *
 * This is the same failure class `candidate-contains.ts` was written to kill, and
 * it is sharper here because the consequence is shipping. The naive shape —
 * `ready: boolean`, defaulting false-y — quietly converts *we could not determine
 * the state* into *the prerequisite is missing*, which sounds safe, and its mirror
 * converts *the probe never ran* into *ready*, which is not. So:
 *
 *   - readiness is a DISCRIMINATED UNION, never a bare boolean;
 *   - `unknown` is a first-class state carrying WHY, and is NOT satisfied;
 *   - `expired` is reported distinctly from `absent` (an operator needs to know
 *     whether a thing was never there or has lapsed) but both FAIL the gate;
 *   - {@link isPrerequisiteSatisfied} admits exactly one state, so adding a new
 *     state to the union can never silently widen what passes.
 *
 * ## Zero-secret by construction
 *
 * An attestation row records that a capability is PRESENT and how it is BOUND —
 * never the credential. There is deliberately no field on
 * {@link ExternalPrerequisiteAttestation} that a secret belongs in, which is the
 * real guarantee; {@link findSecretShapedValues} is defense-in-depth for the case
 * where a probe author puts one in `binding` anyway, and it is enforced at
 * construction by {@link buildAttestation}.
 *
 * Note the posture difference from `cupboard/publisher-attestation.ts`, the other
 * "attestation" in this tree: that one is best-effort and returns null on any
 * failure because it must NEVER block a publish. This one gates a release, so it
 * fails CLOSED. Same word, opposite contract — do not copy its error handling here.
 *
 * Scope: this module is the CONTRACT + its storage mapping. Executing probes and
 * driving absent->ready->expired transitions is P-003's probe runner; the two
 * capability adapters are P-004; wiring the refusal into the gate is P-005.
 */

/** Capability kinds a prerequisite can describe. P-004 ships the first two adapters. */
export const EXTERNAL_CAPABILITY_KINDS = ['stripe-endpoint', 'apple-signing'] as const;

export type ExternalCapabilityKind = (typeof EXTERNAL_CAPABILITY_KINDS)[number];

/**
 * WHERE the capability is bound. Both fields are non-secret descriptors: a hostname
 * or a signing-context label, never a credential or an account identifier that is
 * itself sensitive.
 */
export interface ExternalPrerequisiteTarget {
  /** Target host, e.g. `api.stripe.com`. */
  readonly host?: string;
  /** Signing context label, e.g. `developer-id-application`. */
  readonly signingContext?: string;
}

/**
 * The declaration a release gate makes: "this external wall must be standing".
 *
 * `requiredNames` holds NAMES and SCOPES — environment-variable names, OAuth
 * scopes, entitlement identifiers. It never holds values; see
 * {@link assertZeroSecretSpec}.
 */
export interface ExternalPrerequisiteSpec {
  /** Stable identifier, unique within a release scope. */
  readonly key: string;
  readonly capabilityKind: ExternalCapabilityKind;
  /** Required env-var NAMES / scopes — names only, never values. */
  readonly requiredNames: readonly string[];
  readonly target: ExternalPrerequisiteTarget;
  /** Non-secret reference to the probe that attests this prerequisite (P-003 resolves it). */
  readonly probeRef: string;
  /** How long an attestation stays ready before it must be re-probed. */
  readonly expirySec: number;
  /** The work-item accountable for this wall (WI-/EI- id). */
  readonly owningWorkItem: string;
  /** events:emit key fired on an absent->ready transition. */
  readonly completionEvent: string;
}

export type AttestationProvenance = 'probe' | 'operator' | 'imported';

/**
 * A receipt that a prerequisite was observed present at a point in time.
 *
 * `binding` carries fingerprint / binding METADATA only — a certificate's SHA-256
 * fingerprint, a webhook endpoint id, a bundle id. Never a credential value.
 */
export interface ExternalPrerequisiteAttestation {
  readonly key: string;
  readonly capabilityKind: ExternalCapabilityKind;
  /**
   * Whether the probe found the capability present. A probe that ran and found the
   * wall DOWN records `present: false` — which is different from no row at all, and
   * both are surfaced distinctly by {@link resolvePrerequisiteReadiness}.
   */
  readonly present: boolean;
  readonly binding: Readonly<Record<string, string>>;
  /** ISO-8601 UTC instant the observation was made. */
  readonly observedAt: string;
  /** ISO-8601 UTC instant after which this receipt is stale. */
  readonly expiresAt: string;
  readonly provenance: AttestationProvenance;
  readonly probeRef: string;
}

/**
 * The readiness verdict. A discriminated union rather than a boolean so that a
 * caller cannot accidentally treat "we don't know" as either answer.
 */
export type PrerequisiteReadiness =
  | { readonly state: 'ready'; readonly expiresAt: string; readonly attestation: ExternalPrerequisiteAttestation }
  | { readonly state: 'absent'; readonly reason: 'no-attestation' | 'probe-reported-absent' }
  | { readonly state: 'expired'; readonly expiredAt: string; readonly attestation: ExternalPrerequisiteAttestation }
  | { readonly state: 'unknown'; readonly reason: string };

/**
 * The ONLY admitting predicate. Exhaustive by construction: a new member added to
 * {@link PrerequisiteReadiness} does not silently start passing, because nothing
 * here widens except by an explicit edit to this one expression.
 */
export function isPrerequisiteSatisfied(readiness: PrerequisiteReadiness): boolean {
  return readiness.state === 'ready';
}

/** Parse an ISO instant to epoch ms, or null when it is not a usable timestamp. */
function parseInstant(iso: string | undefined | null): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolve a prerequisite's readiness at instant `nowMs`.
 *
 * `now` is injected rather than read from the clock so expiry is deterministic in
 * tests and so a caller evaluating a whole release scope evaluates every
 * prerequisite against ONE instant (otherwise a long scope-walk can report two
 * prerequisites as of different times, and a boundary case lands on whichever side
 * the walk happened to reach it).
 */
export function resolvePrerequisiteReadiness(
  attestation: ExternalPrerequisiteAttestation | null | undefined,
  nowMs: number,
): PrerequisiteReadiness {
  if (!attestation) return { state: 'absent', reason: 'no-attestation' };
  if (!attestation.present) return { state: 'absent', reason: 'probe-reported-absent' };

  const expiresMs = parseInstant(attestation.expiresAt);
  if (expiresMs === null) {
    // An unparseable expiry is NOT treated as "never expires" — that is the exact
    // silent-widening this module exists to prevent.
    return { state: 'unknown', reason: `unparseable expiresAt: ${String(attestation.expiresAt)}` };
  }
  if (!Number.isFinite(nowMs)) {
    return { state: 'unknown', reason: 'unusable evaluation instant' };
  }
  // Expiry is INCLUSIVE of the boundary: at exactly expiresAt the receipt is spent.
  if (nowMs >= expiresMs) {
    return { state: 'expired', expiredAt: attestation.expiresAt, attestation };
  }
  return { state: 'ready', expiresAt: attestation.expiresAt, attestation };
}

/**
 * Credential-shaped patterns. These are deliberately anchored, well-known issuer
 * prefixes plus two structural shapes (PEM private key, JWT) — not a general
 * entropy heuristic, which would false-positive on the very fingerprints this
 * store is FOR.
 */
const CREDENTIAL_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: 'stripe-secret-key', re: /^(sk|rk)_(live|test)_[A-Za-z0-9]+/ },
  { label: 'github-token', re: /^gh[pousr]_[A-Za-z0-9]{16,}/ },
  { label: 'slack-token', re: /^xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'aws-access-key-id', re: /^AKIA[0-9A-Z]{16}$/ },
  { label: 'pem-private-key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { label: 'jwt', re: /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./ },
];

/**
 * A binding value long enough that it is almost certainly material rather than a
 * fingerprint. A SHA-512 hex digest is 128 chars, so the bound sits above it.
 */
const MAX_BINDING_VALUE_CHARS = 160;

export interface SecretShapedFinding {
  /** The offending key within the inspected record. */
  readonly field: string;
  /** Why it was rejected — an issuer label, or `oversized-value`. */
  readonly reason: string;
}

/**
 * Report every credential-shaped value in a record. Returns the FINDINGS rather
 * than throwing so a caller can log all of them at once; {@link buildAttestation}
 * is the enforcing chokepoint.
 *
 * Never returns the offending value itself — that would copy the secret into logs,
 * which is the harm being prevented.
 */
export function findSecretShapedValues(
  record: Readonly<Record<string, string>> | undefined | null,
): SecretShapedFinding[] {
  if (!record) return [];
  const findings: SecretShapedFinding[] = [];
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== 'string') continue;
    const matched = CREDENTIAL_PATTERNS.find((p) => p.re.test(value));
    if (matched) {
      findings.push({ field, reason: matched.label });
      continue;
    }
    if (value.length > MAX_BINDING_VALUE_CHARS) {
      findings.push({ field, reason: 'oversized-value' });
    }
  }
  return findings;
}

/**
 * Guard a SPEC. `requiredNames` should hold names like `STRIPE_SECRET_KEY`; this
 * catches the author who pasted the value instead of the name.
 */
export function assertZeroSecretSpec(spec: ExternalPrerequisiteSpec): void {
  const asRecord: Record<string, string> = {};
  spec.requiredNames.forEach((name, i) => {
    asRecord[`requiredNames[${i}]`] = name;
  });
  const findings = findSecretShapedValues(asRecord);
  if (findings.length > 0) {
    throw new Error(
      `external prerequisite '${spec.key}' declares credential-shaped requiredNames ` +
        `(${findings.map((f) => `${f.field}: ${f.reason}`).join(', ')}). ` +
        `requiredNames holds NAMES and SCOPES, never values.`,
    );
  }
}

/**
 * The construction chokepoint. Every attestation reaching the store goes through
 * here, so the zero-secret invariant is enforced structurally rather than by each
 * probe author remembering it.
 */
export function buildAttestation(input: {
  key: string;
  capabilityKind: ExternalCapabilityKind;
  present: boolean;
  binding: Readonly<Record<string, string>>;
  observedAt: string;
  expirySec: number;
  provenance: AttestationProvenance;
  probeRef: string;
}): ExternalPrerequisiteAttestation {
  const findings = findSecretShapedValues(input.binding);
  if (findings.length > 0) {
    throw new Error(
      `attestation '${input.key}' carries credential-shaped binding values ` +
        `(${findings.map((f) => `${f.field}: ${f.reason}`).join(', ')}). ` +
        `binding holds fingerprint/binding metadata only — never a credential value.`,
    );
  }
  const observedMs = parseInstant(input.observedAt);
  if (observedMs === null) {
    throw new Error(`attestation '${input.key}' has an unparseable observedAt: ${String(input.observedAt)}`);
  }
  if (!Number.isFinite(input.expirySec) || input.expirySec <= 0) {
    throw new Error(`attestation '${input.key}' needs a positive expirySec, got ${String(input.expirySec)}`);
  }
  return {
    key: input.key,
    capabilityKind: input.capabilityKind,
    present: input.present,
    binding: { ...input.binding },
    observedAt: new Date(observedMs).toISOString(),
    expiresAt: new Date(observedMs + input.expirySec * 1000).toISOString(),
    provenance: input.provenance,
    probeRef: input.probeRef,
  };
}

/**
 * The storage row shape, mirroring migration 928 column-for-column.
 *
 * This mapping exists so the SQL and the TS type cannot drift silently: a column
 * rename that is not reflected here fails the round-trip test rather than
 * surfacing as a null field at read time.
 */
export interface ExternalPrerequisiteAttestationRow {
  readonly prerequisite_key: string;
  readonly capability_kind: string;
  readonly present: boolean;
  readonly binding: Record<string, string>;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly provenance: string;
  readonly probe_ref: string;
}

export function attestationToRow(a: ExternalPrerequisiteAttestation): ExternalPrerequisiteAttestationRow {
  return {
    prerequisite_key: a.key,
    capability_kind: a.capabilityKind,
    present: a.present,
    binding: { ...a.binding },
    observed_at: a.observedAt,
    expires_at: a.expiresAt,
    provenance: a.provenance,
    probe_ref: a.probeRef,
  };
}

/**
 * Read a row back. Returns null — never a partially-populated attestation — when
 * the row cannot be interpreted, so a malformed row reads as `absent` downstream
 * instead of as a receipt with missing fields.
 */
export function rowToAttestation(
  row: ExternalPrerequisiteAttestationRow | null | undefined,
): ExternalPrerequisiteAttestation | null {
  if (!row) return null;
  const kind = row.capability_kind as ExternalCapabilityKind;
  if (!EXTERNAL_CAPABILITY_KINDS.includes(kind)) return null;
  if (typeof row.prerequisite_key !== 'string' || row.prerequisite_key.length === 0) return null;
  if (typeof row.present !== 'boolean') return null;
  if (parseInstant(row.observed_at) === null || parseInstant(row.expires_at) === null) return null;
  const provenance = row.provenance as AttestationProvenance;
  if (provenance !== 'probe' && provenance !== 'operator' && provenance !== 'imported') return null;
  return {
    key: row.prerequisite_key,
    capabilityKind: kind,
    present: row.present,
    binding: { ...(row.binding ?? {}) },
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    provenance,
    probeRef: row.probe_ref,
  };
}
