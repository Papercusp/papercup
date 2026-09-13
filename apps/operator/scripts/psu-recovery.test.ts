import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_RECOVERY_RUNTIME_MS,
  MAX_RECOVERY_TTL_MS,
  RECOVERY_CAPABILITY_DIAGNOSTIC,
  type RecoveryExecutionSpec,
  executeExactRecoveryCommand,
  hasRecoveryCliFlag,
  issueRecoveryGrant,
  readRecoveryAudit,
  reconcileRecoveryAudit,
  recoveryAuthorizationEligibility,
  recoveryPaths,
  renderRecoveryBanner,
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

const identity = { uid: 1000, username: 'avi', hostname: 'workstation' };

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

  it('requires a real terminal and refuses inherited agent identity before authorization', () => {
    expect(recoveryAuthorizationEligibility({
      env: {}, stdinIsTTY: true, stdoutIsTTY: true, ancestorCmdlines: ['/usr/bin/bash'],
    })).toEqual({ ok: true });

    expect(recoveryAuthorizationEligibility({
      env: { PAPERCUSP_AGENT_SESSION: '1' }, stdinIsTTY: true, stdoutIsTTY: true,
      ancestorCmdlines: ['/usr/bin/bash'],
    })).toMatchObject({ ok: false, reason: 'inherited-agent-identity' });

    expect(recoveryAuthorizationEligibility({
      env: {}, stdinIsTTY: true, stdoutIsTTY: true,
      ancestorCmdlines: ['/usr/bin/node /repo/apps/operator/scripts/psu-pty-host.mjs'],
    })).toMatchObject({ ok: false, reason: 'agent-process-ancestor' });

    expect(recoveryAuthorizationEligibility({
      env: {}, stdinIsTTY: false, stdoutIsTTY: true, ancestorCmdlines: ['/usr/bin/bash'],
    })).toMatchObject({ ok: false, reason: 'interactive-terminal-required' });

    expect(recoveryAuthorizationEligibility({
      env: {}, stdinIsTTY: true, stdoutIsTTY: true, ancestorCmdlines: null,
    })).toMatchObject({ ok: false, reason: 'ancestor-scan-unavailable' });
  });

  it('issues an owner-only signed grant with absolute executable, exact argv and hard bounds', async () => {
    const h = await home();
    const grant = issueRecoveryGrant(grantInput(), {
      home: h,
      token: TOKEN,
      nowMs: NOW,
      terminalId: TTY,
      identity,
      clientVersion: '1.2.3',
      resolveExecutable: () => '/usr/bin/printf',
    });

    expect(grant).toMatchObject({
      version: 1,
      capability: RECOVERY_CAPABILITY_DIAGNOSTIC,
      argv: ['/usr/bin/printf', '%s', 'operator-offline-ok'],
      cwd: '/tmp',
      issuedAtMs: NOW,
      expiresAtMs: NOW + 60_000,
      maxRuntimeMs: 5_000,
      maxUses: 1,
      terminalId: TTY,
      identity,
      client: { name: 'psu', version: '1.2.3' },
    });
    expect(grant.signature).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const paths = recoveryPaths(h);
    expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(paths.grants, `${grant.grantId}.json`))).mode & 0o777).toBe(0o600);
    expect((await stat(paths.audit)).mode & 0o777).toBe(0o600);
    const audit = await readRecoveryAudit({ home: h });
    expect(audit[0]).toMatchObject({
      event: 'authorized', grantId: grant.grantId, capability: RECOVERY_CAPABILITY_DIAGNOSTIC,
      identity, client: { name: 'psu', version: '1.2.3' }, reason: grant.reason,
    });
  });

  it('consumes once, preserves argv boundaries, sets a visible marker and records start/finish', async () => {
    const h = await home();
    const grant = issueRecoveryGrant(grantInput(), {
      home: h, token: TOKEN, nowMs: NOW, terminalId: TTY, identity,
      resolveExecutable: () => '/usr/bin/printf',
    });
    const execute = vi.fn(async (_spec: RecoveryExecutionSpec) => ({
      exitCode: 0, signal: null, timedOut: false,
    }));
    const banners: string[] = [];

    const result = await runRecoveryGrant(grant.grantId, {
      home: h,
      token: TOKEN,
      nowMs: NOW + 1,
      terminalId: TTY,
      baseEnv: { PATH: '/usr/bin', PAPERCUSP_SID: 'must-not-leak', OPENAI_API_KEY: 'secret' },
      execute,
      writeBanner: (line) => banners.push(line),
    });

    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(execute).toHaveBeenCalledTimes(1);
    const execution = execute.mock.calls[0]![0];
    expect(execution).toMatchObject({
      file: '/usr/bin/printf',
      args: ['%s', 'operator-offline-ok'],
      cwd: '/tmp',
      timeoutMs: 5_000,
      env: {
        PATH: '/usr/bin',
        PAPERCUSP_RECOVERY_MODE: '1',
        PAPERCUSP_RECOVERY_GRANT_ID: grant.grantId,
        PAPERCUSP_RECOVERY_CAPABILITY: RECOVERY_CAPABILITY_DIAGNOSTIC,
      },
    });
    expect(execution.env).not.toHaveProperty('PAPERCUSP_SID');
    expect(execution.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(banners.join('\n')).toContain('NATIVE RECOVERY MODE');
    expect(banners.join('\n')).toContain(grant.grantId);
    expect(renderRecoveryBanner(grant)).toContain('CONTROL PLANE BYPASSED');

    const replay = await runRecoveryGrant(grant.grantId, {
      home: h, token: TOKEN, nowMs: NOW + 2, terminalId: TTY, execute,
    });
    expect(replay).toMatchObject({ ok: false, reason: 'already-consumed' });
    expect(execute).toHaveBeenCalledTimes(1);

    const events = (await readRecoveryAudit({ home: h })).map((row) => row.event);
    expect(events).toEqual(['authorized', 'execution-started', 'execution-finished', 'execution-refused']);
  });

  it('fails closed on tamper, terminal substitution and expiry before execution', async () => {
    for (const scenario of ['tamper', 'terminal', 'expiry'] as const) {
      const h = await home();
      const grant = issueRecoveryGrant(grantInput(), {
        home: h, token: TOKEN, nowMs: NOW, terminalId: TTY, identity,
        resolveExecutable: () => '/usr/bin/printf',
      });
      if (scenario === 'tamper') {
        const path = join(recoveryPaths(h).grants, `${grant.grantId}.json`);
        const raw = JSON.parse(await readFile(path, 'utf8'));
        raw.reason = 'substituted';
        await writeFile(path, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
      }
      const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false }));
      const result = await runRecoveryGrant(grant.grantId, {
        home: h,
        token: TOKEN,
        nowMs: scenario === 'expiry' ? grant.expiresAtMs : NOW + 1,
        terminalId: scenario === 'terminal' ? '/dev/pts/88' : TTY,
        execute,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: scenario === 'tamper' ? 'bad-signature' : scenario === 'terminal' ? 'terminal-mismatch' : 'expired',
      });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('rejects unbounded authorization inputs instead of silently clamping them', async () => {
    const h = await home();
    for (const patch of [
      { ttlMs: MAX_RECOVERY_TTL_MS + 1 },
      { maxRuntimeMs: MAX_RECOVERY_RUNTIME_MS + 1 },
      { ttlMs: 1_000, maxRuntimeMs: 2_000 },
      { argv: [] },
      { reason: ' ' },
    ]) {
      expect(() => issueRecoveryGrant({ ...grantInput(), ...patch }, {
        home: h, token: TOKEN, nowMs: NOW, terminalId: TTY, identity,
        resolveExecutable: () => '/usr/bin/printf',
      })).toThrow();
    }
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
    });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows only one concurrent claimant to execute a one-use grant', async () => {
    const h = await home();
    const grant = issueRecoveryGrant(grantInput(), {
      home: h, token: TOKEN, nowMs: NOW, terminalId: TTY, identity,
      resolveExecutable: () => '/usr/bin/printf',
    });
    const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false }));
    const results = await Promise.all([
      runRecoveryGrant(grant.grantId, {
        home: h, token: TOKEN, nowMs: NOW + 1, terminalId: TTY, execute, writeBanner: () => {},
      }),
      runRecoveryGrant(grant.grantId, {
        home: h, token: TOKEN, nowMs: NOW + 1, terminalId: TTY, execute, writeBanner: () => {},
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ reason: 'already-consumed' }),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a symlinked audit target and leaves no executable grant behind', async () => {
    const h = await home();
    const paths = recoveryPaths(h);
    await mkdir(paths.grants, { recursive: true, mode: 0o700 });
    await mkdir(paths.consumed, { recursive: true, mode: 0o700 });
    const target = join(h, 'audit-target');
    await writeFile(target, 'do-not-touch\n');
    await symlink(target, paths.audit);
    expect(() => issueRecoveryGrant(grantInput(), {
      home: h, token: TOKEN, nowMs: NOW, terminalId: TTY, identity,
      grantId: '44444444-4444-4444-8444-444444444444',
      resolveExecutable: () => '/usr/bin/printf',
    })).toThrow();
    await expect(readFile(join(paths.grants, '44444444-4444-4444-8444-444444444444.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(target, 'utf8')).toBe('do-not-touch\n');
  });

  it('reconciles only unreconciled append-only rows and checkpoints successful ids', async () => {
    const h = await home();
    const grant = issueRecoveryGrant(grantInput(), {
      home: h, token: TOKEN, nowMs: NOW, terminalId: TTY, identity,
      resolveExecutable: () => '/usr/bin/printf',
    });
    const send = vi.fn(async (rows) => ({ reconciledEventIds: rows.map((row: { eventId: string }) => row.eventId) }));

    expect(await reconcileRecoveryAudit({ home: h, send })).toMatchObject({ ok: true, reconciled: 1, pending: 0 });
    expect(await reconcileRecoveryAudit({ home: h, send })).toMatchObject({ ok: true, reconciled: 0, pending: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const rows = await readRecoveryAudit({ home: h });
    expect(rows.at(-1)).toMatchObject({ event: 'reconciliation-checkpoint', grantId: grant.grantId });
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
