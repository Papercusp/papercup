/**
 * EI-22200064677663549 regression guard — verdict-cli must refuse to navigate
 * to the Papercusp operator UI's own dev ports (:3055/:3070/:3170) BEFORE ever
 * contacting or spawning the daemon.
 *
 * Why this can't be caught at the Claude-hook layer: CLAUDE.md documents that
 * the operator UI only renders inside Tauri and that verdict/browsers must
 * never point at it, and Papercusp's guard-operator-desktop.mjs PreToolUse
 * hook enforces that — but ONLY for a `Skill` tool_input shape
 * (`{tool_name:'Skill', tool_input:{skill:'verdict', args:{url}}}`). Real
 * verdict invocations are plain Bash commands (SKILL.md declares
 * `allowed-tools: Bash(verdict*)`), a shape that hook's matcher deliberately
 * excludes. So the CLI itself has to refuse, client-side, before ever
 * contacting the daemon — navigating there wedges the shared daemon (no Tauri
 * IPC bridge, so the SPA never settles): `goto` never returns, and every
 * later command in the same session times out too, until `stop`+restart.
 *
 * This suite proves the refusal is: (a) unconditional across goto /
 * goto-auth / newtab / a chain step, (b) PRE-DAEMON — the daemon process is
 * never even spawned, not merely that its state file never gets written, and
 * (c) does not over-match a non-operator target (calibration).
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

const REFUSAL_SNIPPET = "are the Papercusp operator UI's own";

/**
 * A fake `node` that proves whether the daemon was ever spawned: it writes a
 * marker file the INSTANT it starts — before doing anything else — then
 * behaves like a normal daemon (writes verdict.json, answers any command with
 * 200). If the CLI's refusal fires pre-daemon as intended, `spawn('node', ...)`
 * is never called at all, so this script never runs and the marker can never
 * appear. This is a stronger proof than checking verdict.json alone, which
 * could in principle be absent for other reasons (a slow-starting daemon).
 */
function fakeDaemonNodeScript(markerFile: string): string {
  return `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, String(process.pid));
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const dataDir = process.env.VERDICT_DATA_DIR;
const session = process.env.VERDICT_SESSION || '';
const stateDir = session ? resolve(dataDir, 'sessions', session) : dataDir;
const server = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  res.writeHead(200);
  res.end('ok');
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
`;
}

async function makeFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-operator-port-guard-'));
  const fakeNode = join(fixtureRoot, 'node');
  const dataDir = join(fixtureRoot, 'data');
  const markerFile = join(fixtureRoot, 'daemon-was-spawned.marker');
  await writeFile(fakeNode, fakeDaemonNodeScript(markerFile), 'utf8');
  await chmod(fakeNode, 0o755);
  return { fixtureRoot, dataDir, markerFile };
}

function runCli(fixtureRoot: string, dataDir: string, sessionName: string, cliArgs: string[]) {
  return execFileAsync(
    process.execPath,
    [require.resolve('verdict-cli/bin/browse.mjs'), ...cliArgs],
    {
      env: {
        ...process.env,
        PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
        VERDICT_DATA_DIR: dataDir,
        VERDICT_SESSION: sessionName,
        PAPERCUSP_SID: '',
        CODEX_SESSION_ID: '',
        VERDICT_START_TIMEOUT_MS: '3000',
      },
      maxBuffer: 32 * 1024,
      timeout: 8_000,
    },
  );
}

async function expectRefusedPreDaemon(
  fixtureRoot: string,
  dataDir: string,
  markerFile: string,
  sessionName: string,
  cliArgs: string[],
) {
  let failure: unknown = null;
  try {
    await runCli(fixtureRoot, dataDir, sessionName, cliArgs);
  } catch (error) {
    failure = error;
  }
  expect(failure).not.toBeNull();
  const err = failure as { code?: number; stderr?: unknown };
  expect(err.code).not.toBe(0);
  const stderr = String(err.stderr ?? '');
  expect(stderr).toContain(REFUSAL_SNIPPET);
  // Pre-daemon: the fake daemon process must NEVER have been spawned, and
  // must never have written its state file.
  await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(dataDir, 'verdict.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    readFile(join(dataDir, 'sessions', sessionName, 'verdict.json'), 'utf8'),
  ).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('verdict-cli operator-UI port guard (EI-22200064677663549)', () => {
  it('refuses `goto` at :3070 (localhost)', async () => {
    const { fixtureRoot, dataDir, markerFile } = await makeFixture();
    try {
      await expectRefusedPreDaemon(fixtureRoot, dataDir, markerFile, 'guard-goto-3070', [
        'goto',
        'http://localhost:3070/steering',
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 8_000);

  it('refuses `goto-auth` at :3055 (127.0.0.1)', async () => {
    const { fixtureRoot, dataDir, markerFile } = await makeFixture();
    try {
      await expectRefusedPreDaemon(fixtureRoot, dataDir, markerFile, 'guard-goto-auth-3055', [
        'goto-auth',
        'http://127.0.0.1:3055/x',
        '--profile',
        'default',
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 8_000);

  it('refuses `newtab` at :3170 (0.0.0.0) — the staging port the guard-gap issue was filed about', async () => {
    const { fixtureRoot, dataDir, markerFile } = await makeFixture();
    try {
      await expectRefusedPreDaemon(fixtureRoot, dataDir, markerFile, 'guard-newtab-3170', [
        'newtab',
        'http://0.0.0.0:3170/',
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 8_000);

  it('refuses a `chain` step whose goto target is an operator port', async () => {
    const { fixtureRoot, dataDir, markerFile } = await makeFixture();
    try {
      await expectRefusedPreDaemon(fixtureRoot, dataDir, markerFile, 'guard-chain-3170', [
        'chain',
        JSON.stringify([['goto', 'http://localhost:3170/portal-panes/steering']]),
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 8_000);

  it('does not over-match a non-operator target (calibration)', async () => {
    // localhost:30701 deliberately shares a 4-digit PREFIX with :3070 but is a
    // different port; the regex's trailing \b must not treat it as a match.
    // Proves the negative results above are the guard working, not the guard
    // over-matching everything and these assertions passing vacuously.
    const { fixtureRoot, dataDir, markerFile } = await makeFixture();
    try {
      const { stdout, stderr } = await runCli(fixtureRoot, dataDir, 'guard-calibration', [
        'goto',
        'http://localhost:30701/ok',
      ]);
      expect(stderr).not.toContain(REFUSAL_SNIPPET);
      expect(stdout).toContain('ok');
      // The fake daemon DID get spawned this time — proves the calibration
      // target genuinely reached the normal (non-refused) code path.
      await expect(readFile(markerFile, 'utf8')).resolves.toMatch(/^\d+$/);
    } finally {
      await runCli(fixtureRoot, dataDir, 'guard-calibration', ['stop']).catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 8_000);
});
