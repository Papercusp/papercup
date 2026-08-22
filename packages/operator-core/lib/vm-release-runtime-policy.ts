/**
 * Fail-closed runtime policy for the immutable `vm-release` distribution.
 *
 * Dogfood and development launches are deliberately unchanged: every guard in
 * this module is gated on the exact distribution profile. A vm-release process,
 * however, must prove that its packaged sidecar bytes match the package-contained
 * provenance manifest before it can reuse or start an operator.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, posix, resolve, sep } from 'node:path';
import { assertRemoteAuthReady } from './remote-auth-policy';

export const VM_RELEASE_DISTRIBUTION_PROFILE = 'vm-release';
export const VM_RELEASE_FORBIDDEN_PORTS = new Set([3055, 3170, 3270]);

interface ProvenanceArtifact {
  name: string;
  sha256: string;
}

interface BuildProvenance {
  version: string;
  buildSha: string;
  artifacts: ProvenanceArtifact[];
}

export interface VmReleaseRuntimePolicyOptions {
  env?: NodeJS.ProcessEnv;
  sidecarDir: string;
  hostname: string;
  port: number;
}

export function isVmReleaseDistribution(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_DISTRIBUTION_PROFILE === VM_RELEASE_DISTRIBUTION_PROFILE;
}

function fail(detail: string): never {
  throw new Error(`[vm-release] immutable runtime policy refused startup: ${detail}`);
}

function parseManifest(path: string): BuildProvenance {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read package-contained build-provenance.json (${(error as Error).message})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('build-provenance.json must contain one object');
  }
  const manifest = value as Partial<BuildProvenance>;
  if (typeof manifest.version !== 'string' || !manifest.version) {
    fail('build-provenance.json has no exact version');
  }
  if (typeof manifest.buildSha !== 'string' || !manifest.buildSha) {
    fail('build-provenance.json has no exact buildSha');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail('build-provenance.json lists no artifacts');
  }
  return manifest as BuildProvenance;
}

function safeArtifactName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !isAbsolute(name) &&
    !name.includes('\\') &&
    !name.split('/').some((part) => part === '' || part === '.' || part === '..') &&
    posix.normalize(name) === name
  );
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Assert just the selected HTTP port; called again after sticky-port resolution. */
export function assertVmReleaseRuntimePort(port: number, env: NodeJS.ProcessEnv = process.env): void {
  if (!isVmReleaseDistribution(env)) return;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    fail(`operator port ${String(port)} is invalid`);
  }
  if (VM_RELEASE_FORBIDDEN_PORTS.has(port)) {
    fail(`operator port ${port} is reserved for a dogfood dev/local/staging surface`);
  }
}

/**
 * Verify immutable package identity and the one-operator network/environment
 * contract. This must run before `serve --ensure` can adopt an existing process.
 */
export function assertVmReleaseRuntimePolicy(options: VmReleaseRuntimePolicyOptions): void {
  const env = options.env ?? process.env;
  if (!isVmReleaseDistribution(env)) return;

  const expectedVersion = env.PAPERCUSP_BUILD_VERSION;
  const expectedSha = env.PAPERCUSP_BUILD_SHA;
  if (!expectedVersion) fail('PAPERCUSP_BUILD_VERSION is required');
  if (!expectedSha) fail('PAPERCUSP_BUILD_SHA is required');
  if (env.PAPERCUSP_ENV_OPERATOR_ID) {
    fail('PAPERCUSP_ENV_OPERATOR_ID would create a second environment operator');
  }
  if (env.PAPERCUSP_PROVISION_ENV_OPERATORS !== '0') {
    fail('PAPERCUSP_PROVISION_ENV_OPERATORS must be exactly 0');
  }

  assertVmReleaseRuntimePort(options.port, env);
  assertRemoteAuthReady(options.hostname, env);

  const sidecarRoot = realpathSync(options.sidecarDir);
  const manifest = parseManifest(resolve(sidecarRoot, 'build-provenance.json'));
  if (manifest.version !== expectedVersion) {
    fail(`manifest version ${manifest.version} does not equal baked version ${expectedVersion}`);
  }
  if (manifest.buildSha !== expectedSha) {
    fail(`manifest buildSha ${manifest.buildSha} does not equal baked SHA ${expectedSha}`);
  }

  const seen = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (!artifact || !safeArtifactName(artifact.name)) {
      fail(`unsafe artifact name ${JSON.stringify(artifact?.name)}`);
    }
    if (seen.has(artifact.name)) fail(`duplicate artifact ${artifact.name}`);
    seen.add(artifact.name);
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      fail(`artifact ${artifact.name} has an invalid sha256`);
    }
    const artifactPath = resolve(sidecarRoot, artifact.name);
    const realArtifact = realpathSync(artifactPath);
    if (realArtifact !== sidecarRoot && !realArtifact.startsWith(`${sidecarRoot}${sep}`)) {
      fail(`artifact ${artifact.name} resolves outside the packaged sidecar`);
    }
    if (!lstatSync(artifactPath).isFile()) fail(`artifact ${artifact.name} is not a file`);
    const actual = sha256(artifactPath);
    if (actual !== artifact.sha256) {
      fail(`artifact ${artifact.name} hash mismatch (expected ${artifact.sha256}, got ${actual})`);
    }
  }
  for (const required of ['serve.mjs', 'bin/node']) {
    if (!seen.has(required)) fail(`manifest does not attest required runtime artifact ${required}`);
  }
}
