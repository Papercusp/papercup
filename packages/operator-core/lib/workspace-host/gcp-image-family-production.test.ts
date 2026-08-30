import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';
import { describe, expect, it, vi } from 'vitest';

import {
  composeGcpImageFamilyReleaseAdapter,
  CredentialScopedGcpImageFamilyCommandRunner,
  executeConfiguredGcpImageFamilyRelease,
  isSupportedGcpImageFamilyCredentialRef,
  probeGcpImageFamilyCredential,
  probeGcpImageFamilyExecutables,
  safeGcpImageFamilyCommandEnvironment,
} from './gcp-image-family-production';
import type { GcpImageFamilyCommandResult } from './gcp-image-family-adapter';

const connection = (overrides: Partial<WorkspaceHostProviderConnection> = {}): WorkspaceHostProviderConnection => ({
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
  scope: { kind: 'project', id: 'active-alcove-504205-q3' },
  provider: { projectId: 'active-alcove-504205-q3' },
  ...overrides,
});

describe('GCP image-family production composition', () => {
  it('strips process-global Google key/token channels from command environments', () => {
    const env = safeGcpImageFamilyCommandEnvironment({
      PATH: '/bin',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json',
      GOOGLE_OAUTH_ACCESS_TOKEN: 'token',
      CLOUDSDK_AUTH_ACCESS_TOKEN: 'token',
    });
    expect(env.PATH).toBe('/bin');
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.GOOGLE_OAUTH_ACCESS_TOKEN).toBeUndefined();
    expect(env.CLOUDSDK_AUTH_ACCESS_TOKEN).toBeUndefined();
  });

  it('does not allow a per-call override to reintroduce a forbidden key path', async () => {
    const calls: Array<{ command: string; env?: Record<string, string | undefined> }> = [];
    const inner = {
      run: vi.fn(
        async (command: string, _args: readonly string[], options?: { env?: Record<string, string | undefined> }) => {
          calls.push({ command, env: options?.env });
          return { exitCode: 0, stdout: '', stderr: '' } satisfies GcpImageFamilyCommandResult;
        },
      ),
    };
    const runner = new CredentialScopedGcpImageFamilyCommandRunner(inner);
    await runner.run('packer', ['--version'], {
      env: { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/attempted-key.json', BUILD_MARKER: '1' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toMatchObject({ BUILD_MARKER: '1' });
    expect(calls[0]?.env?.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  it('binds the persisted project and safe credential reference to the concrete adapter', () => {
    const composition = composeGcpImageFamilyReleaseAdapter(connection(), {
      acquireAuth: async () => ({ accessToken: 'test-token', projectId: 'active-alcove-504205-q3' }),
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    });
    expect(composition.projectId).toBe('active-alcove-504205-q3');
    expect(composition.credentialRef).toBe('gcloud://active-user');
    expect(composition.adapter).toEqual(
      expect.objectContaining({
        buildCandidate: expect.any(Function),
        scanImage: expect.any(Function),
        inspectImage: expect.any(Function),
        launchCleanRoomCanary: expect.any(Function),
        publishFamilyVersion: expect.any(Function),
        resolveFamily: expect.any(Function),
        deprecateImage: expect.any(Function),
      }),
    );
  });

  it('rejects non-GCP and unsafe credential connections before constructing a provider', () => {
    expect(() => composeGcpImageFamilyReleaseAdapter(connection({ target: 'aws' }))).toThrow(
      /requires a 'gcp' connection/,
    );
    expect(() =>
      composeGcpImageFamilyReleaseAdapter(
        connection({ cloudCredentialRef: { kind: 'cloud', ref: 'env:GOOGLE_APPLICATION_CREDENTIALS' } }),
      ),
    ).toThrow(/must use adc:\/\//);
  });

  it('pins isSupportedGcpImageFamilyCredentialRef to what this seam actually accepts', () => {
    // ONE rule, two callers. Producers that build a connection (the image-release request CLI)
    // reject an unusable reference at their OWN edge using this predicate; the seam below is what
    // ultimately enforces it. A divergence between them is invisible at runtime and reads as a bug
    // in the wrong file: the CLI would either refuse a chain this seam would have taken, or wave
    // through one it will not. This table is the guard that keeps the two in lockstep.
    const refs = [
      'gcloud://active-user',
      '  gcloud://active-user  ',
      'adc://default',
      'adc://impersonate/release@active-alcove-504205-q3.iam.gserviceaccount.com',
      'env:GOOGLE_APPLICATION_CREDENTIALS',
      'hosted://papercusp/gcp',
      'adc://with space',
      'adc://',
      '',
    ];
    for (const ref of refs) {
      const predicateAccepts = isSupportedGcpImageFamilyCredentialRef(ref);
      let thrown: unknown;
      try {
        composeGcpImageFamilyReleaseAdapter(connection({ cloudCredentialRef: { kind: 'cloud', ref } }), {
          acquireAuth: async () => ({ accessToken: 'test-token', projectId: 'active-alcove-504205-q3' }),
          commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
        });
      } catch (caught) {
        thrown = caught;
      }
      if (predicateAccepts) {
        expect(thrown, `predicate accepts ${JSON.stringify(ref)} but the seam refused it`).toBeUndefined();
      } else {
        // Assert the REASON, not merely that something threw — otherwise an unrelated failure
        // (a bad project, say) would make a real divergence look like agreement.
        expect(String(thrown), `predicate rejects ${JSON.stringify(ref)} but the seam took it`).toMatch(
          /[Cc]redentialRef/,
        );
      }
    }
  });

  it('probes short-lived auth without returning the bearer token and catches project mismatch', async () => {
    await expect(
      probeGcpImageFamilyCredential(connection(), {
        acquireAuth: async () => ({
          accessToken: 'never-returned',
          identity: 'owner@example.test',
          projectId: 'active-alcove-504205-q3',
        }),
      }),
    ).resolves.toEqual({
      ok: true,
      projectId: 'active-alcove-504205-q3',
      credentialRef: 'gcloud://active-user',
      identity: 'owner@example.test',
      resolvedProjectId: 'active-alcove-504205-q3',
    });
    await expect(
      probeGcpImageFamilyCredential(connection(), {
        acquireAuth: async () => ({ accessToken: 'token', projectId: 'other-project' }),
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/different GCP project/) });
  });

  it('checks configured executables without spawning a shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcp-image-release-executables-'));
    try {
      const executable = join(dir, 'tool');
      await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await chmod(executable, 0o755);
      await expect(
        probeGcpImageFamilyExecutables({
          packerExecutable: executable,
          scanExecutable: executable,
          cleanRoomExecutable: executable,
          bootstrapAcceptanceExecutable: executable,
        }),
      ).resolves.toMatchObject({
        ok: true,
        missing: [],
        executables: {
          packer: executable,
          scanner: executable,
          cleanRoom: executable,
          bootstrapAcceptance: executable,
        },
      });
      await expect(
        probeGcpImageFamilyExecutables({
          packerExecutable: join(dir, 'missing'),
          scanExecutable: executable,
          cleanRoomExecutable: executable,
          bootstrapAcceptanceExecutable: executable,
        }),
      ).resolves.toMatchObject({ ok: false, missing: ['packer'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The PRE-build acceptance binary produces the clean-room report the release gate ratifies.
   * It was registered in GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES but never probed, so the
   * read-only preflight reported `ok` while the release could not produce its gate evidence —
   * the exact class of failure this preflight exists to catch before any mutation.
   */
  it('fails the preflight when the pre-build bootstrap-acceptance binary is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcp-image-release-acceptance-'));
    try {
      const executable = join(dir, 'tool');
      await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await chmod(executable, 0o755);
      await expect(
        probeGcpImageFamilyExecutables({
          packerExecutable: executable,
          scanExecutable: executable,
          cleanRoomExecutable: executable,
          bootstrapAcceptanceExecutable: join(dir, 'missing'),
        }),
      ).resolves.toMatchObject({
        ok: false,
        missing: ['bootstrapAcceptance'],
        executables: { bootstrapAcceptance: null },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checks request/connection project identity before invoking the release executor', async () => {
    await expect(
      executeConfiguredGcpImageFamilyRelease({ projectId: 'other-project' } as never, connection(), {
        acquireAuth: async () => ({ accessToken: 'token', projectId: 'active-alcove-504205-q3' }),
        commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      }),
    ).rejects.toThrow(/does not match/);
  });
});
