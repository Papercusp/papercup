/**
 * P-046 / D-237, D-238: the controller-owned provision bootstrap render.
 *
 * These assert the two properties that make the render TRUSTED rather than merely present — the
 * release comes from validated controller configuration, and the authorized key is the
 * controller's own — plus the fail-closed behaviour that keeps an unconfigured controller from
 * creating an unreachable billing host.
 */
import { createHash } from 'node:crypto';
import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  WORKSPACE_HOST_SHARED_BUILDER_KIND,
  buildWorkspaceHostBuildManifest,
  deriveWorkspaceHostCanonicalArtifactUrls,
  workspaceHostRequiredReleaseMaterialFixtures,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_HOST_MINIMUM_NODE_MAJOR,
  DEFAULT_WORKSPACE_HOST_SERVICE_NAME,
  DEFAULT_WORKSPACE_HOST_SERVICE_PORT,
  WORKSPACE_HOST_PROVISION_ENV,
  WorkspaceHostProvisionBootstrapProfileError,
  renderWorkspaceHostProvisionBootstrap,
  resolveWorkspaceHostControllerAuthorizedKeys,
  resolveWorkspaceHostProvisionBootstrapProfile,
} from './provision-bootstrap';

const MANIFEST_PATH = '/etc/papercusp/workspace-host/manifest.json';
const IDENTITY_FILE = '/var/lib/papercusp/workspace-host/id_ed25519';
const CONTROLLER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIControllerKeyMaterialAAAAAAAAAAAAAA controller';

const SIGNING_PUBLIC_KEY = 'untrusted comment: Papercusp workspace-host release key\nRWQpublickey';
const RELEASE_DIGEST = 'a'.repeat(64);
const CANONICAL_URLS = deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_DIGEST);

/**
 * A genuinely VALID artifact, assembled the way the release gate assembles one.
 *
 * Hand-authoring the manifest would make the happy path pass against a document the real
 * validator would reject, which is the one thing this fixture must not do — the whole point of
 * the module under test is that it accepts only what the release surface accepts.
 */
function artifact(version = '2026.8.22-1'): WorkspaceHostImageArtifact {
  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: 'vm-release',
    source: { repository: 'https://github.com/Papercusp/papercusp.git', revision: '1'.repeat(40) },
    releaseArtifact: {
      name: `papercusp-server-${version}.tgz`,
      version,
      sha256: RELEASE_DIGEST,
      sizeBytes: 42_000,
    },
    baseImage: {
      reference: 'projects/papercusp-images-123/global/images/ubuntu-2404-minimal',
      architecture: 'x86_64',
      sha256: 'c'.repeat(64),
    },
    builder: {
      strategy: 'shared',
      kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      version: '1.14.2',
      templatePath: 'infra/images/workspace-host.pkr.hcl',
      templateSha256: 'd'.repeat(64),
    },
    materials: [
      { path: 'dist/papercusp-server.tgz', sha256: RELEASE_DIGEST, sizeBytes: 42_000 },
      ...workspaceHostRequiredReleaseMaterialFixtures(),
    ],
    parameters: [{ name: 'distribution_profile', value: 'vm-release' }],
    targets: [{ provider: 'gcp', locations: ['us-central1'] }],
  });
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: 'papercusp-workspace-host', version },
    buildManifest,
    release: {
      version,
      bundleUrl: CANONICAL_URLS.bundleUrl,
      bundleSha256: RELEASE_DIGEST,
      signatureUrl: CANONICAL_URLS.signatureUrl,
      signingPublicKey: SIGNING_PUBLIC_KEY,
      signingKeySha256: createHash('sha256').update(SIGNING_PUBLIC_KEY, 'utf8').digest('hex'),
    },
    lifecycle: { state: 'active', publishedAt: '2026-08-22T00:00:00Z' },
    compatibility: [
      {
        provider: 'gcp',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ['install'],
        maximumArtifactAgeDays: 30,
      },
    ],
  };
}

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile]: MANIFEST_PATH,
    [WORKSPACE_HOST_PROVISION_ENV.migrationId]: '1013',
    ...overrides,
  };
}

function reader(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path: string) => {
    const contents = files[path];
    if (contents === undefined) throw new Error(`ENOENT: ${path}`);
    return contents;
  };
}

const CONTROLLER = {
  sshUser: 'papercusp-workspace',
  knownHostsFile: '/var/lib/papercusp/workspace-host/known_hosts',
  remoteEntrypoint: '/usr/local/bin/papercusp-workspace-host-initializer',
  deliveryEntrypoint: '/usr/local/bin/papercusp-workspace-host-credential-delivery',
  identityFile: IDENTITY_FILE,
} as const;

const FILES = {
  [MANIFEST_PATH]: JSON.stringify({ artifact: artifact() }),
  [`${IDENTITY_FILE}.pub`]: `${CONTROLLER_KEY}\n`,
};

describe('workspace-host provision bootstrap profile', () => {
  it('resolves the release from the published manifest and the key from the controller identity', async () => {
    const profile = await resolveWorkspaceHostProvisionBootstrapProfile({
      env: env(),
      readTextFile: reader(FILES),
      controllerProfile: CONTROLLER,
    });

    expect(profile.release.bundleUrl).toBe(CANONICAL_URLS.bundleUrl);
    expect(profile.release.signingPublicKey).toBe(SIGNING_PUBLIC_KEY);
    expect(profile.migrationId).toBe('1013');
    // The key the host will authorize is the public half of the key the controller connects
    // with — one fact, not two settings that can disagree.
    expect(profile.workspaceAuthorizedKeys).toEqual([CONTROLLER_KEY]);
    expect(profile.service).toEqual({
      name: DEFAULT_WORKSPACE_HOST_SERVICE_NAME,
      port: DEFAULT_WORKSPACE_HOST_SERVICE_PORT,
    });
    expect(profile.minimumNodeMajor).toBe(DEFAULT_WORKSPACE_HOST_MINIMUM_NODE_MAJOR);
  });

  it('refuses when the release manifest is unset, relative, missing, or not a valid artifact', async () => {
    const cases: { overrides: Record<string, string | undefined>; files: Record<string, string>; match: RegExp }[] = [
      { overrides: { [WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile]: undefined }, files: FILES, match: /is not set/ },
      {
        overrides: { [WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile]: 'relative/manifest.json' },
        files: FILES,
        match: /must be an absolute path/,
      },
      { overrides: {}, files: { [`${IDENTITY_FILE}.pub`]: CONTROLLER_KEY }, match: /could not be read/ },
      {
        overrides: {},
        files: { ...FILES, [MANIFEST_PATH]: '{ not json' },
        match: /is not valid JSON/,
      },
      {
        overrides: {},
        files: { ...FILES, [MANIFEST_PATH]: JSON.stringify({ artifact: { image: {} } }) },
        match: /not a valid image artifact/,
      },
    ];

    for (const { overrides, files, match } of cases) {
      await expect(
        resolveWorkspaceHostProvisionBootstrapProfile({
          env: env(overrides),
          readTextFile: reader(files),
          controllerProfile: CONTROLLER,
        }),
      ).rejects.toThrow(match);
    }
  });

  it('refuses a controller with no identityFile rather than rendering an empty authorized_keys', async () => {
    // This is D-238 in one assertion: harden-os locks the host to publickey-only for exactly one
    // account, so a render with no key produces a host unreachable by construction — and the
    // bootstrap still attests healthy. Refusing at resolve time is the only place it is cheap.
    const { identityFile: _dropped, ...withoutIdentity } = CONTROLLER;
    await expect(
      resolveWorkspaceHostProvisionBootstrapProfile({
        env: env(),
        readTextFile: reader(FILES),
        controllerProfile: withoutIdentity,
      }),
    ).rejects.toThrow(/no identityFile/);
  });

  it('refuses an unreadable or empty controller public key', async () => {
    await expect(
      resolveWorkspaceHostControllerAuthorizedKeys(CONTROLLER, reader({ [MANIFEST_PATH]: '{}' })),
    ).resolves.toMatchObject({ keys: [], problems: [expect.stringMatching(/could not be read/)] });

    await expect(
      resolveWorkspaceHostControllerAuthorizedKeys(CONTROLLER, reader({ [`${IDENTITY_FILE}.pub`]: '\n# comment\n' })),
    ).resolves.toMatchObject({ keys: [], problems: [expect.stringMatching(/is empty/)] });
  });

  it('reports every gap at once instead of one restart at a time', async () => {
    const error = await resolveWorkspaceHostProvisionBootstrapProfile({
      env: {
        [WORKSPACE_HOST_PROVISION_ENV.servicePort]: 'not-a-port',
      },
      readTextFile: reader({}),
      controllerProfile: CONTROLLER,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceHostProvisionBootstrapProfileError);
    const problems = (error as WorkspaceHostProvisionBootstrapProfileError).problems;
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/RELEASE_MANIFEST is not set/),
        expect.stringMatching(/MIGRATION_ID is not set/),
        expect.stringMatching(/SERVICE_PORT must be a positive integer/),
        expect.stringMatching(/could not be read/),
      ]),
    );
  });

  it('renders an install bootstrap carrying the release pins and the controller key', async () => {
    const profile = await resolveWorkspaceHostProvisionBootstrapProfile({
      env: env(),
      readTextFile: reader(FILES),
      controllerProfile: CONTROLLER,
    });
    const script = renderWorkspaceHostProvisionBootstrap('host-p046-1', profile);

    expect(script).toContain(CANONICAL_URLS.bundleUrl);
    expect(script).toContain(RELEASE_DIGEST);
    // The trust root travels base64-encoded (it is multi-line PEM-ish text), pinned by its
    // digest — assert both halves, since either alone could be present while the other drifted.
    expect(script).toContain(Buffer.from(SIGNING_PUBLIC_KEY, 'utf8').toString('base64'));
    expect(script).toContain(createHash('sha256').update(SIGNING_PUBLIC_KEY, 'utf8').digest('hex'));
    // Also base64: WORKSPACE_AUTHORIZED_KEYS_B64 is decoded into the workspace account's
    // authorized_keys BEFORE harden-os locks sshd to publickey-only (D-238).
    expect(script).toContain(Buffer.from(`${CONTROLLER_KEY}\n`, 'utf8').toString('base64'));
    expect(script).toContain('host-p046-1');
    // Same host + same controller configuration must render the same bytes; a bootstrap that
    // varied per call could not be reasoned about from the configuration alone.
    expect(renderWorkspaceHostProvisionBootstrap('host-p046-1', profile)).toBe(script);
  });
});
