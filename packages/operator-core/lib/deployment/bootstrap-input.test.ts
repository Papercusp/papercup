import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeploymentConfig } from '@papercusp/deployment-driver';
import { resolveCredential, resolveRuntimeTarball } from './bootstrap-input';

/**
 * Coverage for the two PURE credential/runtime resolvers in bootstrap-input.ts
 * (whole-app-test-coverage-breadth — deployment/* domain). These parse a
 * `credentialRef` / `provider.runtimeTarball` into the frame channel, so the
 * branch + `~`-expansion edges are security-relevant (which credential file the
 * frame stages). The async `buildDeployBootstrapInput` assembler is IO-heavy
 * (git/registry/blueprint/instance-config) — left for an integration test.
 */
describe('resolveCredential — credentialRef → frame credential channel', () => {
  const origHome = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = '/home/test';
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  });

  it('undefined / empty ref → {} (no frame credential)', () => {
    expect(resolveCredential(undefined)).toEqual({});
    expect(resolveCredential('')).toEqual({});
  });

  it('token:<path> → oauthTokenLocalPath (the OAuth-token-file channel)', () => {
    expect(resolveCredential('token:/creds/tok')).toEqual({ oauthTokenLocalPath: '/creds/tok' });
  });

  it('file:<path> → credentialsLocalPath (the .credentials.json channel)', () => {
    expect(resolveCredential('file:/creds/c.json')).toEqual({ credentialsLocalPath: '/creds/c.json' });
  });

  it('absolute path → credentialsLocalPath', () => {
    expect(resolveCredential('/abs/c.json')).toEqual({ credentialsLocalPath: '/abs/c.json' });
  });

  it('~ path → credentialsLocalPath with HOME expanded', () => {
    expect(resolveCredential('~/c.json')).toEqual({ credentialsLocalPath: '/home/test/c.json' });
  });

  it('expands ~ inside token: and file: refs', () => {
    expect(resolveCredential('token:~/tok')).toEqual({ oauthTokenLocalPath: '/home/test/tok' });
    expect(resolveCredential('file:~/c.json')).toEqual({ credentialsLocalPath: '/home/test/c.json' });
  });

  it('env:NAME and bare names are provider keys, NOT frame credentials → {}', () => {
    expect(resolveCredential('env:ANTHROPIC_API_KEY')).toEqual({});
    expect(resolveCredential('ANTHROPIC_API_KEY')).toEqual({});
    expect(resolveCredential('some-bare-name')).toEqual({});
  });

  it('falls back to a literal ~ when HOME is unset (no crash)', () => {
    delete process.env.HOME;
    expect(resolveCredential('~/c.json')).toEqual({ credentialsLocalPath: '~/c.json' });
  });

  it('a token: ref picks ONLY the oauth channel (never also the credentials channel)', () => {
    const r = resolveCredential('token:/x');
    expect(r.oauthTokenLocalPath).toBe('/x');
    expect(r.credentialsLocalPath).toBeUndefined();
  });
});

describe('resolveRuntimeTarball — provider.runtimeTarball resolution', () => {
  const origHome = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = '/home/test';
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  });
  const cfg = (provider?: Record<string, unknown>) => ({ provider }) as unknown as DeploymentConfig;

  it('no provider → undefined', () => {
    expect(resolveRuntimeTarball({} as DeploymentConfig)).toBeUndefined();
  });

  it('provider without runtimeTarball → undefined', () => {
    expect(resolveRuntimeTarball(cfg({ region: 'us-east' }))).toBeUndefined();
  });

  it('absolute runtimeTarball → returned verbatim', () => {
    expect(resolveRuntimeTarball(cfg({ runtimeTarball: '/pkgs/rt.tgz' }))).toBe('/pkgs/rt.tgz');
  });

  it('~ runtimeTarball → HOME expanded', () => {
    expect(resolveRuntimeTarball(cfg({ runtimeTarball: '~/rt.tgz' }))).toBe('/home/test/rt.tgz');
  });

  it('~ with HOME unset → literal ~ (no crash)', () => {
    delete process.env.HOME;
    expect(resolveRuntimeTarball(cfg({ runtimeTarball: '~/rt.tgz' }))).toBe('~/rt.tgz');
  });
});
