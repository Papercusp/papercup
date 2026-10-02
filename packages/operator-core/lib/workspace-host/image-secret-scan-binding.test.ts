import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
// Overridable so scripts/mutation-probe.sh can point the suite at a copy outside the tree.
const SCRIPT = process.env.IMAGE_SECRET_SCAN_SCRIPT ?? join(ROOT, 'infra/images/bootc/image-secret-scan.sh');

const REQUESTED = 'sha256:' + '3'.repeat(64);
const IMAGE = `registry.example.com/papercusp/workspace-host@${REQUESTED}`;
const CONFIG_HEX = 'a'.repeat(64);
// The manifest digest the LOCAL store recorded at build time. It differs from the pushed
// manifest digest for the same image (measured 2026-10-02, WI-10005624).
const LOCAL_MANIFEST_DIGEST = 'sha256:' + 'f'.repeat(64);

const tempDirs: string[] = [];

interface Fixture {
  imageId: string;
  manifest: unknown;
  /** Ship a 0555 directory with a file in it, as the real image does (etc/pki/.../directory-hash). */
  readOnlyDir?: boolean;
}

function runScan(fixture: Fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'image-secret-scan-binding-'));
  tempDirs.push(dir);
  const bin = join(dir, 'bin');
  const out = join(dir, 'out');
  const rootfs = join(dir, 'rootfs');
  const manifest = join(dir, 'manifest.json');
  const auditor = join(dir, 'auditor.py');
  const podmanCallLog = join(dir, 'podman-calls.log');
  mkdirSync(bin);
  mkdirSync(join(rootfs, 'etc'), { recursive: true });
  writeFileSync(join(rootfs, 'etc', 'os-release'), 'NAME=fixture\n');
  writeFileSync(join(rootfs, 'etc', 'hostname'), 'fixture\n');
  if (fixture.readOnlyDir) {
    const hashDir = join(rootfs, 'etc', 'pki', 'directory-hash');
    mkdirSync(hashDir, { recursive: true });
    writeFileSync(join(hashDir, 'ca-bundle.crt'), 'fixture cert\n');
    chmodSync(hashDir, 0o555);
  }
  writeFileSync(manifest, JSON.stringify(fixture.manifest));
  writeFileSync(podmanCallLog, '');
  writeFileSync(auditor, ['import sys', 'print("  coverage: 2 file(s) scanned")', 'sys.exit(0)', ''].join('\n'));

  writeFileSync(
    join(bin, 'sudo'),
    ['#!/usr/bin/env bash', 'set -euo pipefail', '[ "${1:-}" = "-n" ] && shift', 'exec "$@"', ''].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'podman'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf "%s\\n" "$*" >> "$PODMAN_CALL_LOG"',
      'case "$1" in',
      '  create) echo fixture-ctr ;;',
      '  inspect)',
      '    case "$3" in',
      "      '{{.Image}}') echo \"$FAKE_IMAGE_ID\" ;;",
      "      '{{.ImageDigest}}') echo \"$FAKE_LOCAL_DIGEST\" ;;",
      '      *) exit 1 ;;',
      '    esac ;;',
      '  run) cat "$FAKE_MANIFEST" ;;',
      '  export) tar -c -C "$FAKE_ROOTFS" . ;;',
      '  rm) ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const result = spawnSync(
    'bash',
    [SCRIPT, '--image', IMAGE, '--out', out, '--auditor', auditor, '--min-files', '1', '--insecure-registry'],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: bin + ':' + (process.env.PATH ?? ''),
        PODMAN_CALL_LOG: podmanCallLog,
        FAKE_IMAGE_ID: fixture.imageId,
        FAKE_LOCAL_DIGEST: LOCAL_MANIFEST_DIGEST,
        FAKE_MANIFEST: manifest,
        FAKE_ROOTFS: rootfs,
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  const recordPath = join(out, 'secret-scan.json');
  return {
    status: result.status ?? -1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
    podmanCalls: readFileSync(podmanCallLog, 'utf8').split('\n').filter(Boolean),
    record: existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null,
    treeLeftBehind: existsSync(join(out, 'secret-scan-rootfs')),
  };
}

const singlePlatformManifest = (configDigest: string) => ({
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: 1 },
  layers: [],
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    // A read-only fixture dir (or a tree the script failed to remove) would make rmSync throw.
    spawnSync('chmod', ['-R', 'u+w', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('image-secret-scan removes the exported tree even when the image ships read-only directories', () => {
  it('leaves no extracted rootfs behind after a clean scan of an image with a 0555 directory', () => {
    // Measured 2026-10-02 on the P-012 AWS bake: etc/pki/ca-trust/extracted/pem/directory-hash
    // is 0555 in the image, tar restored that mode, and 365 entries survived `rm -rf`. The
    // next run's extraction into that stale tree is the failure this guards against.
    const result = runScan({
      imageId: CONFIG_HEX,
      manifest: singlePlatformManifest(`sha256:${CONFIG_HEX}`),
      readOnlyDir: true,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('SECRET_SCAN_RESULT=CLEAN');
    expect(result.output).not.toMatch(/cannot remove/);
    expect(result.treeLeftBehind).toBe(false);
  });
});

describe('image-secret-scan binds the scanned container to the requested image by content', () => {
  it('scans an image whose local manifest digest differs from the pushed one when the registry config matches', () => {
    // Podman prints the image id without a sha256: prefix; the local `.ImageDigest` is the
    // build-time manifest, not the requested registry digest. The old comparison refused this.
    const result = runScan({ imageId: CONFIG_HEX, manifest: singlePlatformManifest(`sha256:${CONFIG_HEX}`) });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`IMAGE_CONFIG=sha256:${CONFIG_HEX}`);
    expect(result.output).toContain('SECRET_SCAN_RESULT=CLEAN');
    expect(result.record).toMatchObject({ image: IMAGE, digest: REQUESTED, verdict: 'clean', exitCode: 0 });
    expect(result.podmanCalls.some((call) => call.startsWith('export '))).toBe(true);
  });

  it('refuses before exporting when the container is a different image than the registry holds', () => {
    const result = runScan({ imageId: 'b'.repeat(64), manifest: singlePlatformManifest(`sha256:${CONFIG_HEX}`) });

    expect(result.status, result.output).toBe(2);
    expect(result.output).toContain('is not the image the registry holds');
    expect(result.output).toContain('SECRET_SCAN_RESULT=FAIL');
    expect(result.record).toBeNull();
    expect(result.podmanCalls.some((call) => call.startsWith('export '))).toBe(false);
  });

  it('refuses a multi-platform index rather than guessing which platform to bind', () => {
    const result = runScan({
      imageId: CONFIG_HEX,
      manifest: {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [{ digest: `sha256:${'c'.repeat(64)}`, platform: { architecture: 'amd64', os: 'linux' } }],
      },
    });

    expect(result.status, result.output).toBe(2);
    expect(result.output).toContain('multi-platform index');
    expect(result.record).toBeNull();
    expect(result.podmanCalls.some((call) => call.startsWith('export '))).toBe(false);
  });

  it('refuses a registry manifest that names no config digest', () => {
    const result = runScan({ imageId: CONFIG_HEX, manifest: { schemaVersion: 2, layers: [] } });

    expect(result.status, result.output).toBe(2);
    expect(result.output).toContain('names no config digest');
    expect(result.record).toBeNull();
    expect(result.podmanCalls.some((call) => call.startsWith('export '))).toBe(false);
  });
});
