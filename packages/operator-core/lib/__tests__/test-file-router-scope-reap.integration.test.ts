/**
 * The test router's sibling systemd scope must not outlive the Vitest run it holds.
 *
 * host-memory-reduction-2026-09-27 P-008: nine anonymous `run-u*.scope` units were still holding
 * kopia-backup-guard / pc-heavy fixture loops 19 days after their routers died, each forking a
 * `sleep` about ten times a second. A fixture spawned `detached: true` sits in its own process
 * group, so the router's process-group SIGKILL never reached it, and nothing ever stopped the
 * scope. The unit suite (test-file-router.test.ts) pins the router's decisions through seams; this
 * file proves the real systemd behaviour those decisions rely on.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error — plain-Node .mjs launcher, no declaration file.
import { runCapturedTestProcess } from '../../../../scripts/test-files.mjs';

// testing:run marks its own bounded scope with these two; with both present the router rightly
// declines to open a nested scope, which is not the path under test here.
const { PAPERCUSP_TEST_RUN_GROUP: _group, PAPERCUSP_TASK_DEADLINE_EPOCH_MS: _deadline, ...env } = process.env;
const systemdRun = ['/usr/bin/systemd-run', '/bin/systemd-run'].find((candidate) => existsSync(candidate));
const userScopesWork = Boolean(
  systemdRun &&
    (env.XDG_RUNTIME_DIR || env.DBUS_SESSION_BUS_ADDRESS) &&
    spawnSync(systemdRun, ['--user', '--scope', '--quiet', '--collect', '--', 'true'], {
      env,
      timeout: 10_000,
    }).status === 0,
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('test router scope lifetime (host-memory-reduction-2026-09-27 P-008)', () => {
  it.skipIf(!userScopesWork)(
    'kills a fixture that detached into its own process group and still holds the stdout pipe',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'scope-reap-'));
      const pidFile = join(dir, 'straggler.pid');
      const lines: string[] = [];
      // The straggler keeps the router's stdout pipe open on purpose: without the scope stop,
      // `close` never fires and the run hangs until its watchdog — which then misses the
      // straggler too, because it signals only the Vitest process group.
      const script = [
        `setsid bash -c 'echo $$ >"$1"; while :; do sleep 0.2; done' _ "$1" </dev/null &`,
        'for _ in $(seq 1 100); do [ -s "$1" ] && exit 0; sleep 0.05; done',
        'exit 3',
      ].join('\n');
      try {
        const result = await runCapturedTestProcess('bash', ['-c', script, '_', pidFile], {
          cwd: dir,
          env,
          files: [],
          timeoutMs: 30_000,
          watchdogMaxMs: 30_000,
          onProgress: (line: string) => lines.push(line),
          governedProcessImpl: (_governedOptions: unknown, run: Function) =>
            run(undefined, undefined, { inherited: true }),
        });
        expect(result).toMatchObject({ status: 0, timedOut: false });

        const straggler = Number(readFileSync(pidFile, 'utf8'));
        expect(straggler).toBeGreaterThan(1);
        const deadline = Date.now() + 15_000;
        while (alive(straggler) && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        expect(alive(straggler)).toBe(false);
        expect(lines.find((line) => line.startsWith('TEST_FILE_LEAKED_PROCESSES'))).toMatch(
          /^TEST_FILE_LEAKED_PROCESSES scope=papercusp-test-\d+-[0-9a-z]+-\d+\.scope tasks=[1-9]\d* reason=exit /,
        );
      } finally {
        // A failed assertion must not leave the very leak this file guards against.
        try {
          const pid = Number(readFileSync(pidFile, 'utf8'));
          if (pid > 1) process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone, or never started */
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
