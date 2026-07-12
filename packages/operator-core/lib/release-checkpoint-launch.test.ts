/**
 * release-checkpoint-launch — the detached green-checkpoint fire-now primitive (WI-1320 follow-up).
 * Asserts the systemd-run argv construction (pure) + the launch/refuse resolution with an injected
 * spawn seam — no real suite fires.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release-checkpoint-launch.test.ts
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCheckpointSystemdArgv,
  checkpointRunLogPath,
  checkpointLatestLogPath,
  launchDetachedCheckpoint,
  checkActiveCheckpointRun,
  CHECKPOINT_UNIT,
  checkpointUnitForRoot,
  CHECKPOINT_MAX_RUNTIME_SEC,
} from './release-checkpoint-launch';

// 2026-07-10: every run wrote to /tmp/<unit>.log, so the natural response to a red —
// re-fire — truncated the failure output that red was telling you to read. Each run now
// owns a timestamped file; the well-known path becomes a symlink to the newest.
describe('per-run checkpoint logs (re-fire must not destroy the evidence)', () => {
  it('gives each run its own timestamped path under the unit name', () => {
    const a = checkpointRunLogPath('papercup-gc', new Date('2026-07-10T04:06:59.566Z'));
    expect(a).toBe('/tmp/papercup-gc-2026-07-10T04-06-59-566Z.log');
    // A second run at a different instant never collides with the first.
    expect(checkpointRunLogPath('papercup-gc', new Date('2026-07-10T06:29:46.196Z'))).not.toBe(a);
  });

  it('keeps the well-known path stable for existing readers', () => {
    expect(checkpointLatestLogPath('papercup-gc')).toBe('/tmp/papercup-gc.log');
  });

  it('symlinks the stable path at the run log before redirecting into it', () => {
    const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin', false, '/tmp/cp-RUN.log');
    const inner = argv[argv.length - 1];
    // ln first (so a reader polling the stable path lands on this run's file), then the
    // redirect binds to green-checkpoint only, and -n keeps ln from following the old link.
    expect(inner).toContain("ln -sfn '/tmp/cp-RUN.log' '/tmp/cp.log' &&");
    expect(inner).toContain('> /tmp/cp-RUN.log 2>&1');
    expect(inner.indexOf('ln -sfn')).toBeLessThan(inner.indexOf('green-checkpoint.ts'));
  });

  it('writes straight to the given path when no run log is supplied (back-compat)', () => {
    const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin').at(-1)!;
    expect(inner).toContain('> /tmp/cp.log 2>&1');
    expect(inner).not.toContain('ln -sfn');
  });
});

describe('buildCheckpointSystemdArgv', () => {
  it('targets the manual unit, bounds runtime, and runs the green-checkpoint CLI in the tree root', () => {
    const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin');
    expect(argv).toContain(`--unit=${checkpointUnitForRoot('/tree')}`); // per-root (2026-07-01): cross-root manual gates no longer serialize
    expect(argv).toContain(`--property=RuntimeMaxSec=${CHECKPOINT_MAX_RUNTIME_SEC}`);
    expect(CHECKPOINT_MAX_RUNTIME_SEC).toBeGreaterThanOrEqual(3 * 60 * 60);
    expect(argv).toContain('--working-directory=/tree');
    expect(argv).toContain('--setenv=PATH=/usr/bin:/bin');
    const inner = argv[argv.length - 1]!;
    expect(inner).toContain('apps/operator/lib/release/green-checkpoint.ts');
    expect(inner).toContain("PAPERCUSP_INTEGRATION_ROOT='/tree'");
    expect(inner).toContain('> /tmp/cp.log 2>&1');
  });

  it('does NOT forward the partial-green-gate flag by default (whole-batch, back-compat)', () => {
    const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin').at(-1)!;
    expect(inner).not.toContain('PAPERCUSP_PARTIAL_GREEN_GATE');
  });

  it('forwards PAPERCUSP_PARTIAL_GREEN_GATE when armed — a manual checkpoint then uses the same longest-green-prefix FF as the periodic gate', () => {
    const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin', true).at(-1)!;
    expect(inner).toContain("PAPERCUSP_PARTIAL_GREEN_GATE='1'");
    expect(inner).toContain('apps/operator/lib/release/green-checkpoint.ts');
    expect(inner).toContain("PAPERCUSP_INTEGRATION_ROOT='/tree'");
  });
});

/** A fake ChildProcess whose close/error we drive. */
function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  ee.stderr = new EventEmitter();
  return ee;
}

describe('launchDetachedCheckpoint', () => {
  it('resolves launched:true when systemd-run exits 0', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn);
    child.emit('close', 0);
    const r = await p;
    expect(r.launched).toBe(true);
    expect(r.unit).toBe(checkpointUnitForRoot('/tree'));
    expect(spawnFn).toHaveBeenCalledWith(
      'systemd-run',
      expect.arrayContaining([`--unit=${checkpointUnitForRoot('/tree')}`]),
    );
  });

  it('resolves launched:false with a reason when the unit already exists (non-zero exit)', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn);
    child.stderr.emit('data', 'Unit papercup-green-checkpoint-manual.service already exists.');
    child.emit('close', 1);
    const r = await p;
    expect(r.launched).toBe(false);
    expect(r.reason).toMatch(/already/i);
  });

  it('resolves launched:false on a spawn error', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn);
    child.emit('error', new Error('systemd-run not found'));
    const r = await p;
    expect(r.launched).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });
});

// WI-1562: a second manual fire while one was already active used to only find out via
// systemd-run's own exit-1 (a bare string) — these assert the PROACTIVE structured check, and
// that launchDetachedCheckpoint refuses WITHOUT even attempting the spawn when it's active.
describe('checkActiveCheckpointRun (WI-1562 refuse-when-active detection)', () => {
  function fakeSystemctlShow(props: Record<string, string>) {
    const stdout = Object.entries(props)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    return vi.fn(() => ({ status: 0, stdout, stderr: '' }));
  }

  it('reports active:false when the unit is not active', () => {
    const execFn = fakeSystemctlShow({ ActiveState: 'inactive', ExecMainStartTimestamp: '' });
    const r = checkActiveCheckpointRun('/tree', execFn, () => null);
    expect(r).toMatchObject({ active: false, unit: checkpointUnitForRoot('/tree') });
  });

  it('reports active:true with started_at, a bounded eta_sec, and the parsed candidate when the unit is active', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString(); // started 5 min ago
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt })();
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD')
        return { status: 0, stdout: '98817077fd79af9dfee00076a1c6e90445d268af\n', stderr: '' };
      if (cmd === 'git' && args.includes('--format=%ct'))
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 500), stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 98817077 (base 94b17b25)\n...');
    const r = checkActiveCheckpointRun('/tree', execFn, readLogHead);

    expect(r.active).toBe(true);
    expect(r.unit).toBe(checkpointUnitForRoot('/tree'));
    expect(r.candidate).toBe('98817077');
    expect(r.current_head).toBe('98817077fd79af9dfee00076a1c6e90445d268af');
    expect(r.current_candidate).toBe('98817077fd79af9dfee00076a1c6e90445d268af');
    expect(r.candidate_stale).toBe(false);
    expect(r.started_at).toBe(startedAt);
    expect(r.eta_sec).toBeGreaterThan(0);
    expect(r.eta_sec).toBeLessThanOrEqual(CHECKPOINT_MAX_RUNTIME_SEC);
    expect(readLogHead).toHaveBeenCalledWith(`/tmp/${checkpointUnitForRoot('/tree')}.log`);
  });

  it('marks an active run stale when its log candidate differs from the current quiet-cut candidate', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const oldCandidate = '1111111111111111111111111111111111111111';
    const currentHead = '3333333333333333333333333333333333333333';
    const quietCandidate = '2222222222222222222222222222222222222222';
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt })();
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD')
        return { status: 0, stdout: `${currentHead}\n`, stderr: '' };
      if (cmd === 'git' && args.includes('--format=%ct'))
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 30), stderr: '' };
      if (cmd === 'git' && args.includes('rev-list')) return { status: 0, stdout: `${quietCandidate}\n`, stderr: '' };
      if (cmd === 'git' && args.includes('ready')) return { status: 1, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const r = checkActiveCheckpointRun(
      '/tree',
      execFn,
      () => `[green-checkpoint] checkpointing candidate ${oldCandidate.slice(0, 8)} (base def)\n`,
    );

    expect(r).toMatchObject({
      active: true,
      candidate: oldCandidate.slice(0, 8),
      current_head: currentHead,
      current_candidate: quietCandidate,
      candidate_stale: true,
      quiet_cut_sec: 240,
    });
  });

  it('treats activating/reloading as active too, and tolerates an unreadable log (candidate:null)', () => {
    const execFn = fakeSystemctlShow({ ActiveState: 'activating', ExecMainStartTimestamp: '' });
    const r = checkActiveCheckpointRun('/tree', execFn, () => null);
    expect(r.active).toBe(true);
    expect(r.candidate).toBeNull();
    expect(r.started_at).toBeNull();
    expect(r.eta_sec).toBeNull();
  });
});

// EI-9180: an 18h phantom-wedge — ActiveState kept reading 'active' for a run whose process was
// already gone (host-load-starved systemd --user manager bookkeeping lag / a kill -9 outside
// systemd), so every re-fire got refused with a stable started_at/eta_sec from the dead run and
// nothing self-healed short of a manual force:true. Cross-check the unit's own reported MainPID
// with a real OS-level liveness probe; when systemd's ActiveState disagrees with reality, trust
// reality.
describe('checkActiveCheckpointRun MainPID liveness cross-check (EI-9180 self-heal)', () => {
  function fakeSystemctlShow(props: Record<string, string>) {
    const stdout = Object.entries(props)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    return vi.fn(() => ({ status: 0, stdout, stderr: '' }));
  }

  it('self-heals: ActiveState says active but the reported MainPID is provably dead → active:false', () => {
    const execFn = fakeSystemctlShow({
      ActiveState: 'active',
      ExecMainStartTimestamp: '2026-07-10T12:20:44Z',
      MainPID: '99999',
    });
    const pidAlive = vi.fn(() => false); // the PID systemd names no longer exists
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive);
    expect(pidAlive).toHaveBeenCalledWith(99999);
    expect(r).toEqual({ active: false, unit: checkpointUnitForRoot('/tree') });
  });

  it('trusts ActiveState when the reported MainPID IS alive (the normal case)', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const execFn = fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt, MainPID: '12345' });
    const pidAlive = vi.fn(() => true);
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive);
    expect(pidAlive).toHaveBeenCalledWith(12345);
    expect(r.active).toBe(true);
  });

  it('MainPID=0 (systemd has no main process to report) skips the probe and trusts ActiveState (back-compat)', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const execFn = fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt, MainPID: '0' });
    const pidAlive = vi.fn(() => false);
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive);
    expect(pidAlive).not.toHaveBeenCalled();
    expect(r.active).toBe(true);
  });

  it('no MainPID property at all (older systemd / unexpected output) skips the probe and trusts ActiveState', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const execFn = fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt });
    const pidAlive = vi.fn(() => false);
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive);
    expect(pidAlive).not.toHaveBeenCalled();
    expect(r.active).toBe(true);
  });

  it('default pidAlive probe uses kill(pid, 0): the current process (self) reads as alive', () => {
    // No injected pidAlive — exercise the real default against our OWN pid, guaranteed alive.
    const execFn = fakeSystemctlShow({
      ActiveState: 'active',
      ExecMainStartTimestamp: new Date().toISOString(),
      MainPID: String(process.pid),
    });
    const r = checkActiveCheckpointRun('/tree', execFn, () => null);
    expect(r.active).toBe(true);
  });

  it('default pidAlive probe: an implausible/reserved PID (1 is always alive as init; use a huge unused one) reads as dead', () => {
    // PID space wraps well below 2**22 on Linux; a value past any real max is guaranteed absent.
    const execFn = fakeSystemctlShow({
      ActiveState: 'active',
      ExecMainStartTimestamp: new Date().toISOString(),
      MainPID: '4194304',
    });
    const r = checkActiveCheckpointRun('/tree', execFn, () => null);
    expect(r).toEqual({ active: false, unit: checkpointUnitForRoot('/tree') });
  });
});

describe('launchDetachedCheckpoint refuse-when-active (WI-1562)', () => {
  it('refuses with a structured alreadyRunning detail and never calls spawnFn when a run is active', async () => {
    const spawnFn = vi.fn();
    const execFn = vi.fn(() => ({
      status: 0,
      stdout: 'ActiveState=active\nExecMainStartTimestamp=2026-07-02T10:44:43Z',
      stderr: '',
    }));
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate abc12345 (base def)\n');

    const r = await launchDetachedCheckpoint({ root: '/tree' }, spawnFn as never, execFn, readLogHead);

    expect(spawnFn).not.toHaveBeenCalled();
    expect(r.launched).toBe(false);
    expect(r.reason).toBe('already_running');
    expect(r.alreadyRunning).toMatchObject({
      active: true,
      unit: checkpointUnitForRoot('/tree'),
      candidate: 'abc12345',
      started_at: '2026-07-02T10:44:43Z',
    });
  });

  it('skips the active check and spawns anyway when force:true', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const execFn = vi.fn();

    const p = launchDetachedCheckpoint({ root: '/tree', force: true }, spawnFn, execFn);
    child.emit('close', 0);
    const r = await p;

    expect(execFn).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalled();
    expect(r.launched).toBe(true);
  });

  it('proceeds to spawn when the active check reports inactive', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const execFn = vi.fn(() => ({ status: 0, stdout: 'ActiveState=inactive', stderr: '' }));

    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn, execFn, () => null);
    child.emit('close', 0);
    const r = await p;

    expect(spawnFn).toHaveBeenCalled();
    expect(r.launched).toBe(true);
  });
});

describe('checkpointUnitForRoot (per-root manual gates, 2026-07-01)', () => {
  it('DIFFERENT roots get DIFFERENT units (no cross-repo serialization); same root is stable (duplicate guard intact)', () => {
    const a = checkpointUnitForRoot('/home/x/papercusp');
    const b = checkpointUnitForRoot('/home/x/papercup');
    expect(a).not.toBe(b);
    expect(a).toBe(checkpointUnitForRoot('/home/x/papercusp'));
    expect(a.startsWith(`${CHECKPOINT_UNIT}-`)).toBe(true);
    // systemd unit-name-safe suffix (base36 of a u32 — no dots/slashes/spaces).
    expect(a).toMatch(/^[a-z0-9-]+$/);
  });
});
