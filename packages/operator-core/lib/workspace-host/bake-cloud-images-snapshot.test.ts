/**
 * Regression guard for EI-22355025813361885.
 *
 * Bash reads compound commands lazily. An in-place rewrite of the bake entrypoint
 * during a long build can therefore splice a later function body into the running
 * interpreter even when the source parsed cleanly at launch. The real entrypoint
 * now copies + syntax-checks itself and re-execs the copy before setup. This test
 * mutates only a temporary fixture after the early `date` setup gate and proves the
 * run still completes from its startup snapshot. A permanent pre-fix control keeps
 * the behavioral assertion falsifiable without mutating the shared checkout.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

function runFixture(script: string): { status: number; output: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ei-223550-bake-'));
  const source = join(dir, 'bake-cloud-images.sh');
  const health = join(dir, 'p307-build-health.sh');
  const bin = join(dir, 'bin');
  const out = join(dir, 'out');
  const marker = join(dir, 'source-mutated');
  const date = join(bin, 'date');

  mkdirSync(bin, { recursive: true });
  writeFileSync(source, script, { mode: 0o755 });
  copyFileSync(HEALTH, health);
  chmodSync(source, 0o755);
  chmodSync(health, 0o755);
  writeFileSync(date, `#!/usr/bin/env bash
if [ ! -e "$BAKE_TEST_MUTATION_MARKER" ]; then
  : > "$BAKE_TEST_MUTATION_MARKER"
  printf '\\nif (\\n' >> "$BAKE_TEST_SOURCE"
fi
exec /usr/bin/date "$@"
`, { mode: 0o755 });
  chmodSync(date, 0o755);

  const result = spawnSync(
    'bash',
    [source, '--registry', 'localhost/test', '--clouds', 'gcp', '--dry-run', '--out', out],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        BAKE_TEST_SOURCE: source,
        BAKE_TEST_MUTATION_MARKER: marker,
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );

  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    files: readdirSync(dir),
  };
}

describe('bake-cloud-images.sh startup snapshot (EI-22355025813361885)', () => {
  it('keeps a live dry-run on the startup bytes after the source is rewritten', () => {
    const result = runFixture(SOURCE);

    expect(result.status).toBe(0);
    expect(result.output).toContain('BAKE_RESULT=PASS');
    expect(result.output).toContain('DRY_RUN: would podman build');
    expect(result.files.some((name) => name.startsWith('papercusp-bake-cloud-images.'))).toBe(false);
  });

  it('falsifiability control: the pre-fix live-source shape is broken by the same rewrite', () => {
    const result = runFixture(withoutSnapshotGuard());

    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('BAKE_RESULT=PASS');
  });
});
