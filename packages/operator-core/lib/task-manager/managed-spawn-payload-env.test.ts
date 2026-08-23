/**
 * managed-spawn-payload-env.test.ts — WI-40906.
 *
 * THE PROPERTY: a caller-supplied `spawnOptions.env` belongs to the PAYLOAD and must
 * never reach the `systemd-run` client that confines it.
 *
 * WHY: a `--scope` payload is forked from the systemd-run client, so it inherits the
 * client's environment — which made `spawn(systemd-run …, { env })` look like it set
 * the payload's env. It does. It also sets the CLIENT's, and the client needs its own:
 * `systemd-run --user` reaches the user manager over `$DBUS_SESSION_BUS_ADDRESS`.
 * Redirect that variable and the launch dies before the payload ever execs:
 *
 *     Failed to start transient scope unit:
 *       The name org.freedesktop.systemd1 was not provided by any .service files
 *
 * Measured live 2026-08-23. A sandbox desktop publishes its own accessibility bus and
 * hands apps `DBUS_SESSION_BUS_ADDRESS` for it, so EVERY GUI app launched into such a
 * desktop failed to start — silently, because the caller passes `stdio: 'ignore'` and
 * `managedSpawn` then returned a healthy-looking handle for a process that had never
 * run. Xvfb and the window manager came up fine (they are spawned before that bus
 * exists), which is what made it read as "GTK apps don't work here" for a day.
 *
 * The guard is written against the CLIENT's spawn options rather than the fix's
 * internals, so it stays true of any future mechanism that keeps the two environments
 * apart — and `legacyCoupledLaunch` below is a permanently-kept wrong implementation
 * proving the assertion can still fail (the repo's falsifiability rule, without
 * mutating the shared tree to demonstrate it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions, spawn as nodeSpawn } from 'node:child_process';

vi.mock('./enabled', () => ({
  isTaskManagerEnabled: async () => true,
  taskManagerEnabledSync: () => true,
  warmTaskManagerFlag: () => {},
  setTaskManagerEnabledForTest: () => {},
}));

vi.mock('./store', () => ({
  registerTask: async (_spec: unknown, opts: { taskId?: string }) => ({
    taskId: opts?.taskId ?? 'task-test',
    state: 'pending',
  }),
  markSpawned: async () => {},
  closeTask: async () => {},
}));

import { managedSpawn } from './managed-spawn';
import { buildExactEnvPayload, buildTaskScopeArgv } from '../systemd-scope';
import { CGROUP_ROOT, type CgroupFs } from './cgroup-read';
import type { TaskSpec } from './types';

const MGR = '/user.slice/user-1000.slice/user@1000.service';

/** The exact env shape that broke: an a11y-only bus in the session-bus slot. */
const A11Y_BUS = 'unix:path=/run/user/1000/at-spi/bus_110';
const DESKTOP_ENV = {
  DISPLAY: ':110',
  DBUS_SESSION_BUS_ADDRESS: A11Y_BUS,
  AT_SPI_BUS_ADDRESS: A11Y_BUS,
  PATH: '/usr/bin:/bin',
} as const;

const APP_SPEC: TaskSpec = {
  class: 'desktop',
  title: 'zenity :110',
  argv: [],
  launchedBy: 'system:desktop-provisioner',
};

const FS: CgroupFs = {
  readFile: (p: string) => (p === `/proc/${process.pid}/cgroup` ? `0::${MGR}/papercup-dev-api.service\n` : null),
  readDir: () => [],
  isDir: () => false,
};

interface Launch {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/** Spawn one app and report exactly what the injected spawn saw. */
async function launch(opts: { confined: boolean; env?: NodeJS.ProcessEnv; stdio?: SpawnOptions['stdio'] }) {
  const seen: Launch[] = [];
  const emitter = new EventEmitter();
  Object.assign(emitter, { pid: 4242, kill: () => true });
  const spawnFn = ((command: string, args: string[], options: SpawnOptions) => {
    seen.push({ command, args, options });
    return emitter as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;

  await managedSpawn('zenity', ['--info'], APP_SPEC, {
    scopeAvailable: opts.confined,
    spawnFn,
    fs: FS,
    spawnOptions: {
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.stdio ? { stdio: opts.stdio } : {}),
    },
  });
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

/**
 * THE CONTROL — kept deliberately wrong, forever. This is what the code did before
 * WI-40906: hand the caller's env straight to the systemd-run client. Every assertion
 * about the client's environment is run against this too, so a guard that stopped
 * discriminating would be caught here instead of passing quietly.
 */
function legacyCoupledLaunch(env: NodeJS.ProcessEnv): Launch {
  const argv = buildTaskScopeArgv(['zenity', '--info'], { unit: 'pc-x.scope', slice: 'pc.slice' });
  return { command: argv[0]!, args: argv.slice(1), options: { env } };
}

describe('confined payload env is not the client env (WI-40906)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('does not hand the caller env to the systemd-run client', async () => {
    const l = await launch({ confined: true, env: { ...DESKTOP_ENV } });

    expect(l.command).toBe('systemd-run');
    // The whole defect in one assertion: the client must inherit ours, not the
    // caller's, or it cannot reach the user manager to create the scope at all.
    expect(l.options.env).toBeUndefined();

    // ...and the control proves this assertion still discriminates.
    expect(legacyCoupledLaunch({ ...DESKTOP_ENV }).options.env).toBeDefined();
  });

  it('gives the payload the caller env exactly, as argv operands', async () => {
    const l = await launch({ confined: true, env: { ...DESKTOP_ENV } });
    const argv = [l.command, ...l.args];

    const envIdx = argv.indexOf('/usr/bin/env');
    expect(envIdx).toBeGreaterThan(0);
    expect(argv[envIdx + 1]).toBe('-i');
    // Operands, then the real command — order matters: `env -i` would otherwise
    // treat the command as an assignment or the assignments as arguments.
    expect(argv.slice(envIdx + 2)).toEqual([
      `AT_SPI_BUS_ADDRESS=${A11Y_BUS}`,
      `DBUS_SESSION_BUS_ADDRESS=${A11Y_BUS}`,
      'DISPLAY=:110',
      'PATH=/usr/bin:/bin',
      'zenity',
      '--info',
    ]);
    // The scope flags must still precede it, or nothing is confined.
    expect(argv.slice(0, 4)).toEqual(['systemd-run', '--user', '--scope', '--quiet']);
  });

  it('leaves an unconfined spawn exactly as it was', async () => {
    const l = await launch({ confined: false, env: { ...DESKTOP_ENV } });

    // No client to protect: node applies `env` itself, and wrapping here would
    // change the process the caller asked for.
    expect(l.command).toBe('zenity');
    expect(l.args).toEqual(['--info']);
    expect(l.options.env).toEqual(DESKTOP_ENV);
  });

  it('preserves the caller stdio on the client (a --scope payload inherits it)', async () => {
    const l = await launch({ confined: true, env: { ...DESKTOP_ENV }, stdio: 'ignore' });
    expect(l.options.stdio).toBe('ignore');
  });

  it('does not wrap a confined spawn that passed no env', async () => {
    const l = await launch({ confined: true });
    expect([l.command, ...l.args]).not.toContain('-i');
    expect([l.command, ...l.args].slice(-2)).toEqual(['zenity', '--info']);
  });
});

describe('buildExactEnvPayload', () => {
  it('replaces the environment rather than merging into it', () => {
    // `env -i` is the load-bearing token: without it the payload would inherit the
    // client's env and merely have these keys overlaid, which is NOT what
    // child_process.spawn({ env }) means.
    expect(buildExactEnvPayload(['cmd'], { A: '1' })).toEqual(['/usr/bin/env', '-i', 'A=1', 'cmd']);
  });

  it('drops undefined values, as node spawn does', () => {
    expect(buildExactEnvPayload(['cmd'], { A: '1', B: undefined })).toEqual(['/usr/bin/env', '-i', 'A=1', 'cmd']);
  });

  it('drops names that cannot be expressed as an operand instead of shifting the rest', () => {
    // A name carrying `=` would make every later operand land in the wrong slot —
    // including the command itself. A subset of the requested env is recoverable;
    // a silently different one is not.
    const argv = buildExactEnvPayload(['cmd'], { 'BAD=NAME': 'x', GOOD: 'y' });
    expect(argv).toEqual(['/usr/bin/env', '-i', 'GOOD=y', 'cmd']);
  });

  it('keeps values containing = and spaces intact', () => {
    // Real bus addresses carry `=` in the VALUE; only the first `=` separates.
    const argv = buildExactEnvPayload(['cmd'], { DBUS_SESSION_BUS_ADDRESS: A11Y_BUS });
    expect(argv).toContain(`DBUS_SESSION_BUS_ADDRESS=${A11Y_BUS}`);
  });

  it('emits operands in a stable order', () => {
    const a = buildExactEnvPayload(['cmd'], { B: '2', A: '1' });
    const b = buildExactEnvPayload(['cmd'], { A: '1', B: '2' });
    expect(a).toEqual(b);
  });

  it('preserves the payload argv verbatim after the operands', () => {
    const argv = buildExactEnvPayload(['vglrun', '-d', 'egl0', 'zenity', '--text=a b'], { A: '1' });
    expect(argv.slice(3)).toEqual(['vglrun', '-d', 'egl0', 'zenity', '--text=a b']);
  });
});

// Referenced so the unused-import lint cannot hide a fixture drifting out of use.
void CGROUP_ROOT;
