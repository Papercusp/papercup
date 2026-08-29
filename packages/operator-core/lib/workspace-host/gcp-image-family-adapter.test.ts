import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * The repository root, derived from this module's own location rather than process.cwd().
 * Vitest runs this file with the workspace package as cwd, so both the fixture read and
 * the adapter's `repositoryRoot` must be anchored here or the repo-relative template path
 * resolves under packages/operator-core/ and fails with ENOENT.
 */
const REPO_ROOT_URL = new URL('../../../../', import.meta.url);
const REPO_ROOT = fileURLToPath(REPO_ROOT_URL);

/**
 * True when a packer `execute_command` expands `{{ .Vars }}` inside a single-quoted region.
 *
 * Packer renders .Vars ALREADY QUOTED (`KEY='value' KEY2='value2' `), so an outer `'…'` wrapper
 * splices those inner quotes into its own pair and the remote shell re-tokenises the result.
 * Counting quotes rather than matching a known-bad literal keeps the check true for any
 * rewording of the command. See the guard test below for the two failure modes it prevents.
 */
function varsIsNested(executeCommand: string): boolean {
  const varsAt = executeCommand.indexOf('{{ .Vars }}');
  if (varsAt < 0) return false;
  const quotesBefore = (executeCommand.slice(0, varsAt).match(/'/g) ?? []).length;
  return quotesBefore % 2 === 1;
}

import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT,
  WORKSPACE_HOST_SHARED_BUILDER_KIND,
  buildWorkspaceHostBuildManifest,
  buildWorkspaceHostCleanRoomInstallFixture,
  deriveWorkspaceHostCanonicalArtifactUrls,
  workspaceHostCleanRoomFixtureAttestation,
  type WorkspaceHostCleanRoomAcceptanceReport,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';

import {
  GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
  GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION,
  type GcpImageFamilyReleaseContext,
} from './gcp-image-family';
import {
  GoogleComputeGcpImageFamilyReleaseAdapter,
  parseGcpImageFamilyPackerOutput,
  parseGcpImageFamilyProvenance,
  type GcpImageFamilyCleanRoomRunInput,
  type GcpImageFamilyCommandResult,
  type GcpImageFamilyComputeApi,
  type GcpImageFamilyComputeImage,
  type GcpImageFamilyReleaseAdapterOptions,
  type GcpImageFamilyScanRunner,
} from './gcp-image-family-adapter';

const PROJECT = 'papercusp-images-123';
const FAMILY = 'papercusp-workspace-host';
const VERSION = '2026.8.28-1';
const RELEASE_SHA = 'a'.repeat(64);
const BASE_SHA = 'b'.repeat(64);
const SIGNING_PUBLIC_KEY = 'untrusted comment: Papercusp test key\nRWQtestkey';
const SIGNING_KEY_SHA = createHash('sha256').update(SIGNING_PUBLIC_KEY).digest('hex');
const PUBLISHED_AT = '2026-08-28T00:00:00.000Z';
const CANDIDATE_NAME = `papercusp-workspace-host-${VERSION.replaceAll('.', '-')}-candidate`;
const CANDIDATE_ID = `projects/${PROJECT}/global/images/${CANDIDATE_NAME}`;
const IMAGE_NAME = `papercusp-workspace-host-${VERSION.replaceAll('.', '-')}`;
const IMAGE_ID = `projects/${PROJECT}/global/images/${IMAGE_NAME}`;

function artifact(templateSha256: string): WorkspaceHostImageArtifact {
  const manifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: 'vm-release',
    source: { repository: 'https://github.com/Papercusp/papercusp.git', revision: '1'.repeat(40) },
    releaseArtifact: {
      name: `papercusp-server-${VERSION}.tgz`,
      version: VERSION,
      sha256: RELEASE_SHA,
      sizeBytes: 42_000,
    },
    baseImage: { reference: `projects/${PROJECT}/global/images/ubuntu-base`, architecture: 'x86_64', sha256: BASE_SHA },
    builder: {
      strategy: 'shared',
      kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      version: '1.14.2',
      templatePath: 'infra/images/workspace-host.pkr.hcl',
      templateSha256,
    },
    materials: [
      { path: 'dist/papercusp-server.tgz', sha256: RELEASE_SHA, sizeBytes: 42_000 },
      {
        path: WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT,
        sha256: 'c'.repeat(64),
        sizeBytes: 2_048,
        executable: true,
      },
    ],
    parameters: [{ name: 'distribution_profile', value: 'vm-release' }],
    targets: [{ provider: 'gcp', locations: [PROJECT] }],
  });
  const urls = deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_SHA);
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: IMAGE_ID, version: VERSION },
    buildManifest: manifest,
    release: {
      version: VERSION,
      bundleUrl: urls.bundleUrl,
      bundleSha256: RELEASE_SHA,
      signatureUrl: urls.signatureUrl,
      signingPublicKey: SIGNING_PUBLIC_KEY,
      signingKeySha256: SIGNING_KEY_SHA,
    },
    lifecycle: { state: 'active', publishedAt: PUBLISHED_AT },
    compatibility: [
      {
        provider: 'gcp',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ['install', 'upgrade', 'rollback'],
        maximumArtifactAgeDays: 30,
      },
    ],
  };
}

function provenance(sourceCandidateImageId?: string): string {
  return JSON.stringify({
    contractVersion: GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION,
    buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
    releaseVersion: VERSION,
    releaseSha256: RELEASE_SHA,
    architecture: 'x86_64',
    guestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.map((name) => ({ name, version: '1.0' })),
    ...(sourceCandidateImageId ? { sourceCandidateImageId } : {}),
  });
}

const TEMPLATE_SHA = '0'.repeat(64);
const CONTEXT_ARTIFACT = artifact(TEMPLATE_SHA);
const CONTEXT_FIXTURE = buildWorkspaceHostCleanRoomInstallFixture(CONTEXT_ARTIFACT, {
  fixtureId: 'adapter-test-fixture',
  action: 'install',
  provider: 'gcp',
  architecture: 'x86_64',
  observedAt: PUBLISHED_AT,
  hostId: 'adapter-test-host',
  migrationId: 'migration-1',
  minimumNodeMajor: 22,
  service: { name: 'papercusp-workspace', port: 3070 },
});
const CONTEXT_ATTESTATION = workspaceHostCleanRoomFixtureAttestation(CONTEXT_FIXTURE, '2026-08-28T00:01:00.000Z');
const CONTEXT: GcpImageFamilyReleaseContext = {
  artifact: CONTEXT_ARTIFACT,
  request: {
    releaseGate: {
      artifact: CONTEXT_ARTIFACT,
      trustReport: {} as never,
      compatibilityRequest: {
        action: 'install',
        provider: 'gcp',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        observedAt: PUBLISHED_AT,
      },
      cleanRoomReport: {
        contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
        fixtureId: CONTEXT_FIXTURE.fixtureId,
        image: CONTEXT_ARTIFACT.image,
        passed: true,
        checks: [
          'artifact-identity',
          'compatibility-matrix',
          'deterministic-bootstrap-fixture',
          'exact-bootstrap-attestation',
        ],
        issues: [],
        bootstrapScriptSha256: CONTEXT_FIXTURE.bootstrapScriptSha256,
        attestation: CONTEXT_ATTESTATION,
      } satisfies WorkspaceHostCleanRoomAcceptanceReport,
    },
    projectId: PROJECT,
    family: FAMILY,
    publishedAt: PUBLISHED_AT,
    cleanRoom: {
      zone: 'us-central1-a',
      serviceAccountEmail: `workspace-host@${PROJECT}.iam.gserviceaccount.com`,
      subnetwork: `projects/${PROJECT}/regions/us-central1/subnetworks/clean-room`,
    },
  },
};

class ComputeFake implements GcpImageFamilyComputeApi {
  readonly images = new Map<string, GcpImageFamilyComputeImage>();
  readonly inserts: Array<{
    projectId: string;
    input: Parameters<NonNullable<GcpImageFamilyComputeApi['insertImage']>>[1];
  }> = [];
  readonly deprecations: unknown[] = [];
  familyImage?: GcpImageFamilyComputeImage;

  async getImage(_projectId: string, imageName: string): Promise<GcpImageFamilyComputeImage | undefined> {
    return this.images.get(imageName);
  }

  async getFamilyImage(): Promise<GcpImageFamilyComputeImage | undefined> {
    return this.familyImage;
  }

  async insertImage(projectId: string, input: Parameters<NonNullable<GcpImageFamilyComputeApi['insertImage']>>[1]) {
    this.inserts.push({ projectId, input });
    const image: GcpImageFamilyComputeImage = {
      name: input.name,
      family: input.family,
      description: input.description,
      labels: input.labels,
      architecture: 'X86_64',
      state: 'ACTIVE',
    };
    this.images.set(input.name, image);
    this.familyImage = image;
    return image;
  }

  async deprecateImage(input: unknown): Promise<void> {
    this.deprecations.push(input);
  }
}

function baseOptions(
  compute: ComputeFake,
  overrides: Partial<GcpImageFamilyReleaseAdapterOptions> = {},
): GcpImageFamilyReleaseAdapterOptions {
  return {
    compute,
    guestToolVersions: Object.fromEntries(GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.map((name) => [name, '1.0'])),
    ...overrides,
  };
}

describe('GCP image-family production adapter', () => {
  it('parses machine-readable Packer output and rejects malformed provenance', () => {
    expect(
      parseGcpImageFamilyPackerOutput(`artifact,0,id,gce,${PROJECT}/${CANDIDATE_NAME}\n`, PROJECT, CANDIDATE_NAME),
    ).toBe(CANDIDATE_ID);
    expect(parseGcpImageFamilyProvenance(provenance())).toMatchObject({
      contractVersion: GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION,
      releaseVersion: VERSION,
    });
    expect(() => parseGcpImageFamilyProvenance('{}')).toThrow('contract');
  });

  it('pins the template, runs Packer without a shell, scans real evidence, and inspects the candidate', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL));
    const templateHash = createHash('sha256').update(template).digest('hex');
    const candidateArtifact = artifact(templateHash);
    const context = {
      ...CONTEXT,
      artifact: candidateArtifact,
      request: { ...CONTEXT.request, releaseGate: { ...CONTEXT.request.releaseGate, artifact: candidateArtifact } },
    };
    const compute = new ComputeFake();
    compute.images.set(CANDIDATE_NAME, {
      name: CANDIDATE_NAME,
      description: provenance(),
      architecture: 'X86_64',
      state: 'ACTIVE',
    });
    const calls: Array<{ command: string; args: readonly string[]; options?: unknown }> = [];
    const commandRunner = {
      run: vi.fn(
        async (command: string, args: readonly string[], options?: unknown): Promise<GcpImageFamilyCommandResult> => {
          calls.push({ command, args, options });
          return {
            exitCode: 0,
            stdout: args[0] === 'build' ? `artifact,0,id,gce,${PROJECT}/${CANDIDATE_NAME}` : '',
            stderr: '',
          };
        },
      ),
    };
    const scanRunner: GcpImageFamilyScanRunner = {
      run: async (input) => ({
        imageId: input.imageId,
        buildManifestIdentity: input.buildManifestIdentity,
        releaseSha256: input.releaseSha256,
        trusted: true,
        sbomSha256: 'd'.repeat(64),
        // A realistic scanner result carries sub-threshold findings plus the
        // breakdown that accounts for them. Zero here would let this path pass
        // without ever exercising the severity policy the adapter now applies.
        vulnerabilityFindings: 3,
        vulnerabilityBySeverity: { Low: 2, Negligible: 1 },
        secretFindings: 0,
        evidenceRef: 'gcp://scan/evidence-1',
      }),
    };
    const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(compute, {
        repositoryRoot: REPO_ROOT,
        commandRunner,
        scanRunner,
      }),
    );
    await adapter.bindReleaseContext(context);
    const built = await adapter.buildCandidate({
      projectId: PROJECT,
      candidateImageName: CANDIDATE_NAME,
      templatePath: 'infra/images/workspace-host.pkr.hcl',
      buildManifestIdentity: candidateArtifact.buildManifest.manifestIdentity,
      releaseVersion: VERSION,
      releaseSha256: RELEASE_SHA,
      architecture: 'x86_64',
      requiredGuestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
    });
    expect(built.imageId).toBe(CANDIDATE_ID);
    // `validate` sits between init and build ON PURPOSE — it evaluates the template with the
    // real variables, so an unknown function or a false validation condition fails here in a
    // second instead of after a builder VM has been created. See the buildCandidate comment.
    expect(calls.map((call) => call.args[0])).toEqual(['init', 'validate', 'build']);
    const validateCall = calls[1];
    const buildCall = calls[2];
    expect(buildCall?.args).not.toContain('--shell');
    // The evaluation is worthless unless it evaluates the SAME variables the build uses: a
    // validate run with different (or no) vars can pass while the build it is guarding fails.
    const varsOf = (args: readonly string[] | undefined): string[] =>
      (args ?? []).filter((_, index) => args?.[index - 1] === '-var');
    expect(varsOf(validateCall?.args)).toEqual(varsOf(buildCall?.args));
    expect(varsOf(validateCall?.args).length).toBeGreaterThan(0);
    const scan = await adapter.scanImage({
      projectId: PROJECT,
      imageId: CANDIDATE_ID,
      buildManifestIdentity: candidateArtifact.buildManifest.manifestIdentity,
      releaseSha256: RELEASE_SHA,
    });
    expect(scan.trusted).toBe(true);
    expect(await adapter.inspectImage(PROJECT, CANDIDATE_ID)).toMatchObject({
      imageId: CANDIDATE_ID,
      state: 'ACTIVE',
      architecture: 'x86_64',
    });
  });

  /**
   * Recurrence guard for EI-21762126059344308.
   *
   * `packer build` runs with `-machine-readable`, and in that mode packer writes its ENTIRE
   * event stream — `ui,error` records included — to STDOUT, leaving stderr empty. assertSuccess
   * used to quote stderr only, so a failed production release reported exactly
   * `packer build failed with exit code 1` and nothing else. That is the dangerous shape: not
   * a truncated-looking message, but a confident one, indistinguishable from a command that
   * genuinely had nothing to say. It cost a billable build and a wake to re-derive.
   *
   * The stdout-only case is therefore the one asserted here; a stderr-only failure would have
   * passed against the BROKEN code too, so a test of that direction alone proves nothing.
   */
  it('surfaces a failure diagnostic written only to stdout, and says so explicitly when there is none', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL));
    const candidateArtifact = artifact(createHash('sha256').update(template).digest('hex'));
    const context = {
      ...CONTEXT,
      artifact: candidateArtifact,
      request: { ...CONTEXT.request, releaseGate: { ...CONTEXT.request.releaseGate, artifact: candidateArtifact } },
    };
    const PACKER_STDOUT_ERROR =
      '1787980033,,ui,error,Error: Call to unknown function\\n\\n  on ' +
      'infra/images/workspace-host.pkr.hcl line 216:\\n\\nThere is no function named "setsubtract".';

    const buildCandidate = async (
      run: (command: string, args: readonly string[]) => Promise<GcpImageFamilyCommandResult>,
    ): Promise<unknown> => {
      const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
        baseOptions(new ComputeFake(), { repositoryRoot: REPO_ROOT, commandRunner: { run } }),
      );
      await adapter.bindReleaseContext(context);
      return adapter.buildCandidate({
        projectId: PROJECT,
        candidateImageName: CANDIDATE_NAME,
        templatePath: 'infra/images/workspace-host.pkr.hcl',
        buildManifestIdentity: candidateArtifact.buildManifest.manifestIdentity,
        releaseVersion: VERSION,
        releaseSha256: RELEASE_SHA,
        architecture: 'x86_64',
        requiredGuestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
      });
    };

    // Stdout-only failure: the diagnostic MUST reach the thrown error.
    await expect(
      buildCandidate(async (_command, args) =>
        args[0] === 'init'
          ? { exitCode: 0, stdout: '', stderr: '' }
          : { exitCode: 1, stdout: PACKER_STDOUT_ERROR, stderr: '' },
      ),
    ).rejects.toThrow(/setsubtract/);

    // A genuinely silent failure must SAY it was silent, so "no diagnostic" stays
    // distinguishable from "the diagnostic was dropped" — the ambiguity that caused the bug.
    await expect(
      buildCandidate(async (_command, args) =>
        args[0] === 'init' ? { exitCode: 0, stdout: '', stderr: '' } : { exitCode: 1, stdout: '', stderr: '' },
      ),
    ).rejects.toThrow(/produced no output on either stream/);
  });

  /**
   * Recurrence guard for EI-21763610698235066.
   *
   * The builder was handed the fully-qualified `projects/<p>/global/images/<n>` reference, which
   * googlecompute forwards as the Compute API `image` field — and that field takes a BARE NAME:
   *   Error 400: Invalid value for field 'image': '...'. Must be a match of regex
   *   '[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?|[1-9][0-9]{0,19}', invalid
   *
   * This guard is TEXTUAL by necessity, and that is the interesting part. It cannot be written as
   * a behavioural test because nothing local can tell the two spellings apart: the release gate
   * accepts the manifest either way (a fully-qualified immutable id is exactly what it demands),
   * and `packer validate` — including the real-variable evaluation this file also guards — reports
   * `The configuration is valid.` for BOTH, because either value is a legal string in a field
   * typed as a string. The fault is an API contract, so it is only observable against the live
   * API, after a builder VM exists. Pinning the template text is the only check that costs
   * nothing.
   *
   * Both directions are asserted on purpose. The builder must NOT get the qualified reference,
   * AND the variable must still REQUIRE it: "fix" the first by loosening the variable to a bare
   * name and the build would work while silently discarding the immutable-base-image provenance
   * that baseImage.reference exists to carry, with family aliases waved through.
   */
  it('gives the googlecompute builder a bare image name plus a separate project id, while still requiring a fully-qualified reference', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL), 'utf8');
    const blockStart = template.indexOf('source "googlecompute"');
    expect(blockStart).toBeGreaterThan(-1);
    const builderBlock = template.slice(blockStart, template.indexOf('\n}\n', blockStart));

    // The exact defect: the qualified reference passed straight through to the builder.
    expect(builderBlock).not.toMatch(/^\s*source_image\s*=\s*var\.source_image\s*$/m);
    // Decomposed instead — name in source_image, project in its own field.
    expect(builderBlock).toMatch(/^\s*source_image\s*=\s*split\(/m);
    expect(builderBlock).toMatch(/^\s*source_image_project_id\s*=/m);

    // …and the variable itself still refuses anything but an immutable, fully-qualified id.
    expect(template).toMatch(/\^projects\/\[\^\/\]\+\/global\/images\/\[\^\/\]\+\$/);
  });

  /**
   * Recurrence guard for the dash/bash split (P-046, 2026-08-29).
   *
   * Every inline provisioner in this template opens with `set -Eeuo pipefail`, which is bash-only.
   * Packer's default `inline_shebang` is `/bin/sh` — dash on Ubuntu — so a shell provisioner that
   * does not override the interpreter dies on its FIRST line with
   *   /tmp/script_1326.sh: 2: set: Illegal option -o pipefail
   *
   * One of the seven blocks was missing its `execute_command`, and that is precisely why it
   * survived review: the other six set it, so the file reads as though a single shell is in use
   * throughout, and the odd one out is invisible unless you check every block. A per-block
   * invariant is cheap; noticing an absence in a uniform-looking list is not.
   *
   * The check is per-block rather than a count comparison on purpose — equal totals can be
   * reached with one block missing the setting and another carrying it twice.
   */
  it('runs every shell provisioner under bash, since they all use bash-only pipefail', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL), 'utf8');
    const blocks = template.split(/provisioner\s+"shell"\s*\{/).slice(1);
    expect(blocks.length).toBeGreaterThan(0);

    for (const [index, rest] of blocks.entries()) {
      // Bound each block at the start of the next provisioner so the search cannot run past it.
      const block = rest.split(/\n\s{0,2}provisioner\s+"/)[0] ?? '';
      const usesBashOnlySyntax = /set\s+-[A-Za-z]*o\s+pipefail|set\s+-[A-Za-z]*u[A-Za-z]*\s/.test(block);
      if (!usesBashOnlySyntax) continue;
      expect(
        /execute_command\s*=\s*"[^"]*\bbash\b/.test(block) || /inline_shebang\s*=\s*"[^"]*\bbash\b/.test(block),
        `shell provisioner #${String(index + 1)} uses bash-only syntax but does not force a bash interpreter, ` +
          'so packer will run it under /bin/sh (dash) and it will die on `set -o pipefail`',
      ).toBe(true);
    }
  });

  /**
   * Recurrence guard for the silent env-var truncation (P-046, 2026-08-29).
   *
   * Packer renders `{{ .Vars }}` ALREADY QUOTED — literally `KEY='value' KEY2='value2' `. So
   * nesting it inside another single-quoted string, as `sudo -E bash -c '{{ .Vars }} {{ .Path }}'`
   * does, splices those inner quotes into the outer pair and lets the remote shell re-tokenise
   * the result. What makes this worth a permanent guard is HOW it fails:
   *
   *   - a value containing a SPACE truncates the command at the first unquoted space, so
   *     `bash -c` receives only variable assignments. The script never runs and the exit code
   *     is 0. The build goes green having installed nothing.
   *   - a value containing a NEWLINE feeds line 2 to the shell as a command (exit 127).
   *
   * The first is the dangerous one: six builds died before ever reaching that provisioner, and
   * when one finally did, its success was indistinguishable from a real one. An image would
   * have shipped without its pinned guest tools AND without the version assertion that exists
   * to catch exactly that — while its provenance claimed both.
   *
   * The check counts quotes rather than pattern-matching a known-bad string, so it holds for
   * any rewording of the command; the correct shape puts `{{ .Vars }}` outside all quoting.
   */
  it('never nests packer-quoted {{ .Vars }} inside a quoted execute_command', async () => {
    // Controls first: a predicate that has never rejected anything is not known to reject the
    // real defect either, and this one is cheap to falsify permanently rather than by a one-off
    // probe against a mutated tree.
    expect(varsIsNested(`sudo -E bash -c '{{ .Vars }} {{ .Path }}'`), 'the exact P-046 defect').toBe(true);
    expect(varsIsNested(`sudo -E sh -c '{{ .Vars }} {{ .Path }}'`), 'the defect, reworded').toBe(true);
    expect(varsIsNested(`{{ .Vars }} sudo -E bash '{{ .Path }}'`), 'the corrected form').toBe(false);
    expect(varsIsNested(`chmod +x {{ .Path }}; {{ .Vars }} {{ .Path }}`), "packer's own default").toBe(false);

    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL), 'utf8');
    const blocks = template.split(/provisioner\s+"shell"\s*\{/).slice(1);
    expect(blocks.length).toBeGreaterThan(0);

    let checked = 0;
    for (const [index, rest] of blocks.entries()) {
      const block = rest.split(/\n\s{0,2}provisioner\s+"/)[0] ?? '';
      const command = /execute_command\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1];
      if (command === undefined || !command.includes('{{ .Vars }}')) continue;
      checked += 1;

      expect(
        varsIsNested(command),
        `shell provisioner #${String(index + 1)} expands {{ .Vars }} inside a single-quoted region ` +
          `(execute_command = "${command}"). Packer emits .Vars pre-quoted, so nesting it truncates ` +
          'any value containing a space — the script then never runs and still exits 0.',
      ).toBe(false);
    }

    // A guard that silently checked nothing is the exact failure mode this test is about.
    expect(checked, 'no execute_command referenced {{ .Vars }} — the guard measured nothing').toBeGreaterThan(0);
  });

  /**
   * Recurrence guard for WI-662195.
   *
   * Workspace-host images are templates, so SSH server host keys must be removed before
   * publication. The next boot regenerates them, while retaining them in the image makes
   * every cloned host present the same server identity. Match the actual inline command,
   * not the explanatory comment above it, so deleting the cleanup cannot leave a green test.
   */
  it('removes SSH server host keys from the final image-cleanup provisioner', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL), 'utf8');
    const blocks = template.split(/provisioner\s+"shell"\s*\{/).slice(1);
    expect(blocks.length, 'no shell provisioners found — the guard measured nothing').toBeGreaterThan(0);

    const finalCleanupBlock = blocks.at(-1)?.split(/\n\s{0,2}provisioner\s+"/)[0] ?? '';
    expect(
      finalCleanupBlock,
      'the final image-cleanup provisioner must remove build-specific SSH server host keys',
    ).toMatch(/^\s*"rm -f \/etc\/ssh\/ssh_host_\*",\s*$/m);
  });

  it('canonicalises the signing key before hashing it, instead of trusting transport to preserve bytes', async () => {
    // Writes a value straight out of the environment with no trailing-newline normalisation.
    const writesRawEnvValue = (line: string): boolean =>
      /printf\s+'%s'\s+\\?"\$SIGNING_PUBLIC_KEY\\?"\s*>/.test(line);
    // Strips all trailing newlines via $(...) and appends exactly one.
    const canonicalises = (line: string): boolean =>
      /printf\s+'%s\\+n'\s+\\?"\$\(printf\s+'%s'\s+\\?"\$SIGNING_PUBLIC_KEY\\?"\)\\?"/.test(line);

    // Controls, so a guard that can never reject anything cannot pass as protection.
    expect(
      writesRawEnvValue(`printf '%s' \\"$SIGNING_PUBLIC_KEY\\" > \\"$PUBLIC_KEY_PATH\\"`),
      'the exact r18c defect',
    ).toBe(true);
    expect(
      canonicalises(`printf '%s\\\\n' \\"$(printf '%s' \\"$SIGNING_PUBLIC_KEY\\")\\" > \\"$PUBLIC_KEY_PATH\\"`),
      'the corrected form',
    ).toBe(true);

    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL), 'utf8');
    const writes = template
      .split('\n')
      .filter((line) => line.includes('$SIGNING_PUBLIC_KEY') && line.includes('>'));

    expect(writes.length, 'no line writes the signing key — the guard measured nothing').toBeGreaterThan(0);
    for (const line of writes) {
      expect(
        writesRawEnvValue(line),
        'the signing key is written straight from the environment. Packer\'s {{ .Vars }} transport ' +
          'strips the trailing newline of a multi-line value, so the file lands one byte short and ' +
          'fails its digest check (measured: 113 bytes, expected 114). Canonicalise it instead.',
      ).toBe(false);
      expect(canonicalises(line), 'the signing key write must normalise to exactly one trailing newline').toBe(true);
    }
  });

  /**
   * A scan failure must arrive WITH its diagnosis, not just an exit code.
   *
   * Measured on P-046 (2026-08-29): the r18d release finally cleared the packer build — the
   * expensive part — and then died with exactly `GCP image scanner failed with exit code 1`
   * and nothing else. Both of the scanner's streams had been captured by the command runner
   * and then discarded by a hand-rolled exit check, so the only way to learn WHY was to spend
   * another full billable image build. That is the same defect, in the same file, that had
   * already cost three builds on the packer path hours earlier; the packer path was fixed by
   * routing through assertSuccess and this path was left behind.
   *
   * The guard therefore asserts the two properties that make a failure diagnosable — the
   * complete output is spilled to a named file, and BOTH streams reach it — rather than
   * asserting any particular wording, which would just re-freeze today's message.
   */
  it('spills the scanner and clean-room diagnosis instead of reporting a bare exit code', async () => {
    // Distinctive per-stream sentinels. A failure handler that keeps only the stream you
    // EXPECT the error on is precisely how the packer diagnosis vanished
    // (EI-21762126059344308), so each stream is checked for by name.
    const failing = (stdoutMark: string, stderrMark: string) => ({
      run: async () => ({ exitCode: 3, stdout: stdoutMark, stderr: stderrMark }),
    });

    const assertDiagnosable = async (message: string | null, stdoutMark: string, stderrMark: string) => {
      // Control: the call really did fail. Without this, a mistake below would pass
      // vacuously against a call that unexpectedly SUCCEEDED.
      expect(message).not.toBeNull();
      const text = message as string;

      // The exit code alone is what the old message carried — necessary, nowhere near enough.
      expect(text).toContain('exit code 3');

      // The property that actually matters: a named file holding the COMPLETE output.
      const spillMatch = text.match(/\[full output: ([^\]]+)\]/);
      expect(spillMatch).not.toBeNull();

      const spilled = await readFile((spillMatch as RegExpMatchArray)[1], 'utf8');
      // BOTH streams, not just the one a reader would guess the error went to.
      expect(spilled).toContain(stdoutMark);
      expect(spilled).toContain(stderrMark);
    };

    const capture = async (work: Promise<unknown>): Promise<string | null> =>
      work.then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

    const scanAdapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(new ComputeFake(), { commandRunner: failing('SENTINEL_OUT_SCAN_9f2a', 'SENTINEL_ERR_SCAN_7c4b') }),
    );
    await scanAdapter.bindReleaseContext(CONTEXT);
    await assertDiagnosable(
      await capture(
        scanAdapter.scanImage({
          projectId: PROJECT,
          imageId: CANDIDATE_ID,
          buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
          releaseSha256: RELEASE_SHA,
        }),
      ),
      'SENTINEL_OUT_SCAN_9f2a',
      'SENTINEL_ERR_SCAN_7c4b',
    );

    const cleanAdapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(new ComputeFake(), {
        commandRunner: failing('SENTINEL_OUT_CLEAN_3d1e', 'SENTINEL_ERR_CLEAN_5b8f'),
      }),
    );
    await cleanAdapter.bindReleaseContext(CONTEXT);
    await assertDiagnosable(
      await capture(
        cleanAdapter.launchCleanRoomCanary({
          projectId: PROJECT,
          zone: 'us-central1-a',
          serviceAccountEmail: CONTEXT.request.cleanRoom.serviceAccountEmail,
          subnetwork: CONTEXT.request.cleanRoom.subnetwork,
          imageId: CANDIDATE_ID,
          buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
          releaseVersion: VERSION,
          releaseSha256: RELEASE_SHA,
        }),
      ),
      'SENTINEL_OUT_CLEAN_3d1e',
      'SENTINEL_ERR_CLEAN_5b8f',
    );
  });

  it('fails closed when scanner or clean-room evidence is missing or mismatched', async () => {
    const compute = new ComputeFake();
    const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(compute, {
        commandRunner: { run: async () => ({ exitCode: 127, stdout: '', stderr: 'scanner missing' }) },
      }),
    );
    await adapter.bindReleaseContext(CONTEXT);
    await expect(
      adapter.scanImage({
        projectId: PROJECT,
        imageId: CANDIDATE_ID,
        buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
        releaseSha256: RELEASE_SHA,
      }),
    ).rejects.toThrow('scanner failed');
    const cleanRunner = {
      run: async (input: GcpImageFamilyCleanRoomRunInput) => ({
        evidenceRef: 'gcp://clean-room/evidence-1',
        projectId: input.projectId,
        zone: input.zone,
        imageId: input.imageId,
        buildManifestIdentity: input.buildManifestIdentity,
        computeRunning: true,
        osLoginReady: true,
        publicIpv4Assigned: false,
        attestation: workspaceHostCleanRoomFixtureAttestation(input.fixture, '2026-08-28T00:02:00.000Z'),
        terminated: true,
        residualResourceIds: [],
        observedAt: '2026-08-28T00:02:00.000Z',
        fixtureId: input.fixture.fixtureId,
        bootstrapScriptSha256: input.fixture.bootstrapScriptSha256,
      }),
    };
    const cleanAdapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(compute, { cleanRoomRunner: cleanRunner }),
    );
    await cleanAdapter.bindReleaseContext(CONTEXT);
    const proof = await cleanAdapter.launchCleanRoomCanary({
      projectId: PROJECT,
      zone: 'us-central1-a',
      serviceAccountEmail: CONTEXT.request.cleanRoom.serviceAccountEmail,
      subnetwork: CONTEXT.request.cleanRoom.subnetwork,
      imageId: CANDIDATE_ID,
      buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
      releaseVersion: VERSION,
      releaseSha256: RELEASE_SHA,
    });
    expect(proof.terminated).toBe(true);
    const badRunner = {
      run: async (input: GcpImageFamilyCleanRoomRunInput) => ({ ...(await cleanRunner.run(input)), imageId: IMAGE_ID }),
    };
    const badAdapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(compute, { cleanRoomRunner: badRunner }),
    );
    await badAdapter.bindReleaseContext(CONTEXT);
    await expect(
      badAdapter.launchCleanRoomCanary({
        projectId: PROJECT,
        zone: 'us-central1-a',
        serviceAccountEmail: CONTEXT.request.cleanRoom.serviceAccountEmail,
        subnetwork: CONTEXT.request.cleanRoom.subnetwork,
        imageId: CANDIDATE_ID,
        buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
        releaseVersion: VERSION,
        releaseSha256: RELEASE_SHA,
      }),
    ).rejects.toThrow('not bound');
  });

  it('publishes an exact family member, resolves it, and deprecates by immutable replacement', async () => {
    const compute = new ComputeFake();
    const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(baseOptions(compute));
    await adapter.bindReleaseContext(CONTEXT);
    const published = await adapter.publishFamilyVersion({
      projectId: PROJECT,
      family: FAMILY,
      imageName: IMAGE_NAME,
      sourceCandidateImageId: CANDIDATE_ID,
      buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
      releaseVersion: VERSION,
      releaseSha256: RELEASE_SHA,
    });
    expect(published).toEqual({
      projectId: PROJECT,
      family: FAMILY,
      imageId: IMAGE_ID,
      version: VERSION,
      sourceCandidateImageId: CANDIDATE_ID,
    });
    expect((await adapter.resolveFamily(PROJECT, FAMILY)).imageId).toBe(IMAGE_ID);
    await adapter.deprecateImage({
      projectId: PROJECT,
      imageId: IMAGE_ID,
      replacementImageId: CANDIDATE_ID,
      state: 'DEPRECATED',
    });
    expect(compute.deprecations).toHaveLength(1);
    expect(compute.inserts[0]?.input.sourceImage).toBe(CANDIDATE_ID);
  });
});
