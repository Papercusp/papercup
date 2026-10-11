/**
 * Declared production configuration (P-011, plan verification-system-improvements-2026-10-10).
 *
 * A configuration-sensitive acceptance bar declares the configuration its proof must run
 * under, in `verification.productionConfiguration` ({ flags, env }). Every recorded test run
 * carries a CONFIGURATION SNAPSHOT (test_runs.execution_details.configuration): the resolved
 * feature-flag values plus SHA-256 hashes of the in-scope environment values (raw env values
 * are never stored: an env var can hold a secret).
 *
 * The two meet at bind time and at currentness classification:
 *  - `declaredConfigurationFingerprint(declared)` fingerprints what the bar requires;
 *  - `evidenceConfigurationFingerprint(snapshot, declared)` projects the run's snapshot onto
 *    the DECLARED keys and fingerprints that projection with the same canonical encoding.
 * Equal fingerprints mean the run executed under the declared configuration. A run with no
 * snapshot has NO fingerprint: it is refused at bind time and never counts as current.
 *
 * Pure module: no I/O, no flag store, no process.env reads. Callers supply the inputs.
 */
import { createHash } from 'node:crypto';

export interface ProductionConfiguration {
  /** Feature-flag key -> the value the proof must run with. */
  flags?: Record<string, boolean>;
  /** Environment variable -> the exact value the proof must run with. */
  env?: Record<string, string>;
}

export interface ConfigurationSnapshot {
  schemaVersion: 1;
  /** Resolved flag values at run time. */
  flags: Record<string, boolean>;
  /** In-scope env var -> sha256 hex of its value. Raw values are never recorded. */
  envSha256: Record<string, string>;
}

export const DECLARED_CONFIGURATION_FINGERPRINT_PREFIX = 'sha256-declared-config-v1:';

export type DeclaredConfigurationRefusalCode =
  | 'declared_configuration_fingerprint_missing'
  | 'declared_configuration_fingerprint_mismatch';

export type DeclaredConfigurationVerdict =
  | { ok: true; fingerprint: string; declaredFingerprint: string }
  | {
      ok: false;
      code: DeclaredConfigurationRefusalCode;
      declaredFingerprint: string;
      fingerprint: string | null;
      /** Declared keys whose run value differs (`flag:<key>` / `env:<key>`). */
      differing: string[];
      message: string;
    };

/** Env vars a snapshot records (hashed). Product configuration lives under these prefixes. */
export const SNAPSHOT_ENV_KEY = /^(PAPERCUSP_[A-Z0-9_]+|PC_[A-Z0-9_]+|NODE_ENV)$/;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a declared production configuration. Returns null when nothing is declared
 * (absent, or both maps empty). Throws on a malformed declaration: a bar that tries to
 * declare a configuration but cannot be read must not silently become "no declaration".
 */
export function parseProductionConfiguration(value: unknown): ProductionConfiguration | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new Error('productionConfiguration must be an object with flags and/or env');
  const unknownKeys = Object.keys(value).filter((key) => key !== 'flags' && key !== 'env');
  if (unknownKeys.length) throw new Error(`productionConfiguration has unknown keys: ${unknownKeys.join(', ')}`);
  const out: ProductionConfiguration = {};
  if (value.flags !== undefined) {
    if (!isPlainObject(value.flags)) throw new Error('productionConfiguration.flags must map flag keys to booleans');
    for (const [key, flag] of Object.entries(value.flags)) {
      if (typeof flag !== 'boolean') throw new Error(`productionConfiguration.flags.${key} must be a boolean`);
    }
    if (Object.keys(value.flags).length) out.flags = { ...(value.flags as Record<string, boolean>) };
  }
  if (value.env !== undefined) {
    if (!isPlainObject(value.env)) throw new Error('productionConfiguration.env must map env var names to strings');
    for (const [key, envValue] of Object.entries(value.env)) {
      if (typeof envValue !== 'string') throw new Error(`productionConfiguration.env.${key} must be a string`);
      if (!SNAPSHOT_ENV_KEY.test(key)) {
        throw new Error(`productionConfiguration.env.${key} is not a recorded env var (allowed: ${SNAPSHOT_ENV_KEY.source})`);
      }
    }
    if (Object.keys(value.env).length) out.env = { ...(value.env as Record<string, string>) };
  }
  return out.flags || out.env ? out : null;
}

/** Build the snapshot a test-run ledger row records. */
export function captureConfigurationSnapshot(input: {
  flags: Record<string, unknown>;
  env: Record<string, string | undefined>;
}): ConfigurationSnapshot {
  const flags: Record<string, boolean> = {};
  for (const key of Object.keys(input.flags).sort()) {
    const value = input.flags[key];
    if (typeof value === 'boolean') flags[key] = value;
  }
  const envSha256: Record<string, string> = {};
  for (const key of Object.keys(input.env).sort()) {
    const value = input.env[key];
    if (typeof value === 'string' && SNAPSHOT_ENV_KEY.test(key)) envSha256[key] = sha256Hex(value);
  }
  return { schemaVersion: 1, flags, envSha256 };
}

/** Read the snapshot from a test_runs.execution_details value; null when absent or malformed. */
export function readConfigurationSnapshot(executionDetails: unknown): ConfigurationSnapshot | null {
  if (!isPlainObject(executionDetails)) return null;
  const snapshot = executionDetails.configuration;
  if (!isPlainObject(snapshot) || snapshot.schemaVersion !== 1) return null;
  if (!isPlainObject(snapshot.flags) || !isPlainObject(snapshot.envSha256)) return null;
  if (Object.values(snapshot.flags).some((value) => typeof value !== 'boolean')) return null;
  if (Object.values(snapshot.envSha256).some((value) => typeof value !== 'string')) return null;
  return {
    schemaVersion: 1,
    flags: snapshot.flags as Record<string, boolean>,
    envSha256: snapshot.envSha256 as Record<string, string>,
  };
}

/** Canonical projection: sorted keys; a declared key absent from the run is `null`. */
function fingerprintProjection(flags: Record<string, boolean | null>, envSha256: Record<string, string | null>): string {
  const canonical = JSON.stringify({
    flags: Object.keys(flags).sort().map((key) => [key, flags[key]]),
    env: Object.keys(envSha256).sort().map((key) => [key, envSha256[key]]),
  });
  return `${DECLARED_CONFIGURATION_FINGERPRINT_PREFIX}${sha256Hex(canonical)}`;
}

/** Fingerprint of what a bar declares. */
export function declaredConfigurationFingerprint(declared: ProductionConfiguration): string {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(declared.env ?? {})) env[key] = sha256Hex(value);
  return fingerprintProjection({ ...(declared.flags ?? {}) }, env);
}

/** Fingerprint of a run's snapshot projected onto the declared keys. */
export function evidenceConfigurationFingerprint(
  snapshot: ConfigurationSnapshot,
  declared: ProductionConfiguration,
): string {
  const flags: Record<string, boolean | null> = {};
  for (const key of Object.keys(declared.flags ?? {})) flags[key] = snapshot.flags[key] ?? null;
  const env: Record<string, string | null> = {};
  for (const key of Object.keys(declared.env ?? {})) env[key] = snapshot.envSha256[key] ?? null;
  return fingerprintProjection(flags, env);
}

/** Bind-time judgement: does this run's snapshot match the bar's declared configuration? */
export function judgeDeclaredConfiguration(
  declared: ProductionConfiguration,
  snapshot: ConfigurationSnapshot | null,
): DeclaredConfigurationVerdict {
  const declaredFingerprint = declaredConfigurationFingerprint(declared);
  if (!snapshot) {
    return {
      ok: false,
      code: 'declared_configuration_fingerprint_missing',
      declaredFingerprint,
      fingerprint: null,
      differing: [],
      message:
        'the bar declares verification.productionConfiguration, but this evidence carries no configuration '
        + 'snapshot (no declared-configuration fingerprint). Re-run it through testing:run or '
        + 'scripts/mutation-probe.sh, which record the snapshot, and bind that run.',
    };
  }
  const fingerprint = evidenceConfigurationFingerprint(snapshot, declared);
  if (fingerprint === declaredFingerprint) return { ok: true, fingerprint, declaredFingerprint };
  const differing = [
    ...Object.entries(declared.flags ?? {})
      .filter(([key, value]) => snapshot.flags[key] !== value)
      .map(([key]) => `flag:${key}`),
    ...Object.entries(declared.env ?? {})
      .filter(([key, value]) => snapshot.envSha256[key] !== sha256Hex(value))
      .map(([key]) => `env:${key}`),
  ].sort();
  return {
    ok: false,
    code: 'declared_configuration_fingerprint_mismatch',
    declaredFingerprint,
    fingerprint,
    differing,
    message:
      `the run's configuration differs from the bar's declared verification.productionConfiguration on `
      + `${differing.join(', ')}. Re-run under the declared configuration and bind that run.`,
  };
}
