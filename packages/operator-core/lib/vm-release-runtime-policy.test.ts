import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertVmReleaseRuntimePolicy, assertVmReleaseRuntimePort } from './vm-release-runtime-policy';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vm-release-policy-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'serve.mjs'), 'serve-bytes');
  writeFileSync(join(root, 'bin/node'), 'node-bytes');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const manifest = {
    version: '1.2.3',
    buildSha: 'abc123',
    artifacts: [
      { name: 'serve.mjs', sha256: hash('serve-bytes') },
      { name: 'bin/node', sha256: hash('node-bytes') },
    ],
    ...overrides,
  };
  writeFileSync(join(root, 'build-provenance.json'), JSON.stringify(manifest));
  return root;
}

const vmEnv = {
  PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release',
  PAPERCUSP_BUILD_VERSION: '1.2.3',
  PAPERCUSP_BUILD_SHA: 'abc123',
  PAPERCUSP_PROVISION_ENV_OPERATORS: '0',
};

describe('vm-release runtime policy', () => {
  it('is a byte-for-byte behavior no-op outside the exact vm-release profile', () => {
    expect(() =>
      assertVmReleaseRuntimePolicy({
        env: { PAPERCUSP_DISTRIBUTION_PROFILE: 'dogfood' },
        sidecarDir: '/does/not/exist',
        hostname: '0.0.0.0',
        port: 3170,
      }),
    ).not.toThrow();
  });

  it('accepts an exact loopback package manifest and all declared hashes', () => {
    expect(() =>
      assertVmReleaseRuntimePolicy({
        env: vmEnv,
        sidecarDir: fixture(),
        hostname: '127.0.0.1',
        port: 45821,
      }),
    ).not.toThrow();
  });

  it.each([
    [{ ...vmEnv, PAPERCUSP_BUILD_VERSION: '9.9.9' }, {}, /manifest version/],
    [{ ...vmEnv, PAPERCUSP_BUILD_SHA: 'wrong' }, {}, /manifest buildSha/],
    [{ ...vmEnv, PAPERCUSP_PROVISION_ENV_OPERATORS: '1' }, {}, /must be exactly 0/],
    [{ ...vmEnv, PAPERCUSP_ENV_OPERATOR_ID: 'staging' }, {}, /second environment operator/],
    [vmEnv, { artifacts: [{ name: '../serve.mjs', sha256: '0'.repeat(64) }] }, /unsafe artifact/],
  ])('rejects an identity/environment violation', (env, manifest, error) => {
    expect(() =>
      assertVmReleaseRuntimePolicy({
        env: env as NodeJS.ProcessEnv,
        sidecarDir: fixture(manifest),
        hostname: '127.0.0.1',
        port: 45821,
      }),
    ).toThrow(error as RegExp);
  });

  it('rejects tampered bytes and unauthenticated off-loopback ingress', () => {
    const root = fixture();
    writeFileSync(join(root, 'serve.mjs'), 'tampered');
    expect(() =>
      assertVmReleaseRuntimePolicy({ env: vmEnv, sidecarDir: root, hostname: '127.0.0.1', port: 45821 }),
    ).toThrow(/hash mismatch/);
    expect(() =>
      assertVmReleaseRuntimePolicy({ env: vmEnv, sidecarDir: fixture(), hostname: '0.0.0.0', port: 45821 }),
    ).toThrow(/ALLOW_REMOTE_ADMIN/);
  });

  it.each([3055, 3170, 3270])('rejects dogfood port %i before and after sticky resolution', (port) => {
    expect(() => assertVmReleaseRuntimePort(port, vmEnv)).toThrow(/dogfood dev\/local\/staging/);
  });
});
