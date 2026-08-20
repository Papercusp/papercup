/**
 * EI-20110538428919633 regression guard — verdict-cli must preserve a daemon's
 * actionable stderr when startup times out instead of reporting only a generic
 * 15-second deadline. The dependency is patched through patch-package, so this
 * test launches the installed CLI and replaces only the spawned `node` command
 * with a deterministic failing daemon fixture.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

describe('verdict-cli startup diagnostics (EI-20110538428919633)', () => {
  it('includes a failed daemon stderr tail in the startup error', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-startup-error-'));
    const fakeNode = join(fixtureRoot, 'node');
    const dataDir = join(fixtureRoot, 'data');
    const sentinel = "browserType.launch: Executable doesn't exist at /tmp/chromium";

    try {
      await writeFile(
        fakeNode,
        `#!/usr/bin/env bash
printf '%s\\n' "$VERDICT_TEST_SENTINEL" 'Please run: npx playwright install' >&2
exit 1
`,
        'utf8',
      );
      await chmod(fakeNode, 0o755);

      let failure: unknown = null;
      try {
        await execFileAsync(
          process.execPath,
          [require.resolve('verdict-cli/bin/browse.mjs'), 'status'],
          {
            env: {
              ...process.env,
              PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
              VERDICT_DATA_DIR: dataDir,
              VERDICT_START_TIMEOUT_MS: '750',
              VERDICT_TEST_SENTINEL: sentinel,
              VERDICT_SESSION: '',
              PAPERCUSP_SID: '',
              CODEX_SESSION_ID: '',
            },
            maxBuffer: 32 * 1024,
            timeout: 20_000,
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).not.toBeNull();
      const stderr =
        typeof failure === 'object' && failure !== null && 'stderr' in failure
          ? String((failure as { stderr?: unknown }).stderr ?? '')
          : '';
      expect(stderr).toContain('Server failed to start within 750ms');
      expect(stderr).toContain('--- server stderr ---');
      expect(stderr).toContain(sentinel);
      expect(stderr).toContain('npx playwright install');

      const cliSource = await readFile(require.resolve('verdict-cli/bin/browse.mjs'), 'utf8');
      expect(cliSource).toContain(': 30_000;');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 5_000);

  it('isolates Papercusp agent clients by their implicit session identity', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-session-isolation-'));
    const fakeNode = join(fixtureRoot, 'node');
    const dataDir = join(fixtureRoot, 'data');
    const daemonPids: number[] = [];

    try {
      await writeFile(
        fakeNode,
        `#!${process.execPath}
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const dataDir = process.env.VERDICT_DATA_DIR;
const session = process.env.VERDICT_SESSION || '';
const stateDir = session ? resolve(dataDir, 'sessions', session) : dataDir;
const server = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  res.writeHead(200);
  res.end('session=' + session);
});
server.listen(0, '127.0.0.1', () => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(resolve(stateDir, 'verdict.json'), JSON.stringify({
    port: server.address().port,
    token: 'fixture-token',
    pid: process.pid,
    started: new Date().toISOString(),
  }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
        'utf8',
      );
      await chmod(fakeNode, 0o755);

      const run = (sid: string) =>
        execFileAsync(process.execPath, [require.resolve('verdict-cli/bin/browse.mjs'), 'status'], {
          env: {
            ...process.env,
            PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
            VERDICT_DATA_DIR: dataDir,
            VERDICT_SESSION: '',
            PAPERCUSP_SID: sid,
            CODEX_SESSION_ID: '',
            VERDICT_START_TIMEOUT_MS: '3000',
          },
          maxBuffer: 32 * 1024,
          timeout: 8_000,
        });

      const [agentA, agentB] = await Promise.all([run('agent-a'), run('agent-b')]);
      expect(agentA.stdout).toContain('session=agent-a');
      expect(agentB.stdout).toContain('session=agent-b');

      const agentAState = JSON.parse(
        await readFile(join(dataDir, 'sessions', 'agent-a', 'verdict.json'), 'utf8'),
      ) as { pid: number };
      const agentBState = JSON.parse(
        await readFile(join(dataDir, 'sessions', 'agent-b', 'verdict.json'), 'utf8'),
      ) as { pid: number };
      daemonPids.push(agentAState.pid, agentBState.pid);
      expect(agentAState.pid).not.toBe(agentBState.pid);
      await expect(readFile(join(dataDir, 'verdict.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      for (const sid of ['agent-a', 'agent-b']) {
        try {
          const state = JSON.parse(
            await readFile(join(dataDir, 'sessions', sid, 'verdict.json'), 'utf8'),
          ) as { pid: number };
          daemonPids.push(state.pid);
        } catch {
          // The fixture may have failed before it wrote its state file.
        }
      }
      for (const pid of new Set(daemonPids)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // The fixture daemon may already have exited during test teardown.
        }
      }
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 12_000);

  it('exits after a successful first command while the detached daemon stays alive', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-startup-unref-'));
    const fakeNode = join(fixtureRoot, 'node');
    const dataDir = join(fixtureRoot, 'data');
    let daemonPid: number | null = null;

    try {
      await writeFile(
        fakeNode,
        `#!${process.execPath}
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const dataDir = process.env.VERDICT_DATA_DIR;
const token = 'fixture-token';
const server = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  res.writeHead(200);
  res.end('fixture-ready');
});
server.listen(0, '127.0.0.1', () => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(resolve(dataDir, 'verdict.json'), JSON.stringify({
    port: server.address().port,
    token,
    pid: process.pid,
    started: new Date().toISOString(),
  }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
        'utf8',
      );
      await chmod(fakeNode, 0o755);

      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [require.resolve('verdict-cli/bin/browse.mjs'), 'status'],
        {
          env: {
            ...process.env,
            PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
            VERDICT_DATA_DIR: dataDir,
            VERDICT_START_TIMEOUT_MS: '3000',
            VERDICT_SESSION: '',
            PAPERCUSP_SID: '',
            CODEX_SESSION_ID: '',
          },
          maxBuffer: 32 * 1024,
          timeout: 5_000,
        },
      );

      expect(stdout).toContain('fixture-ready');
      expect(stderr).toContain('Server ready');
      const state = JSON.parse(await readFile(join(dataDir, 'verdict.json'), 'utf8')) as {
        pid: number;
      };
      daemonPid = state.pid;
      expect(() => process.kill(state.pid, 0)).not.toThrow();
    } finally {
      if (daemonPid !== null) {
        try {
          process.kill(daemonPid, 'SIGTERM');
        } catch {
          // The fixture daemon may already have exited during test teardown.
        }
      }
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 8_000);
});
