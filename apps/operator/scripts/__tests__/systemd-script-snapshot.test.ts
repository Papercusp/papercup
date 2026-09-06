import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WRAPPER = resolve(__dirname, '..', 'systemd', 'papercusp-script-snapshot.sh');
const DB_UNIT = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.service');
const HEALTH_UNIT = resolve(__dirname, '..', 'systemd', 'papercup-backup-health.service');

async function writeExecutable(path: string, body: string) {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function runWrapper(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: cwd, ...extraEnv };
  delete env.PAPERCUSP_SCRIPT_SNAPSHOT_SELF_COPIED;
  delete env.PAPERCUSP_SCRIPT_SNAPSHOT_SELF_DIR;

  return await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolveResult, reject) => {
      const child = spawn('bash', [WRAPPER, ...args], { cwd, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once('error', reject);
      child.once('close', (status) => resolveResult({ status, stdout, stderr }));
    },
  );
}

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolveResult) => setTimeout(resolveResult, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe('papercusp-script-snapshot.sh', () => {
  it('passes bash syntax validation', () => {
    const result = spawnSync('bash', ['-n', WRAPPER], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toBe('');
  });

  it('keeps a long-running target on the pre-edit byte snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-script-snapshot-test-'));
    try {
      const target = join(dir, 'target.sh');
      const ready = join(dir, 'target.ready');
      await writeExecutable(
        target,
        `#!/usr/bin/env bash
set -u
printf ready > "$READY_FILE"
sleep 0.2
grep -q ORIGINAL "$0" && echo ORIGINAL || echo MUTATED
`,
      );

      const run = runWrapper(dir, [target], { READY_FILE: ready });
      await waitForFile(ready);
      await writeExecutable(
        target,
        `#!/usr/bin/env bash
set -u
echo MUTATED
`,
      );

      const result = await run;
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('ORIGINAL');
      expect(await readFile(target, 'utf8')).toContain('MUTATED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rewrites nested shell arguments instead of passing mutable source paths through', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-script-snapshot-nested-'));
    try {
      const guard = join(dir, 'guard.sh');
      const nested = join(dir, 'nested.sh');
      await writeExecutable(
        guard,
        `#!/usr/bin/env bash
set -u
[ "$1" = "--" ] || exit 64
shift
bash "$1"
`,
      );
      await writeExecutable(
        nested,
        `#!/usr/bin/env bash
set -u
printf ready > "$READY_FILE"
sleep 0.2
grep -q NESTED_ORIGINAL "$0" && echo NESTED_ORIGINAL || echo NESTED_MUTATED
`,
      );

      const ready = join(dir, 'nested.ready');
      const run = runWrapper(dir, [guard, '--', nested], { READY_FILE: ready });
      await waitForFile(ready);
      await writeExecutable(
        nested,
        `#!/usr/bin/env bash
set -u
echo NESTED_MUTATED
`,
      );

      const result = await run;
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('NESTED_ORIGINAL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves adjacent lib shell sidecars for scripts that source them via BASH_SOURCE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-script-snapshot-sidecar-'));
    try {
      const sourceDir = join(dir, 'source');
      const libDir = join(sourceDir, 'lib');
      const target = join(sourceDir, 'health.sh');
      await mkdir(libDir, { recursive: true });
      await writeExecutable(
        join(libDir, 'red-marker.sh'),
        `MARKER_VALUE=SIDECAR_ORIGINAL
`,
      );
      await writeExecutable(
        target,
        `#!/usr/bin/env bash
set -u
. "$(dirname "$0")/lib/red-marker.sh"
printf ready > "$READY_FILE"
sleep 0.2
printf '%s\\n' "$MARKER_VALUE"
`,
      );

      const ready = join(dir, 'sidecar.ready');
      const run = runWrapper(dir, [target], { READY_FILE: ready });
      await waitForFile(ready);
      await writeExecutable(join(libDir, 'red-marker.sh'), 'MARKER_VALUE=SIDECAR_MUTATED\n');

      const result = await run;
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('SIDECAR_ORIGINAL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('routes both backup units through the snapshot wrapper, including the DB guard target', async () => {
    const dbUnit = await readFile(DB_UNIT, 'utf8');
    const healthUnit = await readFile(HEALTH_UNIT, 'utf8');

    expect(dbUnit).toMatch(
      /^ExecStart=.*papercusp-script-snapshot\.sh .*kopia-backup-guard\.sh .*-- .*papercusp-db-backup\.sh$/m,
    );
    expect(healthUnit).toMatch(
      /^ExecStart=.*papercusp-script-snapshot\.sh .*papercup-backup-health-check\.sh$/m,
    );
    expect(healthUnit).not.toContain('kopia-backup-guard.sh');
  });
});
