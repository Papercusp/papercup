/**
 * EI-20110538428919633 regression guard — verdict-cli must preserve a daemon's
 * actionable stderr when startup times out instead of reporting only a generic
 * 15-second deadline. The dependency is patched through patch-package, so this
 * test launches the installed CLI and replaces only the spawned `node` command
 * with a deterministic failing daemon fixture.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
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

  it('reports a normal stop when a named session closes its response socket', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-session-stop-'));
    const dataDir = join(fixtureRoot, 'data');
    const sessionName = 'socket-close';
    let requestCount = 0;
    const server = createServer((req) => {
      requestCount += 1;
      req.resume();
      req.once('end', () => req.socket.destroy());
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
      await mkdir(join(dataDir, 'sessions', sessionName), { recursive: true });
      await writeFile(
        join(dataDir, 'sessions', sessionName, 'verdict.json'),
        JSON.stringify({
          port: address.port,
          token: 'fixture-token',
          pid: process.pid,
          started: new Date().toISOString(),
        }),
        'utf8',
      );

      const { stdout } = await execFileAsync(
        process.execPath,
        [require.resolve('verdict-cli/bin/browse.mjs'), 'sessions', 'stop', sessionName],
        {
          env: {
            ...process.env,
            VERDICT_DATA_DIR: dataDir,
            VERDICT_SESSION: '',
            PAPERCUSP_SID: '',
            CODEX_SESSION_ID: '',
          },
          maxBuffer: 32 * 1024,
          timeout: 8_000,
        },
      );

      expect(stdout).toBe(`Session "${sessionName}" stopped.\n`);
      expect(stdout).not.toContain('was not responding');
      expect(requestCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 8_000);

  it('clears console evidence when the active page navigates', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-navigation-evidence-'));
    const dataDir = join(fixtureRoot, 'data');
    const env = {
      ...process.env,
      VERDICT_DATA_DIR: dataDir,
      VERDICT_SESSION: 'navigation-evidence',
      PAPERCUSP_SID: '',
      CODEX_SESSION_ID: '',
      VERDICT_START_TIMEOUT_MS: '5000',
      VERDICT_IDLE_TIMEOUT: '60000',
    };
    const run = (command: string, ...args: string[]) =>
      execFileAsync(process.execPath, [require.resolve('verdict-cli/bin/browse.mjs'), command, ...args], {
        env,
        maxBuffer: 32 * 1024,
        timeout: 12_000,
      });

    try {
      await run('goto', 'data:text/html,<script>console.log("NAV-A-CONSOLE")</script><body>A</body>');
      await run('goto', 'data:text/html,<script>console.log("NAV-B-CONSOLE")</script><body>B</body>');
      const { stdout } = await run('console');

      expect(stdout).not.toContain('NAV-A-CONSOLE');
      expect(stdout).toContain('NAV-B-CONSOLE');
    } finally {
      await run('stop').catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);

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
