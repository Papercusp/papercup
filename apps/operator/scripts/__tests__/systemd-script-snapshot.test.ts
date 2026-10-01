import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectChildOutput } from '@papercusp/operator-core/lib/child-output';

const WRAPPER = resolve(__dirname, '..', 'systemd', 'papercusp-script-snapshot.sh');
const DB_UNIT = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.service');
const HEALTH_UNIT = resolve(__dirname, '..', 'systemd', 'papercup-backup-health.service');
const STAGING_DROPIN = resolve(__dirname, '..', 'systemd', 'papercup-staging-sync.service.d', '50-script-snapshot.conf');

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
      const output = collectChildOutput(child);
      child.once('error', reject);
      child.once('close', (status) =>
        resolveResult({ status, stdout: output.stdout.text(), stderr: output.stderr.text() }),
      );
    },
  );
}

// A wall-clock deadline, not an attempt count: 100 x 10ms gave a nested bash
// ~1s to start, which the gate's loaded host missed (verify 079f459e, 8c666117).
async function waitForFile(path: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
  it('routes staging sync and its mutable setup script through the shared snapshot launcher', async () => {
    const dropin = await readFile(STAGING_DROPIN, 'utf8');
    expect(dropin).toContain('ExecStart=\nExecStart=/usr/bin/bash ');
    expect(dropin).toMatch(/ExecStart=.*papercusp-script-snapshot\.sh .*sync-staging-checkout\.sh/);
    const script = await readFile(resolve(__dirname, '../../bin/release/sync-staging-checkout.sh'), 'utf8');
    expect(script).toMatch(/bash "\$INTEGRATION_ROOT\/apps\/operator\/scripts\/systemd\/papercusp-script-snapshot\.sh" \\\n\s+"\$INTEGRATION_ROOT\/apps\/operator\/bin\/release\/setup-release-checkout\.sh"/);
  });

  it.each([false, true])('distinguishes lazy source mutation with snapshot=%s', async (snapshot) => {
    const dir = await mkdtemp(join(tmpdir(), 'staging-script-live-edit-'));
    try {
      const target = join(dir, 'sync.sh');
      const ready = join(dir, 'ready');
      const release = join(dir, 'release');
      expect(spawnSync('mkfifo', [release]).status).toBe(0);
      await writeExecutable(target, [
        '#!/usr/bin/env bash',
        'printf ready > "$READY_FILE"',
        'read -r token < "$RELEASE_PIPE"',
        '# padding beyond the parser buffer\n'.repeat(10000),
        'echo ORIGINAL',
      ].join('\n'));
      const child = spawn('bash', snapshot ? [WRAPPER, target] : [target], {
        cwd: dir, env: { ...process.env, TMPDIR: dir, READY_FILE: ready, RELEASE_PIPE: release },
      });
      const output = collectChildOutput(child);
      const finished = new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('close', done);
      });
      try {
        await waitForFile(ready);
        await writeExecutable(target, '#!/usr/bin/env bash\necho MUTATED\n');
        await writeFile(release, 'resume\n');
        const status = await finished;
        if (snapshot) {
          expect(status).toBe(0);
          expect(output.stdout.text().trim()).toBe('ORIGINAL');
        } else {
          expect(output.stdout.text()).not.toContain('ORIGINAL');
        }
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the systemd ExecStart wrapper executable', async () => {
    expect((await stat(WRAPPER)).mode & 0o111).toBe(0o111);
  });

  it('passes bash syntax validation', () => {
    const result = spawnSync('bash', ['-n', WRAPPER], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toBe('');
  });

  it('keeps a sourced adjacent helper available and frozen during a long setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-adjacent-helper-'));
    try {
      const target = join(dir, 'setup-release-checkout.sh');
      const helper = join(dir, 'dependency-generation.sh');
      const ready = join(dir, 'ready');
      const release = join(dir, 'release');
      expect(spawnSync('mkfifo', [release]).status).toBe(0);
      await writeExecutable(helper, 'SNAPSHOT_VALUE=ORIGINAL\n');
      await writeExecutable(target, [
        '#!/usr/bin/env bash',
        'printf ready > "$READY_FILE"',
        'read -r token < "$RELEASE_PIPE"',
        'source "$(dirname "${BASH_SOURCE[0]}")/dependency-generation.sh"',
        'printf "%s\\n" "$SNAPSHOT_VALUE"',
      ].join('\n'));
      const run = runWrapper(dir, [target], { READY_FILE: ready, RELEASE_PIPE: release });
      await waitForFile(ready);
      await writeExecutable(helper, 'SNAPSHOT_VALUE=MUTATED\n');
      await writeFile(release, 'resume\n');
      const result = await run;
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('ORIGINAL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps an adjacent .mjs helper available and frozen during a long setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-adjacent-mjs-helper-'));
    try {
      const target = join(dir, 'setup-release-checkout.sh');
      const helper = join(dir, 'pinned-lock-deps.mjs');
      const ready = join(dir, 'mjs.ready');
      const release = join(dir, 'release');
      expect(spawnSync('mkfifo', [release]).status).toBe(0);
      await writeFile(helper, 'console.log("MJS_ORIGINAL")\n');
      await writeExecutable(target, [
        '#!/usr/bin/env bash',
        'set -u',
        'printf ready > "$READY_FILE"',
        'read -r token < "$RELEASE_PIPE"',
        'node "$(dirname "${BASH_SOURCE[0]}")/pinned-lock-deps.mjs"',
      ].join('\n'));

      const run = runWrapper(dir, [target], { READY_FILE: ready, RELEASE_PIPE: release });
      await waitForFile(ready);
      await writeFile(helper, 'console.log("MJS_MUTATED")\n');
      await writeFile(release, 'resume\n');

      const result = await run;
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('MJS_ORIGINAL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
