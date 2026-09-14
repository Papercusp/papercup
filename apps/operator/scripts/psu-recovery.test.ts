import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RECOVERY_CAPABILITY_DIAGNOSTIC,
  RECOVERY_DISABLED_REASON,
  executeExactRecoveryCommand,
  hasRecoveryCliFlag,
  issueRecoveryGrant,
  readRecoveryAudit,
  reconcileRecoveryAudit,
  recoveryAuthorizationEligibility,
  recoveryPaths,
  runRecoveryGrant,
  sanitizeRecoveryEnvironment,
  validateRecoveryCliArgv,
} from './psu-recovery.mjs';

const homes: string[] = [];
const TOKEN = 'local-superuser-token-at-least-32-bytes';
const NOW = Date.parse('2026-09-13T20:00:00.000Z');
const TTY = '/dev/pts/77';

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'psu-recovery-'));
  homes.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function grantInput() {
  return {
    capability: RECOVERY_CAPABILITY_DIAGNOSTIC,
    argv: ['printf', '%s', 'operator-offline-ok'],
    cwd: '/tmp',
    reason: 'inspect the operator while its endpoint is unreachable',
    ttlMs: 60_000,
    maxRuntimeMs: 5_000,
  };
}

describe('psu bounded local recovery grant', () => {
  it('keeps recovery a closed pre-passthrough CLI namespace', () => {
    expect(hasRecoveryCliFlag(['--recovery-authorize', '--', 'true'])).toBe(true);
    expect(hasRecoveryCliFlag(['--agent=claude', '--', '--recovery-authorize'])).toBe(false);
    expect(() => validateRecoveryCliArgv([
      '--recovery-authorize', '--recovery-reason=repair', '--connect=remote', '--', 'true',
    ])).toThrow(/non-recovery argument/);
    expect(() => validateRecoveryCliArgv([
      '--recovery-authorize', '--recovery-reason', 'repair', '--recovery-ttl=60', '--', 'true',
    ])).not.toThrow();
  });

  it('hard-disables authorization for every caller shape, including a scrubbed systemd pseudo-TTY', () => {
    for (const candidate of [
      { env: {}, stdinIsTTY: true, stdoutIsTTY: true, ancestorCmdlines: ['/usr/bin/bash'] },
      {
        env: {}, stdinIsTTY: true, stdoutIsTTY: true,
        ancestorCmdlines: ['/usr/lib/systemd/systemd --user'],
      },
      {
        env: { PAPERCUSP_AGENT_SESSION: '1' }, stdinIsTTY: true, stdoutIsTTY: true,
        ancestorCmdlines: ['/usr/bin/bash'],
      },
    ]) {
      expect(recoveryAuthorizationEligibility(candidate)).toEqual({
        ok: false,
        reason: RECOVERY_DISABLED_REASON,
      });
    }
  });

  it('refuses issuance before resolving an executable or creating local recovery state', async () => {
    const h = await home();
    const resolveExecutable = vi.fn(() => '/usr/bin/printf');

    expect(() => issueRecoveryGrant(grantInput(), {
      home: h,
      token: TOKEN,
      nowMs: NOW,
      terminalId: TTY,
      resolveExecutable,
    })).toThrow(RECOVERY_DISABLED_REASON);

    expect(resolveExecutable).not.toHaveBeenCalled();
    await expect(stat(recoveryPaths(h).root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses redemption before reading a grant, consuming it, or executing a command', async () => {
    const h = await home();
    const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false }));

    await expect(runRecoveryGrant('11111111-1111-4111-8111-111111111111', {
      home: h,
      token: TOKEN,
      nowMs: NOW,
      terminalId: TTY,
      execute,
    })).resolves.toEqual({ ok: false, reason: RECOVERY_DISABLED_REASON });

    expect(execute).not.toHaveBeenCalled();
    await expect(stat(recoveryPaths(h).root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('turns a synchronous exact-spawn failure into a bounded result', async () => {
    await expect(executeExactRecoveryCommand({
      file: '/missing', args: [], cwd: '/tmp', env: {}, timeoutMs: 1_000,
    }, {
      spawnImpl: (() => { throw new Error('spawn unavailable'); }) as never,
    })).resolves.toMatchObject({
      exitCode: null, signal: null, timedOut: false, error: 'spawn unavailable',
    });
  });

  it('kills the whole exact-command process group at the hard runtime bound', async () => {
    if (process.platform === 'win32') return;
    const h = await home();
    const marker = join(h, 'descendant-survived');
    const child = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 350); setInterval(() => {}, 1000)`) }], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join('\n');
    const result = await executeExactRecoveryCommand({
      file: process.execPath,
      args: ['-e', child],
      cwd: h,
      env: { PATH: process.env.PATH },
      timeoutMs: 100,
    }, { spawnImpl: spawn });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reconciles only unreconciled append-only rows and checkpoints successful ids', async () => {
    const h = await home();
    const paths = recoveryPaths(h);
    await mkdir(paths.grants, { recursive: true, mode: 0o700 });
    await mkdir(paths.consumed, { recursive: true, mode: 0o700 });
    const event = {
      version: 1,
      eventId: '22222222-2222-4222-8222-222222222222',
      event: 'execution-refused',
      at: new Date(NOW).toISOString(),
      atMs: NOW,
      grantId: '33333333-3333-4333-8333-333333333333',
      capability: RECOVERY_CAPABILITY_DIAGNOSTIC,
      reason: RECOVERY_DISABLED_REASON,
    };
    await writeFile(paths.audit, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    const send = vi.fn(async (rows) => ({ reconciledEventIds: rows.map((row: { eventId: string }) => row.eventId) }));

    expect(await reconcileRecoveryAudit({ home: h, send })).toMatchObject({ ok: true, reconciled: 1, pending: 0 });
    expect(await reconcileRecoveryAudit({ home: h, send })).toMatchObject({ ok: true, reconciled: 0, pending: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const rows = await readRecoveryAudit({ home: h });
    expect(rows.at(-1)).toMatchObject({
      event: 'reconciliation-checkpoint',
      grantId: event.grantId,
      reconciledEventIds: [event.eventId],
    });
  });

  it('strips every recovery and managed-agent identity marker from ordinary environments', () => {
    expect(sanitizeRecoveryEnvironment({
      PATH: '/usr/bin',
      PAPERCUSP_RECOVERY_MODE: '1',
      PAPERCUSP_RECOVERY_GRANT_ID: 'old',
      PAPERCUSP_SID: 'su-old',
      PAPERCUSP_ADV_SESSION_ID: '42',
      PAPERCUSP_AGENT_SESSION: '1',
      PAPERCUSP_FLEET_SLUG: 'fleet',
      PAPERCUSP_AUTO_MODE: '1',
      ANTHROPIC_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
      CODEX_HOME: '/secret/home',
      PI_CONFIG_DIR: '/secret/pi',
    })).toEqual({ PATH: '/usr/bin' });
  });
});
