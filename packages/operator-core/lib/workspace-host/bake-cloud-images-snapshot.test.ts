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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorkspaceHostBootcBakeManifest, workspaceHostBootcCloudArtifact } from './bootc-bake-manifest';

const ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(ROOT, 'infra/images/bootc/bake-cloud-images.sh');
const HEALTH = join(ROOT, 'infra/images/bootc/p307-build-health.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');
const SNAPSHOT_MARKER = '# EI-22355025813361885 — freeze the entrypoint';

function withoutSnapshotGuard(): string {
  const start = SOURCE.indexOf(SNAPSHOT_MARKER);
  const end = SOURCE.indexOf('set -uo pipefail\n', start);
  expect(start, 'snapshot guard marker must be present in the shipped script').toBeGreaterThan(-1);
  expect(end, 'snapshot guard must precede set -uo pipefail').toBeGreaterThan(start);
  return SOURCE.slice(0, start) + SOURCE.slice(end);
}

function runFixture(script: string, render: 'raw' | 'archive' | 'empty' | 'stale' = 'raw'): {
  status: number;
  output: string;
  files: string[];
  outFiles: string[];
  manifest: unknown;
} {
  const dir = mkdtempSync(join(tmpdir(), 'ei-223550-bake-'));
  const source = join(dir, 'bake-cloud-images.sh');
  const health = join(dir, 'p307-build-health.sh');
  const bin = join(dir, 'bin');
  const out = join(dir, 'out');
  const mutationMarker = join(dir, 'source-mutated');
  const buildMarker = join(dir, 'build-started');
  const supplyChainMarker = join(dir, 'supply-chain-ran');
  const key = join(dir, 'release.key');
  const pubkey = join(dir, 'release.pub');

  mkdirSync(bin, { recursive: true });
  mkdirSync(out, { recursive: true });
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

case "$subcommand" in
  info)
    printf 'overlay\\n'
    ;;
  build)
    : > "$BAKE_TEST_BUILD_MARKER"
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
  for (const tool of ['syft', 'grype']) {
    writeFileSync(join(bin, tool), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(join(dir, 'release-supply-chain.sh'), `#!/usr/bin/env bash
set -euo pipefail
: > "$BAKE_TEST_SUPPLY_CHAIN_MARKER"
`, { mode: 0o755 });
  chmodSync(join(dir, 'release-supply-chain.sh'), 0o755);

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
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        BAKE_TEST_SOURCE: source,
        BAKE_TEST_MUTATION_MARKER: mutationMarker,
        BAKE_TEST_BUILD_MARKER: buildMarker,
        BAKE_TEST_SUPPLY_CHAIN_MARKER: supplyChainMarker,
        BAKE_TEST_RENDER: render,
        RELEASE_STORAGE_DRIVER: 'overlay',
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
});
