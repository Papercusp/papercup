/** P-011: exercise the maintained sibling builder, including its rejected-build
 * publish contract. This guard never launches a host or uses the live database. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');

it('builds the guarded standalone graph and preserves its prior bytes when compilation is refused', () => {
  const output = mkdtempSync(join(tmpdir(), 'papercusp-spawner-bundle-'));
  try {
    const command = 'source "$1"; bundle_host_spawner "$2" "$3" --external:typescript --external:esbuild --external:@papercusp/embedded-postgres-server --external:@embedded-postgres/* "${HOST_COMMON_EXTERNALS[@]}" "${NATIVE_PKGS[@]/#/--external:}" "$4"';
    const recipe = join(root, 'apps/operator/bin/bundle-host-common.sh');
    const build = (extra: string) => spawnSync('bash', ['-c', command, 'spawner-bundle-test', recipe, root, output, extra], {
      cwd: join(root, 'apps/operator'), encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PAPERCUSP_MUTATION_PROBE_TMPDIR: output },
    });
    const first = build('--log-limit=20');
    expect(first.status, first.stderr + first.stdout).toBe(0);
    const entry = join(output, 'spawner-sidecar.mjs');
    const bytes = readFileSync(entry);
    const metadata = JSON.parse(readFileSync(entry + '.meta.json', 'utf8'));
    const paths: string[] = Object.keys(metadata.inputs).map(path => path.replaceAll('\\', '/'));
    expect(paths.some(path => path.endsWith('fleet/spawner-sidecar-server.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('bin/boot-malloc-arena.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('bin/boot-integrity-first.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('process-supervision/parent-death-watch.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('process-supervision/fatal-diagnostics.ts'))).toBe(true);
    expect(paths.filter(path => /bin\/(hono-host|host-handler|host-bootstrap|serve)\.ts$/.test(path))).toEqual([]);
    expect(spawnSync(process.execPath, ['--check', entry], { encoding: 'utf8' }).status).toBe(0);
    const rejected = build('--invalid-spawner-build-option');
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('invalid-spawner-build-option');
    expect(readFileSync(entry).equals(bytes)).toBe(true);
    expect(existsSync(entry + '.meta.json')).toBe(true);
    // Both maintained deploy shapes and the current-build rig stage this bundle.
    for (const [script, destination] of [
      ['apps/operator/bin/bundle-host.sh', '$OUTDIR'],
      ['papercusp-desktop/bin/build-desktop-sidecar.sh', '$SIDECAR_DIR'],
      ['papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh', '$OUT'],
    ]) {
      const code = readFileSync(join(root, script), 'utf8').split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
      expect(code).toContain(`bundle_host_spawner "$REPO_ROOT" "${destination}"`);
    }
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 150_000);
