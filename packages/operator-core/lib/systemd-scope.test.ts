import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { SELF_IDENTIFYING_SECRET_PATTERN } from './sensitive-text';
import { createTextCollector } from './child-output';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildIsolatedScopeArgv,
  buildTaskScopeArgv,
  buildTaskScopeArgvWithTransport,
  buildTaskServiceArgv,
  createSecretEnvironmentTransport,
  escapeSystemdServiceArgument,
  SYSTEMD_ENV_RUNNER_PATH,
  TASK_DEADLINE_EPOCH_MS_ENV,
  taskDeadlineEnv,
  userManagerBusReachable,
} from './systemd-scope';
import {
  isDirectSystemdScopeEnvRunnerInvocation,
  SYSTEMD_RUNNER_JOB_END_PREFIX,
  SYSTEMD_RUNNER_OUTPUT_PATH_ENV,
  SYSTEMD_RUNNER_REDACTIONS_ENV,
} from './systemd-scope-env-runner.mjs';

describe('userManagerBusReachable — can `systemd-run --user` reach a user manager (WI-10003189)', () => {
  // A path set standing in for the filesystem, so no case depends on the box's real
  // /run/user state (the class of flake WI-6960 was about).
  const fs = (...present: string[]) => (p: string) => present.includes(p);

  it('is false with neither XDG_RUNTIME_DIR nor DBUS_SESSION_BUS_ADDRESS — the hosted-operator case systemd reports as "No medium found"', () => {
    expect(userManagerBusReachable({}, fs('/run/user/1000/systemd/private', '/run/user/1000/bus'))).toBe(false);
    expect(userManagerBusReachable({ XDG_RUNTIME_DIR: '  ', DBUS_SESSION_BUS_ADDRESS: '' }, fs())).toBe(false);
  });

  it("is true when the runtime dir holds the manager's private socket or the user bus socket", () => {
    expect(userManagerBusReachable({ XDG_RUNTIME_DIR: '/run/user/1000' }, fs('/run/user/1000/systemd/private'))).toBe(
      true,
    );
    expect(userManagerBusReachable({ XDG_RUNTIME_DIR: '/run/user/1000' }, fs('/run/user/1000/bus'))).toBe(true);
  });

  it('is false when XDG_RUNTIME_DIR is set but no user manager socket exists and no session bus is named', () => {
    expect(userManagerBusReachable({ XDG_RUNTIME_DIR: '/run/user/999' }, fs())).toBe(false);
  });

  it('falls back to a unix:path session bus address, checking that its socket exists', () => {
    const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus-sock,guid=abc' };
    expect(userManagerBusReachable(env, fs('/tmp/dbus-sock'))).toBe(true);
    expect(userManagerBusReachable(env, fs())).toBe(false);
    // An address whose unix: entry carries other keys before path= still resolves.
    expect(
      userManagerBusReachable({ DBUS_SESSION_BUS_ADDRESS: 'tcp:host=x;unix:guid=g,path=/tmp/s2' }, fs('/tmp/s2')),
    ).toBe(true);
  });

  it('defers a non-stat-able session address (abstract socket) to systemd rather than refusing it', () => {
    expect(userManagerBusReachable({ DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-XYZ' }, fs())).toBe(true);
  });
});

describe('systemd scope environment runner entrypoint', () => {
  it('executes only the copied runner basename, never an importing host bundle', () => {
    expect(isDirectSystemdScopeEnvRunnerInvocation('/tmp/dist-host/systemd-scope-env-runner.mjs')).toBe(true);
    expect(isDirectSystemdScopeEnvRunnerInvocation('/tmp/dist-host/hono-host.mjs')).toBe(false);
    expect(isDirectSystemdScopeEnvRunnerInvocation('/tmp/serve.mjs')).toBe(false);
  });
});

const PROPS = { unit: 'papercusp-bash-job-test.service', slice: 'papercusp-bash-job.slice' };

describe('transient service payload escaping', () => {
  it('escapes dollars for systemd while preserving Bash parameter expansions', () => {
    const command = 'false | cat; printf "PS0=[${PIPESTATUS[0]}] PID=[$$]\\n"';
    const argv = buildTaskServiceArgv(['/bin/bash', '-o', 'pipefail', '-c', command], PROPS);

    expect(argv.at(-1)).toBe(escapeSystemdServiceArgument(command));
    expect(argv.at(-1)).toContain('$${PIPESTATUS[0]}');
    expect(argv.at(-1)).toContain('[$$$$]');
    expect(argv.at(-1)).not.toBe(command);
  });

  it('leaves transient scope payloads byte-for-byte unchanged', () => {
    const command = 'printf "%s" "${PIPESTATUS[0]} $$"';
    const argv = buildTaskScopeArgv(['/bin/bash', '-c', command], {
      unit: 'papercusp-bash-job-test.scope',
      slice: 'papercusp-bash-job.slice',
    });

    expect(argv.at(-1)).toBe(command);
  });

  it('retains failed task units for the ledger writer while preserving collection by default', () => {
    const retained = buildTaskServiceArgv(['/bin/false'], {
      ...PROPS,
      collectFailedUnit: false,
    });
    expect(retained).not.toContain('--collect');
    expect(retained).not.toContain('--property=CollectMode=inactive-or-failed');

    const ordinary = buildTaskServiceArgv(['/bin/false'], PROPS);
    expect(ordinary).toContain('--collect');
    expect(ordinary).toContain('--property=CollectMode=inactive-or-failed');
  });

  it('enables systemd memory accounting whenever a task carries MemoryMax', () => {
    const argv = buildTaskServiceArgv(['/bin/false'], {
      ...PROPS,
      memoryMaxBytes: 32 * 1024 * 1024,
    });
    expect(argv).toContain('--property=MemoryAccounting=yes');
    expect(argv).toContain(`--property=MemoryMax=${32 * 1024 * 1024}`);
  });

  it('defaults memory-capped worker scopes to swap allowed; deny remains explicit', () => {
    const worker = buildIsolatedScopeArgv(['/bin/false'], 6);
    expect(worker).toContain('--property=MemoryMax=6G');
    expect(worker).not.toContain('--property=MemorySwapMax=0');

    const protectedOrchestrator = buildIsolatedScopeArgv(['/bin/false'], 6, 'deny');
    expect(protectedOrchestrator).toContain('--property=MemorySwapMax=0');
  });

  it('publishes an ABSOLUTE deadline, and nothing at all when the task is unbounded', () => {
    expect(taskDeadlineEnv(600, 1_000_000)).toEqual({ [TASK_DEADLINE_EPOCH_MS_ENV]: '1600000' });
    // Absent is the honest answer for an unbounded task: a reader can tell "no deadline was
    // set" from "a deadline I have not reached" only while this stays empty.
    expect(taskDeadlineEnv(null)).toEqual({});
    expect(taskDeadlineEnv(0)).toEqual({});
    expect(taskDeadlineEnv(-5)).toEqual({});
    expect(taskDeadlineEnv(Number.POSITIVE_INFINITY)).toEqual({});
    expect(taskDeadlineEnv(Number.NaN)).toEqual({});
  });

  it('folds the deadline into an exact-env payload without displacing the caller env', () => {
    const before = Date.now();
    const built = buildTaskScopeArgvWithTransport(['/bin/false'], {
      unit: 'papercusp-bash-job-test.scope',
      slice: 'papercusp-bash-job.slice',
      env: { PATH: '/usr/bin', CALLER_KEEPS_THIS: 'yes' },
      runtimeMaxSec: 90,
    });
    try {
      const records = readFileSync(built.transport!.sourcePath, 'utf8').split('\0').filter(Boolean);
      expect(records).toContain('PATH=/usr/bin');
      expect(records).toContain('CALLER_KEEPS_THIS=yes');
      const deadline = records.find((r) => r.startsWith(`${TASK_DEADLINE_EPOCH_MS_ENV}=`));
      const epochMs = Number(deadline?.split('=')[1]);
      expect(epochMs).toBeGreaterThanOrEqual(before + 90_000);
      expect(epochMs).toBeLessThanOrEqual(Date.now() + 90_000);
    } finally {
      built.transport?.release();
    }
  });

  it('reaches an envless SERVICE through --setenv, and never puts one on a --scope', () => {
    const props = { ...PROPS, runtimeMaxSec: 120 };
    const service = buildTaskServiceArgv(['/bin/false'], props);
    const setenv = service.filter((arg) => arg.startsWith('--setenv='));
    expect(setenv).toHaveLength(1);
    expect(setenv[0]).toMatch(new RegExp(`^--setenv=${TASK_DEADLINE_EPOCH_MS_ENV}=\\d+$`));

    // A `--scope` payload is forked from the systemd-run client, so `--setenv` is not the
    // seam that reaches it — and a flag this launcher rejected would fail EVERY confined
    // spawn on the host. The scope path is covered at its launch site (managed-spawn.ts).
    const scope = buildTaskScopeArgv(['/bin/false'], {
      unit: 'papercusp-bash-job-test.scope',
      slice: 'papercusp-bash-job.slice',
      runtimeMaxSec: 120,
    });
    expect(scope.filter((arg) => arg.startsWith('--setenv='))).toEqual([]);
    expect(scope).toContain('--property=RuntimeMaxSec=120');
    expect(scope.at(-1)).toBe('/bin/false');

    // An unbounded task publishes nothing on either shape.
    expect(buildTaskServiceArgv(['/bin/false'], PROPS).filter((a) => a.startsWith('--setenv='))).toEqual([]);
  });

  it('keeps a redacted file-backed service log after the live pipe reader disappears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'systemd-runner-output-'));
    const logPath = join(dir, 'durable.log');
    const secret = 'runner-reader-loss-secret-0123456789';
    const transport = createSecretEnvironmentTransport({
      PATH: process.env.PATH,
      RUNNER_TEST_SECRET: secret,
      [SYSTEMD_RUNNER_OUTPUT_PATH_ENV]: logPath,
      [SYSTEMD_RUNNER_REDACTIONS_ENV]: Buffer.from(JSON.stringify([secret]), 'utf8').toString('base64'),
    });
    const script =
      `process.stdout.write('first:' + process.env.RUNNER_TEST_SECRET + '\\n');` +
      `setTimeout(() => process.stdout.write('second:' + process.env.RUNNER_TEST_SECRET + ` +
      `' internal=' + (process.env.${SYSTEMD_RUNNER_OUTPUT_PATH_ENV} || 'none') + '\\n'), 150);`;
    const child = spawn(
      process.execPath,
      [SYSTEMD_ENV_RUNNER_PATH, '--env-fd-path', transport.sourcePath, '--', process.execPath, '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('runner did not produce its first mirrored chunk')), 5_000);
        child.stdout?.once('data', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      // Simulate the operator/systemd-run client disappearing. The runner's
      // stdout/stderr mirrors lose their readers, while its file sink remains.
      child.stdout?.destroy();
      child.stderr?.destroy();
      const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];

      expect({ code, signal }).toEqual({ code: 0, signal: null });
      const output = readFileSync(logPath, 'utf8');
      expect(output).toContain('first:[REDACTED integration credential]');
      expect(output).toContain('second:[REDACTED integration credential] internal=none');
      expect(output).toContain(`${SYSTEMD_RUNNER_JOB_END_PREFIX}: status=completed exit=0`);
      expect(output).not.toContain(secret);
    } finally {
      transport.release();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('redacts an unbound credential SHAPE split across runner chunks in its 0600 durable log (WI-10003538)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'systemd-runner-shape-'));
    const logPath = join(dir, 'durable.log');
    // Assembled at runtime so this file never carries a secret-shaped literal.
    const fake = ['gh', 'p_', 'R'.repeat(36)].join('');
    const transport = createSecretEnvironmentTransport({
      PATH: process.env.PATH,
      RUNNER_SHAPE: fake,
      [SYSTEMD_RUNNER_OUTPUT_PATH_ENV]: logPath,
      [SYSTEMD_RUNNER_REDACTIONS_ENV]: Buffer.from(
        JSON.stringify({ values: [], patterns: [SELF_IDENTIFYING_SECRET_PATTERN] }),
        'utf8',
      ).toString('base64'),
    });
    // The token straddles two separate writes, so two distinct `data` events.
    const script =
      `const t = process.env.RUNNER_SHAPE; process.stdout.write('tok=' + t.slice(0, 9));` +
      `setTimeout(() => process.stdout.write(t.slice(9) + ' end\\n'), 150);`;
    const child = spawn(
      process.execPath,
      [SYSTEMD_ENV_RUNNER_PATH, '--env-fd-path', transport.sourcePath, '--', process.execPath, '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let mirrored = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      mirrored += chunk.toString('utf8');
    });

    try {
      const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];

      expect({ code, signal }).toEqual({ code: 0, signal: null });
      const output = readFileSync(logPath, 'utf8');
      expect(output).toContain('tok=[redacted] end');
      expect(mirrored).toContain('tok=[redacted] end');
      expect(output).not.toContain(fake.slice(0, 9));
      expect(mirrored).not.toContain(fake.slice(0, 9));
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      transport.release();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('preserves a UTF-8 code point split across runner stdout chunks in both sinks (WI-972553)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'systemd-runner-utf8-'));
    const logPath = join(dir, 'durable.log');
    const transport = createSecretEnvironmentTransport({
      PATH: process.env.PATH,
      [SYSTEMD_RUNNER_OUTPUT_PATH_ENV]: logPath,
      [SYSTEMD_RUNNER_REDACTIONS_ENV]: Buffer.from(JSON.stringify([]), 'utf8').toString('base64'),
    });
    // The four bytes of U+1F600 deliberately straddle two `data` events. Decoding
    // each chunk in isolation yields one U+FFFD per orphaned byte instead.
    const script =
      `process.stdout.write(Buffer.from([0xf0]));` +
      `setTimeout(() => process.stdout.write(Buffer.from([0x9f, 0x98, 0x80])), 150);`;
    const child = spawn(
      process.execPath,
      [SYSTEMD_ENV_RUNNER_PATH, '--env-fd-path', transport.sourcePath, '--', process.execPath, '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const mirrored: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => mirrored.push(Buffer.from(chunk)));

    try {
      const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
      expect({ code, signal }).toEqual({ code: 0, signal: null });

      // Corruption committed in the runner reaches BOTH sinks, and the operator's
      // own decoder downstream cannot recover it — so assert both here.
      const durable = readFileSync(logPath, 'utf8');
      expect(durable).toContain('😀');
      expect(durable).not.toContain('�');

      const mirror = Buffer.concat(mirrored).toString('utf8');
      expect(mirror).toContain('😀');
      expect(mirror).not.toContain('�');
    } finally {
      transport.release();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
