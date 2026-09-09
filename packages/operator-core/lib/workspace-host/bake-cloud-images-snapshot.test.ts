/**
 * Regression guard for EI-22355025813361885.
 *
 * Bash reads compound commands lazily. An in-place rewrite of the bake entrypoint
 * during a long build can therefore splice a later function body into the running
 * interpreter even when the source parsed cleanly at launch. The real entrypoint
 * now copies + syntax-checks itself and re-execs the copy before setup. This test
 * runs the real (non-dry-run) control flow against a temporary fake toolchain,
 * rewrites the later `bake_one` function while the fake build is still sleeping,
 * and proves the guarded run completes from its startup snapshot. A permanent
 * pre-fix control keeps the behavioral assertion falsifiable without mutating the
 * shared checkout.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorkspaceHostBootcBakeManifest, workspaceHostBootcCloudArtifact } from './bootc-bake-manifest';

const ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(ROOT, 'infra/images/bootc/bake-cloud-images.sh');
const HEALTH = join(ROOT, 'infra/images/bootc/p307-build-health.sh');
const CONTAINERFILE = join(ROOT, 'infra/images/bootc/workspace-host.Containerfile');
const HOST_PREPARE = join(ROOT, 'infra/images/bootc/papercusp-host-prepare.sh');
const GOOGLE_OSLOGIN_TMPFILES = join(ROOT, 'infra/images/bootc/papercusp-google-oslogin.conf');
const IMAGE_BUILD_PROBE = join(ROOT, 'infra/images/bootc/p306-image-build-probe.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');
const CONTAINERFILE_SOURCE = readFileSync(CONTAINERFILE, 'utf8');
const HOST_PREPARE_SOURCE = readFileSync(HOST_PREPARE, 'utf8');
const GOOGLE_OSLOGIN_TMPFILES_SOURCE = readFileSync(GOOGLE_OSLOGIN_TMPFILES, 'utf8');
const IMAGE_BUILD_PROBE_SOURCE = readFileSync(IMAGE_BUILD_PROBE, 'utf8');
const SNAPSHOT_MARKER = '# EI-22355025813361885 — freeze the entrypoint';

function withoutSnapshotGuard(): string {
  const start = SOURCE.indexOf(SNAPSHOT_MARKER);
  const end = SOURCE.indexOf('set -uo pipefail\n', start);
  expect(start, 'snapshot guard marker must be present in the shipped script').toBeGreaterThan(-1);
  expect(end, 'snapshot guard must precede set -uo pipefail').toBeGreaterThan(start);
  return SOURCE.slice(0, start) + SOURCE.slice(end);
}

function runFixture(
  script: string,
  render: 'raw' | 'archive' | 'empty' | 'stale' = 'raw',
  release?: { root?: string; version?: string },
  sourceImage?: { ref: string; exists?: boolean },
  inhibitFails = false,
): {
  status: number;
  output: string;
  files: string[];
  outFiles: string[];
  manifest: unknown;
  buildArgs: string[];
  podmanCalls: string[];
  inhibitCalls: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'ei-223550-bake-'));
  const source = join(dir, 'bake-cloud-images.sh');
  const health = join(dir, 'p307-build-health.sh');
  const bin = join(dir, 'bin');
  const out = join(dir, 'out');
  const mutationMarker = join(dir, 'source-mutated');
  const buildMarker = join(dir, 'build-started');
  const supplyChainMarker = join(dir, 'supply-chain-ran');
  const buildArgsPath = join(dir, 'build-args');
  const podmanCallsPath = join(dir, 'podman-calls');
  const inhibitCallsPath = join(dir, 'udisks2-inhibit-calls');
  const inhibitLock = join(dir, 'udisks2-inhibit.lock');
  const key = join(dir, 'release.key');
  const pubkey = join(dir, 'release.pub');
  const releaseRoot = release?.root ?? join(dir, 'release-root');

  mkdirSync(bin, { recursive: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(releaseRoot, { recursive: true });
  writeFileSync(join(releaseRoot, 'serve.mjs'), 'fixture release\n');
  if (render === 'stale') {
    mkdirSync(join(out, 'gcp', 'image'), { recursive: true });
    writeFileSync(join(out, 'gcp', 'image', 'disk.raw'), 'previous run');
  }
  writeFileSync(source, script, { mode: 0o755 });
  copyFileSync(HEALTH, health);
  chmodSync(source, 0o755);
  chmodSync(health, 0o755);
  writeFileSync(key, 'temporary private key\n');
  writeFileSync(pubkey, 'temporary public key\n');

  // The build stub deliberately rewrites the later bake_one function while the
  // parent shell is waiting. Rewrite the existing inode rather than replacing
  // it, matching the real editor hazard without touching the shared checkout.
  writeFileSync(join(bin, 'podman'), `#!/usr/bin/env bash
set -euo pipefail
subcommand="\${1:-}"
shift || true
printf '%s\\n' "$subcommand $*" >> "$BAKE_TEST_PODMAN_CALLS"

case "$subcommand" in
  info)
    printf 'overlay\\n'
    ;;
  build)
    : > "$BAKE_TEST_BUILD_MARKER"
    printf '%s\\n' "$@" > "$BAKE_TEST_BUILD_ARGS"
    sleep 0.15
    mutation_tmp="$(mktemp "$BAKE_TEST_SOURCE.XXXXXX")"
    sed '/^bake_one() {/a if (' "$BAKE_TEST_SOURCE" > "$mutation_tmp"
    cat "$mutation_tmp" > "$BAKE_TEST_SOURCE"
    rm -f "$mutation_tmp"
    : > "$BAKE_TEST_MUTATION_MARKER"
    sleep 0.15
    ;;
  push|pull)
    ;;
  image)
    [ "\${1:-}" = "exists" ]
    if [ "\${2:-}" = "$BAKE_TEST_SOURCE_IMAGE" ] && [ "$BAKE_TEST_SOURCE_EXISTS" != "1" ]; then
      exit 1
    fi
    ;;
  tag)
    ;;
  run)
    is_skopeo=0
    output_dir=""
    for arg in "$@"; do
      [ "$arg" = "skopeo" ] && is_skopeo=1
    done
    if [ "$is_skopeo" -eq 1 ]; then
      printf 'sha256:%064d\\n' 1
      exit 0
    fi
    previous=""
    for arg in "$@"; do
      if [ "$previous" = "-v" ]; then
        output_dir="\${arg%%:/output}"
        break
      fi
      previous="$arg"
    done
    [ -n "$output_dir" ]
    case "$BAKE_TEST_RENDER" in
      archive)
        mkdir -p "$output_dir/gce" "$output_dir/input"
        printf 'fake rendered disk\\n' > "$output_dir/input/disk.raw"
        tar -czf "$output_dir/gce/image.tar.gz" -C "$output_dir/input" disk.raw
        ;;
      empty|stale) ;;
      *)
        mkdir -p "$output_dir/image"
        printf 'fake rendered disk\\n' > "$output_dir/image/disk.raw"
        ;;
    esac
    ;;
  *)
    printf 'unexpected fake podman subcommand: %s\\n' "$subcommand" >&2
    exit 1
    ;;
esac
`, { mode: 0o755 });
  chmodSync(join(bin, 'podman'), 0o755);
  writeFileSync(join(bin, 'sudo'), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-n" ]; then shift; fi
exec "$@"
`, { mode: 0o755 });
  chmodSync(join(bin, 'sudo'), 0o755);
  writeFileSync(join(bin, 'udisks2-inhibit'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$BAKE_TEST_UDISKS_INHIBIT_CALLS"
if [ "$BAKE_TEST_UDISKS_INHIBIT_FAIL" = "1" ]; then exit 73; fi
exec "$@"
`, { mode: 0o755 });
  chmodSync(join(bin, 'udisks2-inhibit'), 0o755);
  for (const tool of ['syft', 'grype']) {
    writeFileSync(join(bin, tool), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(join(dir, 'release-supply-chain.sh'), `#!/usr/bin/env bash
set -euo pipefail
: > "$BAKE_TEST_SUPPLY_CHAIN_MARKER"
`, { mode: 0o755 });
  chmodSync(join(dir, 'release-supply-chain.sh'), 0o755);

  const optionalArgs: string[] = [];
  if (release?.root !== undefined) optionalArgs.push('--release-root', release.root);
  if (release?.version !== undefined) optionalArgs.push('--release-version', release.version);
  if (sourceImage !== undefined) optionalArgs.push('--source-image', sourceImage.ref);

  const result = spawnSync(
    'bash',
    [
      source,
      '--registry',
      'localhost/test',
      '--key',
      key,
      '--pubkey',
      pubkey,
      '--clouds',
      'gcp',
      '--out',
      out,
      ...optionalArgs,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        BAKE_TEST_SOURCE: source,
        BAKE_TEST_MUTATION_MARKER: mutationMarker,
        BAKE_TEST_BUILD_MARKER: buildMarker,
        BAKE_TEST_BUILD_ARGS: buildArgsPath,
        BAKE_TEST_PODMAN_CALLS: podmanCallsPath,
        BAKE_TEST_UDISKS_INHIBIT_CALLS: inhibitCallsPath,
        BAKE_TEST_UDISKS_INHIBIT_FAIL: inhibitFails ? '1' : '0',
        BAKE_TEST_SOURCE_IMAGE: sourceImage?.ref ?? '',
        BAKE_TEST_SOURCE_EXISTS: sourceImage?.exists === false ? '0' : '1',
        BAKE_TEST_SUPPLY_CHAIN_MARKER: supplyChainMarker,
        BAKE_TEST_RENDER: render,
        RELEASE_STORAGE_DRIVER: 'overlay',
        UDISKS2_INHIBIT_BIN: join(bin, 'udisks2-inhibit'),
        PAPERCUSP_UDISKS2_INHIBIT_LOCK: inhibitLock,
        P307_BUILD_HEALTH_DISABLE: '1',
        TMPDIR: dir,
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );

  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    files: readdirSync(dir),
    outFiles: readdirSync(out, { recursive: true }).map(String),
    manifest: existsSync(join(out, 'bake-manifest.json'))
      ? JSON.parse(readFileSync(join(out, 'bake-manifest.json'), 'utf8'))
      : null,
    buildArgs: existsSync(buildArgsPath)
      ? readFileSync(buildArgsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      : [],
    podmanCalls: existsSync(podmanCallsPath)
      ? readFileSync(podmanCallsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      : [],
    inhibitCalls: existsSync(inhibitCallsPath)
      ? readFileSync(inhibitCallsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      : [],
  };
}

describe('bake-cloud-images.sh startup snapshot (EI-22355025813361885)', () => {
  it('keeps a live bake on the startup bytes after the source is rewritten', () => {
    const result = runFixture(SOURCE);

    expect(result.status).toBe(0);
    expect(result.output).toContain('BAKE_RESULT=PASS');
    expect(result.output).toContain('### 1/4 build (one image, all clouds)');
    expect(result.output).toContain('gcp: ok');
    expect(result.files).toContain('source-mutated');
    expect(result.files).toContain('build-started');
    expect(result.files).toContain('supply-chain-ran');
    expect(result.outFiles).toContain('bake-manifest.json');
    expect(result.outFiles).toContain('gcp/image/disk.raw');
    expect(result.files.some((name) => name.startsWith('papercusp-bake-cloud-images.'))).toBe(false);
    expect(result.inhibitCalls).toHaveLength(1);
    expect(result.inhibitCalls[0]).toContain('podman run --rm --privileged');
  });

  it('fails closed when the host UDisks automount inhibitor cannot guard the renderer', () => {
    const result = runFixture(SOURCE, 'raw', undefined, undefined, true);

    expect(result.status).toBe(1);
    expect(result.output).toContain('BAKE_UDISKS2_INHIBIT=');
    expect(result.output).toContain('gcp: FAILED');
    expect(result.output).not.toContain('BAKE_RESULT=PASS');
    expect(result.inhibitCalls).toHaveLength(1);
    expect(result.inhibitCalls[0]).toContain('podman run --rm --privileged');
    expect(result.podmanCalls.some((call) => call.startsWith('run --rm --privileged'))).toBe(false);
  });

  it('falsifiability control: the pre-fix live-source shape is broken by the same rewrite', () => {
    const result = runFixture(withoutSnapshotGuard());

    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('BAKE_RESULT=PASS');
    expect(result.output).toMatch(/syntax error/i);
  });

  it('normalizes the real GCE archive layout into a releasable GCP-only manifest', () => {
    const result = runFixture(SOURCE, 'archive');
    expect(result.status, result.output).toBe(0);
    const artifact = workspaceHostBootcCloudArtifact(parseWorkspaceHostBootcBakeManifest(result.manifest), 'gcp');
    const bytes = Buffer.from('fake rendered disk\n');
    expect(artifact.sizeBytes).toBe(bytes.length);
    expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.outFiles).toContain('gcp/image/disk.raw');
  });

  it.each(['empty', 'stale'] as const)('refuses a %s render output instead of publishing success', (render) => {
    const result = runFixture(SOURCE, render);
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('BAKE_RESULT=PASS');
    expect(() => parseWorkspaceHostBootcBakeManifest(result.manifest)).toThrow();
  });

  it('selects the optional named release context only when both P-305 release options are present', () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), 'p305-release-root-'));
    try {
      const result = runFixture(SOURCE, 'raw', { root: releaseRoot, version: '0.0.18-r21' });
      expect(result.status, result.output).toBe(0);
      expect(result.buildArgs).toEqual(
        expect.arrayContaining([
          '--target',
          'workspace-host-release',
          '--build-context',
          `papercusp-release=${releaseRoot}`,
          '--build-arg',
          'PAPERCUSP_RELEASE_VERSION=0.0.18-r21',
        ]),
      );
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('reuses an explicitly named local image without rebuilding it', () => {
    const sourceImage = 'localhost/p305-release-target-current:20260907-1010';
    const result = runFixture(SOURCE, 'raw', undefined, { ref: sourceImage });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('reuse verified local image (no rebuild)');
    expect(result.files).not.toContain('build-started');
    const pushedImage = result.podmanCalls.find((call) => call.startsWith('push localhost/test/workspace-host:'))?.slice(5);
    expect(pushedImage).toBeTruthy();
    expect(result.podmanCalls).toEqual(
      expect.arrayContaining([
        `image exists ${sourceImage}`,
        `tag ${sourceImage} ${pushedImage}`,
      ]),
    );
    expect(result.podmanCalls.some((call) => call.startsWith('build '))).toBe(false);
  });

  it('refuses a missing source image before tag, push, signing, or rendering', () => {
    const sourceImage = 'localhost/missing:rollback';
    const result = runFixture(SOURCE, 'raw', undefined, { ref: sourceImage, exists: false });

    expect(result.status).toBe(1);
    expect(result.output).toContain(`source image absent from local storage: ${sourceImage}`);
    expect(result.files).not.toContain('build-started');
    expect(result.files).not.toContain('supply-chain-ran');
    expect(result.podmanCalls).toEqual([`image exists ${sourceImage}`]);
  });

  it('refuses source-image plus release-root inputs before invoking Podman', () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), 'p305-mutually-exclusive-root-'));
    try {
      const result = runFixture(
        SOURCE,
        'raw',
        { root: releaseRoot, version: '0.0.18-r21' },
        { ref: 'localhost/existing:r21' },
      );

      expect(result.status).toBe(2);
      expect(result.output).toContain('--source-image is mutually exclusive with --release-root/--release-version');
      expect(result.podmanCalls).toEqual([]);
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('refuses a half-configured named release context before invoking Podman', () => {
    const result = runFixture(SOURCE, 'raw', { version: '0.0.18-r21' });
    // The fixture above supplies the version without a root, so this is the
    // negative control for the parser.  (The successful pair is exercised by
    // the test immediately below.)
    expect(result.status).toBe(2);
    expect(result.output).toContain('--release-root and --release-version must be supplied together');
    expect(result.files).not.toContain('build-started');
  });

  it('keeps the OS-only target as the default and puts the release layer behind an explicit target', () => {
    const releaseStage = CONTAINERFILE_SOURCE.indexOf('FROM workspace-host-os AS workspace-host-release');
    const defaultStage = CONTAINERFILE_SOURCE.indexOf('FROM workspace-host-os AS workspace-host\n');
    expect(releaseStage).toBeGreaterThan(-1);
    expect(defaultStage).toBeGreaterThan(releaseStage);
    expect(CONTAINERFILE_SOURCE).toContain('COPY --from=papercusp-release / /opt/papercusp/releases/${PAPERCUSP_RELEASE_VERSION}/');
    expect(SOURCE).toContain('--target workspace-host-release');
    expect(HOST_PREPARE_SOURCE).toContain('setfacl -R -m "u:$AGENT_USER:rX" "$RUNTIME_ROOT/releases"');
  });

  it('materializes named-context hardlinks before normalizing release metadata', () => {
    const lookup = CONTAINERFILE_SOURCE.indexOf(`find "$RELEASE_DIR" -type f -exec stat -c '%i' -- {} + >/dev/null`);
    const snapshot = CONTAINERFILE_SOURCE.indexOf(`find "$RELEASE_DIR" -type f -links +1 -print0 > "$HARDLINK_PATHS"`);
    const freshCopy = CONTAINERFILE_SOURCE.indexOf(
      `cp --reflink=never --preserve=mode,timestamps -- "$path" "$fresh"`,
    );
    const noHardlinks = CONTAINERFILE_SOURCE.indexOf(
      `[ -z "$(find "$RELEASE_DIR" -type f -links +1 -print -quit)" ]`,
    );
    const normalizeOwner = CONTAINERFILE_SOURCE.indexOf(
      'chown -R "root:${PAPERCUSP_SERVICE_GROUP}" "$RELEASE_DIR"',
    );

    expect(lookup).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(lookup);
    expect(freshCopy).toBeGreaterThan(snapshot);
    expect(noHardlinks).toBeGreaterThan(freshCopy);
    expect(normalizeOwner).toBeGreaterThan(noHardlinks);
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain('committed release hardlinks are five distinct 0:910/0640 inodes');
  });

  it('recreates Google OS Login user state at boot instead of committing /var residue', () => {
    expect(GOOGLE_OSLOGIN_TMPFILES_SOURCE).toContain('d /var/google-users.d 0755 root root - -');
    expect(CONTAINERFILE_SOURCE).toContain(
      'COPY papercusp-google-oslogin.conf /usr/lib/tmpfiles.d/papercusp-google-oslogin.conf',
    );
    expect(CONTAINERFILE_SOURCE).toContain('/var/google-users.d');
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain('test ! -e /var/google-users.d');
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain(
      'systemd-tmpfiles --create /usr/lib/tmpfiles.d/papercusp-google-oslogin.conf',
    );
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain('expected 755:0:0');
  });
});
