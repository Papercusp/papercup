/**
 * release-checkpoint-launch — the detached green-checkpoint fire-now primitive (WI-1320 follow-up).
 * Asserts the systemd-run argv construction (pure) + the launch/refuse resolution with an injected
 * spawn seam — no real suite fires.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release-checkpoint-launch.test.ts
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
// WI-4957: launchDetachedCheckpoint's DEFAULT `cancelStaleAwaits` param is the real
// cancelStaleCheckpointAwaits, which lazily requires events/await/engine → a real PG pool.
// Every test in this file EXCEPT the WI-4957 ones below injects no 5th param, so without
// this mock every replaceStale test would hit a real (here, absent) database and hang.
// Mocked to resolve immediately; the WI-4957 tests inject their own spy and bypass this
// entirely (the module-level function is never reached when a 5th arg is supplied).
vi.mock('./events/await/engine', () => ({
  cancelSupersededCandidateAwaits: vi.fn(async () => ({ cancelled: 0, ids: [] })),
}));
import {
  buildCheckpointSystemdArgv,
  checkpointRunLogPath,
  checkpointLatestLogPath,
  launchDetachedCheckpoint,
  checkActiveCheckpointRun,
  isCheckpointRunLockHeldCheap,
  stopActiveCheckpointUnit,
  CHECKPOINT_UNIT,
  checkpointUnitForRoot,
  CHECKPOINT_MAX_RUNTIME_SEC,
  CANDIDATE_RERESOLVE_WINDOW_SEC,
  REPLACE_STALE_MIN_AGE_SEC,
  classifyReplaceRequest,
  checkpointCandidateContainment,
  renderContainmentWarning,
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

  /**
   * WI-4494 — THE REGRESSION THAT CAUSED THE 10h PIPELINE FREEZE.
   *
   * A detached manual run ran the full suite, produced a real green/red, and discarded it, because
   * nothing ever told it WHOSE gate it was judging. Meanwhile it held the run-lock, so the hourly
   * routine — the only thing that DID record — got `skipped-locked` on three consecutive fires and
   * recorded nothing either. gate_health froze on a stale red; the release pin sat unmoved ~10h.
   *
   * A detached unit inherits none of the launcher's env, so the stamp must be explicit --setenv or
   * the run silently declines to record and we are right back where we started.
   */
  it('⭐ stamps the record target so a MANUAL run records its own verdict instead of discarding it', () => {
    const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin', false, undefined, {
      workspaceId: 'papercusp-workspace',
      installSlug: 'papercusp',
    });
    expect(argv).toContain('--setenv=PAPERCUSP_GATE_VERDICT_WORKSPACE=papercusp-workspace');
    expect(argv).toContain('--setenv=PAPERCUSP_GATE_VERDICT_HARNESS=papercusp');
  });

  it('stamps nothing without a target — the run then does not record and its caller does (pre-WI-4494 behaviour)', () => {
    const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin', false, undefined, null);
    expect(argv.some((a) => a.includes('GATE_VERDICT'))).toBe(false);
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

  // WI-6962: the probe used to fail OPEN — any systemctl failure parsed to `ActiveState=''`,
  // fell through the active test, and returned active:false, so the launcher spawned straight
  // over a live 8-fork suite (systemd REPLACES a same-named transient unit rather than
  // refusing). These pin the distinction the old code could not express: a TRUSTED negative
  // vs. "I could not tell".
  describe('WI-6962 — an untrustworthy probe must not read as "nothing is running"', () => {
    it('anchors the premise: a well-formed negative carries an ActiveState key (measured against real systemctl)', () => {
      // `systemctl --user show <unknown-unit>` exits 0 with ActiveState=inactive/MainPID=0.
      // That is what makes a MISSING key decisive evidence of a failed probe rather than idleness.
      const execFn = fakeSystemctlShow({ ActiveState: 'inactive', MainPID: '0' });
      const r = checkActiveCheckpointRun('/tree', execFn, () => null);
      expect(r.active).toBe(false);
      expect(r.probe_failed).toBeUndefined();
    });

    it('fails CLOSED when systemctl exits non-zero (host too starved to fork)', () => {
      const execFn = vi.fn(() => ({ status: 1, stdout: '', stderr: 'Failed to connect to bus' }));
      const r = checkActiveCheckpointRun('/tree', execFn, () => null);
      expect(r.active).toBe(true);
      expect(r.probe_failed).toBe(true);
      expect(r.probe_detail).toContain('Failed to connect to bus');
      // Never replaceable: we cannot know the candidate, so nothing may stop the run.
      expect(r.candidate_stale).toBe(false);
    });

    it('fails CLOSED when spawnSync itself failed (status null, empty output)', () => {
      const execFn = vi.fn(() => ({ status: null, stdout: '', stderr: '' }));
      const r = checkActiveCheckpointRun('/tree', execFn, () => null);
      expect(r).toMatchObject({ active: true, probe_failed: true });
    });

    it('fails CLOSED when the output parses but carries no ActiveState key', () => {
      // The exact shape the old `props.ActiveState ?? ''` silently turned into a confident
      // "inactive": a reply that succeeded but did not answer the question asked.
      const execFn = fakeSystemctlShow({ MainPID: '0' });
      const r = checkActiveCheckpointRun('/tree', execFn, () => null);
      expect(r).toMatchObject({ active: true, probe_failed: true });
    });

    it('still reports the run-lock holder when the probe fails but the lock IS held', () => {
      const startedAt = new Date(Date.now() - 9 * 60_000).toISOString();
      const execFn = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
      const r = checkActiveCheckpointRun(
        '/tree',
        execFn,
        () => null,
        () => true, // pidAlive
        () => ({ pid: 4242, startedAt }),
      );
      expect(r).toMatchObject({ active: true, probe_failed: true, held_externally: true, started_at: startedAt });
      expect(r.elapsed_sec).toBeGreaterThanOrEqual(9 * 60 - 5);
    });

    it('launchDetachedCheckpoint REFUSES on an indeterminate probe and never spawns', async () => {
      const execFn = vi.fn(() => ({ status: 1, stdout: '', stderr: 'bus error' }));
      const spawnFn = vi.fn();
      const r = await launchDetachedCheckpoint({ root: '/tree' }, spawnFn as never, execFn, () => null);
      expect(r.launched).toBe(false);
      expect(r.reason).toBe('probe_failed');
      expect(r.alreadyRunning?.probe_failed).toBe(true);
      // The whole point: no process was started over a possibly-live suite.
      expect(spawnFn).not.toHaveBeenCalled();
    });
  });
});

// WI-5685: the manual unit only ever sees ITSELF — a cron-invoked run (spawned as a plain
// child by release-actions.ts's runScript, no systemd unit involved at all) is completely
// invisible to checkActiveCheckpointRun's systemd probe. Evidence: two manual
// release:checkpoint-run fires both got launched:true (the probe said "nothing active") and
// then exited skipped-locked from WITHIN the detached process a moment later, because the
// shared file-based run-lock was already held by the hourly cron tick. These assert the
// fallback that closes that blind spot: cross-check the run-lock's own owner.json whenever
// the manual-unit probe comes back inactive.
describe('checkActiveCheckpointRun run-lock fallback (WI-5685: the cron-holds-the-lock blind spot)', () => {
  function fakeSystemctlShow(props: Record<string, string>) {
    const stdout = Object.entries(props)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    return vi.fn(() => ({ status: 0, stdout, stderr: '' }));
  }
  const inactiveUnit = fakeSystemctlShow({ ActiveState: 'inactive', ExecMainStartTimestamp: '' });

  it('reports active:true (held_externally) when the manual unit is idle but a live process holds the shared run-lock', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const checkpointHead = 'a0d9300182aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const integrationHead = '6ea7bdad60bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    // Distinguish the two `-C <root>` targets by their actual path — `/tree` (the integration
    // root, via currentCheckpointCandidate) vs `/tree-checkpoint` (the isolated checkpoint
    // checkout, via checkpointRootMirror) — a mock that ignored `-C` would mask exactly the
    // EI-18695275971973546 bug (candidate silently reported as the wrong tree's HEAD).
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return inactiveUnit();
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD') {
        const root = args[args.indexOf('-C') + 1];
        if (root === '/tree-checkpoint') return { status: 0, stdout: `${checkpointHead}\n`, stderr: '' };
        return { status: 0, stdout: `${integrationHead}\n`, stderr: '' };
      }
      if (cmd === 'git' && args.includes('--format=%ct'))
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 500), stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const pidAlive = vi.fn(() => true);
    const readLockOwner = vi.fn(() => ({ pid: 4242, startedAt }));

    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive, readLockOwner);

    expect(r.active).toBe(true);
    expect(r.held_externally).toBe(true);
    // EI-18695275971973546: `candidate` resolves to the CHECKPOINT tree's HEAD — the real
    // in-flight candidate — never the integration root's (which is only "if launched now").
    expect(r.candidate).toBe(checkpointHead);
    expect(r.current_head).toBe(integrationHead);
    expect(r.current_candidate).toBe(integrationHead);
    expect(r.candidate_stale).toBe(false); // never replaceable — EI-11667 safety, regardless of resolution
    expect(r.started_at).toBe(startedAt);
    expect(r.elapsed_sec).toBeGreaterThan(0);
    expect(r.eta_sec).toBeGreaterThan(0);
    expect(pidAlive).toHaveBeenCalledWith(4242);
  });

  it('EI-18695275971973546: candidate stays null (never crashes) when the checkpoint tree is unreadable — e.g. mid-checkout', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return inactiveUnit();
      // Every git call fails — mirrors a checkpoint tree that doesn't exist yet / mid-setup.
      return { status: 1, stdout: '', stderr: 'not a git repository' };
    });
    const pidAlive = vi.fn(() => true);
    const readLockOwner = vi.fn(() => ({ pid: 4242, startedAt }));

    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive, readLockOwner);

    expect(r.held_externally).toBe(true);
    expect(r.candidate).toBeNull();
    expect(r.candidate_stale).toBe(false);
  });

  it('reports active:false when the run-lock file is missing/unreadable (the common case — nothing running)', () => {
    const execFn = inactiveUnit;
    const readLockOwner = vi.fn(() => null);
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, undefined, readLockOwner);
    expect(r).toEqual({ active: false, unit: checkpointUnitForRoot('/tree') });
  });

  it('reports active:false when the lock owner pid is dead (crashed holder, unreclaimed file)', () => {
    const execFn = inactiveUnit;
    const pidAlive = vi.fn(() => false);
    const readLockOwner = vi.fn(() => ({ pid: 9999, startedAt: new Date().toISOString() }));
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive, readLockOwner);
    expect(r).toEqual({ active: false, unit: checkpointUnitForRoot('/tree') });
  });

  describe('isCheckpointRunLockHeldCheap (WI-4310: the no-subprocess sibling for hot health-panel reads)', () => {
    it('reports held:true + elapsedSec when a live process holds the run-lock', () => {
      const startedAt = new Date(Date.now() - 90_000).toISOString();
      const pidAlive = vi.fn(() => true);
      const readLockOwner = vi.fn(() => ({ pid: 4242, startedAt }));

      const r = isCheckpointRunLockHeldCheap('/tree', pidAlive, readLockOwner);

      expect(r.held).toBe(true);
      expect(r.elapsedSec).toBeGreaterThanOrEqual(89);
      expect(pidAlive).toHaveBeenCalledWith(4242);
    });

    it('reports held:false when the lock file is missing/unreadable (no systemctl fork involved)', () => {
      const readLockOwner = vi.fn(() => null);
      const r = isCheckpointRunLockHeldCheap('/tree', vi.fn(() => true), readLockOwner);
      expect(r).toEqual({ held: false, elapsedSec: null });
    });

    it('reports held:false when the lock owner pid is dead (crashed holder, unreclaimed file)', () => {
      const readLockOwner = vi.fn(() => ({ pid: 9999, startedAt: new Date().toISOString() }));
      const r = isCheckpointRunLockHeldCheap('/tree', vi.fn(() => false), readLockOwner);
      expect(r).toEqual({ held: false, elapsedSec: null });
    });

    it('never shells out — no execFn/systemctl seam exists on this probe at all', () => {
      // Type-level assertion as much as a runtime one: the whole point of this sibling is that
      // it takes no execFn, unlike checkActiveCheckpointRun. Calling it with only fs-level fakes
      // and getting a sane result IS the proof it stayed subprocess-free.
      const readLockOwner = vi.fn(() => ({ pid: process.pid, startedAt: new Date().toISOString() }));
      const r = isCheckpointRunLockHeldCheap('/tree', undefined, readLockOwner);
      expect(r.held).toBe(true);
    });
  });

  // End-to-end through the REAL fs + REAL default pidAlive (launchDetachedCheckpoint doesn't
  // expose pid/lock-owner injection seams — it always calls checkActiveCheckpointRun with just
  // execFn/readLogHead, so production wiring goes through defaultReadLockOwner + defaultPidAlive).
  // Proves the whole chain: a real owner.json under the real per-root hashed lock dir stops the
  // launch BEFORE spawnFn is ever called, using our own live pid so pidAlive is genuinely true.
  it('[integration] launchDetachedCheckpoint refuses (never calls spawnFn) when a real owner.json under the hashed lock dir names a live pid', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-lock-test-'));
    const prevEnv = process.env.PAPERCUSP_CHECKPOINT_LOG_DIR;
    process.env.PAPERCUSP_CHECKPOINT_LOG_DIR = tmpRoot;
    try {
      const testTreeRoot = '/tree-int-test';
      let h = 0;
      for (let i = 0; i < testTreeRoot.length; i++) h = (h * 31 + testTreeRoot.charCodeAt(i)) >>> 0;
      const lockDir = path.join(tmpRoot, `.green-checkpoint-run-${h.toString(36)}.lock`);
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(
        path.join(lockDir, 'owner.json'),
        JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
      );

      const execFn = vi.fn((cmd: string) => {
        if (cmd === 'systemctl') return { status: 0, stdout: 'ActiveState=inactive', stderr: '' };
        return { status: 1, stdout: '', stderr: '' }; // git reads fail harmlessly (candidate resolution best-effort)
      });
      const spawnFn = vi.fn();

      const r = await launchDetachedCheckpoint({ root: testTreeRoot }, spawnFn as never, execFn, () => null);

      expect(spawnFn).not.toHaveBeenCalled();
      expect(r.launched).toBe(false);
      expect(r.reason).toBe('already_running');
      expect(r.alreadyRunning?.held_externally).toBe(true);
      expect(r.alreadyRunning?.candidate_stale).toBe(false);
    } finally {
      if (prevEnv === undefined) delete process.env.PAPERCUSP_CHECKPOINT_LOG_DIR;
      else process.env.PAPERCUSP_CHECKPOINT_LOG_DIR = prevEnv;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
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
    // WI-5124: force:true still skips checkActiveCheckpointRun (no systemctl probe), but
    // execFn IS now called for the willJudge resolution (currentCheckpointCandidate) — a
    // real git response, not a bare vi.fn(), so that resolution doesn't blow up on undefined.
    // WI-5217: typed as ExecSyncLike (cmd, args) — the untyped 0-arg version below made
    // `.mock.calls.every((c) => c[0] === 'git')` at line ~355 index into an empty `[]`
    // tuple type (no recorded args), even though real calls always pass (cmd, args).
    const execFn = vi.fn((_cmd: string, _args: string[]) => ({ status: 0, stdout: 'deadbeef00000000000000000000000000000000', stderr: '' }));

    const p = launchDetachedCheckpoint({ root: '/tree', force: true }, spawnFn, execFn);
    child.emit('close', 0);
    const r = await p;

    // No systemctl/active-check call landed — every execFn call is a `git -C ...` willJudge read.
    expect(execFn.mock.calls.every((c) => c[0] === 'git')).toBe(true);
    expect(spawnFn).toHaveBeenCalled();
    expect(r.launched).toBe(true);
    expect(r.willJudge?.candidate).toBe('deadbeef00000000000000000000000000000000');
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

  it('WI-5124: reports willJudge with quietCutApplied + excludedCommits when the quiet-cut steps back from a fresh tip — the exact "my just-landed fix silently excluded" trap', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const freshTip = 'f'.repeat(40);
    const agedCandidate = 'a'.repeat(40);
    const nowSec = Math.floor(Date.now() / 1000);
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return { status: 0, stdout: 'ActiveState=inactive', stderr: '' };
      const j = args.join(' ');
      if (j.includes('rev-parse HEAD')) return { status: 0, stdout: freshTip, stderr: '' };
      if (j.includes('show -s --format=%ct')) return { status: 0, stdout: String(nowSec - 30), stderr: '' }; // 30s old — well inside the default 240s quiet window
      if (j.includes('rev-list -1 --before=')) return { status: 0, stdout: agedCandidate, stderr: '' };
      if (j.includes('rev-parse --verify ready')) return { status: 1, stdout: '', stderr: '' }; // no ready ref → skip the ancestor guard
      if (j.includes('log --no-decorate --format='))
        return { status: 0, stdout: `${freshTip.slice(0, 7)}\x1f${nowSec - 30}\x1fmy just-landed fix\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });

    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn, execFn, () => null);
    child.emit('close', 0);
    const r = await p;

    expect(r.launched).toBe(true);
    expect(r.willJudge).toMatchObject({
      candidate: agedCandidate,
      tip: freshTip,
      quietCutApplied: true,
      excludedCommits: [`${freshTip.slice(0, 7)} my just-landed fix`],
    });
  });

  // EI-18759622667757826: the exclusion is a pure AGE test, so a commit that is merely SECONDS
  // short of the quiet window ages into eligibility before the detached run re-resolves its own
  // candidate ~1-2s later — and is judged after all. Reporting that commit as flatly "excluded"
  // told the filer its in-flight run was worthless; the run went green and shipped. The launch
  // reply must therefore carry HOW CLOSE each exclusion is, not just that it exists.
  it('EI-18759622667757826: reports per-commit eligibleInSec so a seconds-short exclusion is visibly about to flip', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const freshTip = 'f'.repeat(40);
    const agedCandidate = 'a'.repeat(40);
    const nowSec = Math.floor(Date.now() / 1000);
    // The real incident's numbers: the fix was 238s old against the default 240s quiet window.
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return { status: 0, stdout: 'ActiveState=inactive', stderr: '' };
      const j = args.join(' ');
      if (j.includes('rev-parse HEAD')) return { status: 0, stdout: freshTip, stderr: '' };
      if (j.includes('show -s --format=%ct')) return { status: 0, stdout: String(nowSec - 238), stderr: '' };
      if (j.includes('rev-list -1 --before=')) return { status: 0, stdout: agedCandidate, stderr: '' };
      if (j.includes('rev-parse --verify ready')) return { status: 1, stdout: '', stderr: '' };
      if (j.includes('log --no-decorate --format='))
        return {
          status: 0,
          // 238s old (2s short) and 200s old (40s short) — one flips, one does not.
          stdout: `1111111\x1f${nowSec - 238}\x1fthe fix I just landed\n2222222\x1f${nowSec - 200}\x1fsomeone else's commit\n`,
          stderr: '',
        };
      return { status: 1, stdout: '', stderr: '' };
    });

    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn, execFn, () => null);
    child.emit('close', 0);
    const r = await p;

    expect(r.launched).toBe(true);
    const eligibility = r.willJudge?.excludedEligibility ?? [];
    expect(eligibility).toHaveLength(2);
    // 240 - 238 = 2s away: inside the re-resolution window, so this run very likely DOES judge it.
    expect(eligibility[0]).toMatchObject({ sha: '1111111', subject: 'the fix I just landed' });
    expect(eligibility[0]!.eligibleInSec).toBeLessThanOrEqual(CANDIDATE_RERESOLVE_WINDOW_SEC);
    // 240 - 200 = 40s away: genuinely outside this run.
    expect(eligibility[1]!.eligibleInSec).toBeGreaterThan(CANDIDATE_RERESOLVE_WINDOW_SEC);
    expect(r.willJudge?.soonestEligibleInSec).toBe(eligibility[0]!.eligibleInSec);
    // The subject survives the field split even though it contains an apostrophe/spaces.
    expect(r.willJudge?.excludedCommits).toContain("2222222 someone else's commit");
  });

  it('EI-18759622667757826: soonestEligibleInSec is null when the quiet-cut excluded nothing', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const tip = 'c'.repeat(40);
    const nowSec = Math.floor(Date.now() / 1000);
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return { status: 0, stdout: 'ActiveState=inactive', stderr: '' };
      const j = args.join(' ');
      if (j.includes('rev-parse HEAD')) return { status: 0, stdout: tip, stderr: '' };
      if (j.includes('show -s --format=%ct')) return { status: 0, stdout: String(nowSec - 9999), stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });

    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn, execFn, () => null);
    child.emit('close', 0);
    const r = await p;

    expect(r.willJudge).toMatchObject({ excludedEligibility: [], soonestEligibleInSec: null });
  });

  it('WI-5124: willJudge.quietCutApplied is false and excludedCommits is empty when the tip is old enough to judge directly', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const tip = 'c'.repeat(40);
    const nowSec = Math.floor(Date.now() / 1000);
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return { status: 0, stdout: 'ActiveState=inactive', stderr: '' };
      const j = args.join(' ');
      if (j.includes('rev-parse HEAD')) return { status: 0, stdout: tip, stderr: '' };
      if (j.includes('show -s --format=%ct')) return { status: 0, stdout: String(nowSec - 9999), stderr: '' }; // well past the quiet window
      return { status: 1, stdout: '', stderr: '' };
    });

    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn, execFn, () => null);
    child.emit('close', 0);
    const r = await p;

    expect(r.launched).toBe(true);
    expect(r.willJudge).toMatchObject({ candidate: tip, tip, quietCutApplied: false, excludedCommits: [] });
  });
});

describe('stopActiveCheckpointUnit (EI-9672: the supported cancel a stale run had none of)', () => {
  it('reports stopped:true on a clean systemctl stop', () => {
    const execFn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const r = stopActiveCheckpointUnit('papercup-green-checkpoint-manual-abc', execFn);
    expect(r).toEqual({ stopped: true });
    expect(execFn).toHaveBeenCalledWith('systemctl', ['--user', 'stop', 'papercup-green-checkpoint-manual-abc.service']);
  });

  it('reports stopped:false with the stderr reason on a failed stop — never throws', () => {
    const execFn = vi.fn(() => ({ status: 1, stdout: '', stderr: 'Unit not loaded.' }));
    const r = stopActiveCheckpointUnit('some-unit', execFn);
    expect(r.stopped).toBe(false);
    expect(r.reason).toContain('Unit not loaded');
  });
});

describe('launchDetachedCheckpoint replaceStale (EI-9672: force alone could not free a genuinely-stale singleton)', () => {
  function fakeSystemctlShow(props: Record<string, string>) {
    const stdout = Object.entries(props)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    return { status: 0, stdout, stderr: '' };
  }

  /** execFn that reports an ACTIVE run judging `oldCandidate`, while the current quiet-cut
   *  candidate is `freshCandidate` (i.e. candidate_stale:true) — mirrors the
   *  "candidate_stale" checkActiveCheckpointRun test above, plus responds to the
   *  `systemctl --user stop` call this describe block exercises. Defaults to a run OLD
   *  enough to pass the EI-11667 min-age guard (45 min — the wedged-salvage case). */
  function staleActiveExecFn(stopStatus = 0, ageMinutes = 45) {
    const startedAt = new Date(Date.now() - ageMinutes * 60_000).toISOString();
    const oldCandidate = '1111111111111111111111111111111111111111';
    const currentHead = '3333333333333333333333333333333333333333';
    const quietCandidate = '2222222222222222222222222222222222222222';
    return vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args[1] === 'show') return fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt });
      if (cmd === 'systemctl' && args[1] === 'stop') return { status: stopStatus, stdout: '', stderr: stopStatus === 0 ? '' : 'nope' };
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${currentHead}\n`, stderr: '' };
      if (cmd === 'git' && args.includes('--format=%ct')) return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 30), stderr: '' };
      if (cmd === 'git' && args.includes('rev-list')) return { status: 0, stdout: `${quietCandidate}\n`, stderr: '' };
      if (cmd === 'git' && args.includes('ready')) return { status: 1, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
  }

  it('a STALE active run OLD enough to be wedged is stopped, then a fresh run launches (replaceStale:true)', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const execFn = staleActiveExecFn(0, 45);
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');

    const p = launchDetachedCheckpoint({ root: '/tree', replaceStale: true }, spawnFn, execFn, readLogHead);
    child.emit('close', 0);
    const r = await p;

    expect(execFn).toHaveBeenCalledWith('systemctl', ['--user', 'stop', `${checkpointUnitForRoot('/tree')}.service`]);
    expect(spawnFn).toHaveBeenCalled();
    expect(r.launched).toBe(true);
    expect(r.replacedStale).toMatchObject({ active: true, candidate_stale: true, candidate: '11111111' });
  });

  it('a YOUNG stale run is REFUSED, not stopped — the EI-11667 replace-storm guard (stale is normal for a healthy young run on a busy tree)', async () => {
    const spawnFn = vi.fn();
    const execFn = staleActiveExecFn(0, 5); // 5 min old — well under REPLACE_STALE_MIN_AGE_SEC
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');

    const r = await launchDetachedCheckpoint({ root: '/tree', replaceStale: true }, spawnFn as never, execFn, readLogHead);

    // The unit was never stopped and nothing launched: the caller must wait for the verdict.
    expect(execFn).not.toHaveBeenCalledWith('systemctl', ['--user', 'stop', `${checkpointUnitForRoot('/tree')}.service`]);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(r.launched).toBe(false);
    expect(r.reason).toBe('already_running');
    expect(r.alreadyRunning).toMatchObject({ candidate_stale: true, replace_refused_young: true });
    expect(typeof r.alreadyRunning?.elapsed_sec).toBe('number');
    expect(r.alreadyRunning?.elapsed_sec).toBeLessThan(REPLACE_STALE_MIN_AGE_SEC);
  });

  it('a stale run with UNKNOWN age is refused too (cannot prove it is wedged — never kill a possibly-healthy verdict)', async () => {
    const oldCandidate = '1111111111111111111111111111111111111111';
    const currentHead = '3333333333333333333333333333333333333333';
    const quietCandidate = '2222222222222222222222222222222222222222';
    const spawnFn = vi.fn();
    const stopCall = vi.fn();
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args[1] === 'stop') {
        stopCall();
        return { status: 0, stdout: '', stderr: '' };
      }
      // ActiveState reported, but NO ExecMainStartTimestamp → elapsed_sec null.
      if (cmd === 'systemctl' && args[1] === 'show') return fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: '' });
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${currentHead}\n`, stderr: '' };
      if (cmd === 'git' && args.includes('--format=%ct')) return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 30), stderr: '' };
      if (cmd === 'git' && args.includes('rev-list')) return { status: 0, stdout: `${quietCandidate}\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const readLogHead = vi.fn(() => `[green-checkpoint] checkpointing candidate ${oldCandidate.slice(0, 8)} (base def)\n`);

    const r = await launchDetachedCheckpoint({ root: '/tree', replaceStale: true }, spawnFn as never, execFn, readLogHead);

    expect(stopCall).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(r.launched).toBe(false);
    expect(r.alreadyRunning).toMatchObject({ replace_refused_young: true });
  });

  it('a NOT-stale active run is never stopped, even with replaceStale:true (the critical-danger guard)', async () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const spawnFn = vi.fn();
    const stopCall = vi.fn();
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args[1] === 'stop') {
        stopCall();
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'systemctl') return fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt });
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD') return { status: 0, stdout: 'abc\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate abc12345 (base def)\n');

    const r = await launchDetachedCheckpoint({ root: '/tree', replaceStale: true }, spawnFn as never, execFn, readLogHead);

    expect(stopCall).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(r.launched).toBe(false);
    expect(r.reason).toBe('already_running');
  });

  it('a FAILED stop refuses (already_running), same as an unreplaced stale run — no partial state', async () => {
    const spawnFn = vi.fn();
    const execFn = staleActiveExecFn(1); // stop fails
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');

    const r = await launchDetachedCheckpoint({ root: '/tree', replaceStale: true }, spawnFn as never, execFn, readLogHead);

    expect(spawnFn).not.toHaveBeenCalled();
    expect(r.launched).toBe(false);
    expect(r.reason).toBe('already_running');
    expect(r.replacedStale).toBeUndefined();
  });

  // WI-4957: a stopped run will NEVER produce a verdict for its candidate — any
  // checkpoint:await bound to it must be proactively retired, not left to time out
  // indistinguishable from "still judging" (the exact window a stray late verdict could
  // otherwise be mistaken for a live "go" signal).
  it('WI-4957: a successfully-stopped stale run triggers cancellation of awaits bound to ITS candidate, BEFORE the fresh run launches', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const execFn = staleActiveExecFn(0, 45);
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');
    const cancelStaleAwaits = vi.fn(async (_root: string, _staleCandidateSha: string) => ({ cancelled: 2 }));

    const p = launchDetachedCheckpoint(
      { root: '/tree', replaceStale: true },
      spawnFn as never,
      execFn,
      readLogHead,
      cancelStaleAwaits,
    );
    child.emit('close', 0);
    const r = await p;

    expect(cancelStaleAwaits).toHaveBeenCalledTimes(1);
    expect(cancelStaleAwaits).toHaveBeenCalledWith('/tree', '11111111');
    expect(r.launched).toBe(true);
  });

  it('WI-4957: a FAILED stop never calls cancelStaleAwaits (the run is not proven dead — nothing to retire)', async () => {
    const spawnFn = vi.fn();
    const execFn = staleActiveExecFn(1); // stop fails
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');
    const cancelStaleAwaits = vi.fn(async () => ({ cancelled: 0 }));

    await launchDetachedCheckpoint({ root: '/tree', replaceStale: true }, spawnFn as never, execFn, readLogHead, cancelStaleAwaits);

    expect(cancelStaleAwaits).not.toHaveBeenCalled();
  });

  it('WI-4957: a YOUNG stale run (refused, never stopped) never calls cancelStaleAwaits', async () => {
    const spawnFn = vi.fn();
    const execFn = staleActiveExecFn(0, 5); // young — refused before any stop attempt
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');
    const cancelStaleAwaits = vi.fn(async () => ({ cancelled: 0 }));

    await launchDetachedCheckpoint({ root: '/tree', replaceStale: true }, spawnFn as never, execFn, readLogHead, cancelStaleAwaits);

    expect(cancelStaleAwaits).not.toHaveBeenCalled();
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

/**
 * EI-18757156963245979 — the replace policy, as a pure rule.
 *
 * REGRESSION UNDER TEST (measured 2026-07-27; four consecutive gate runs died this way and
 * `main` sat 49 commits behind with nothing actually broken): replaceability was decided by
 * AGE alone. `REPLACE_STALE_MIN_AGE_SEC` (1200s) is meant to read "old enough to plausibly be
 * wedged", but the suite itself took 1180s under load — so a perfectly healthy run crossed the
 * age line ~20s AFTER finishing its suite, i.e. exactly as it entered the verdict path. A
 * peer's `replaceStale:true` then SIGTERMed candidate e4a93f8b 85 seconds into the stale-red
 * re-triage, discarding the auto-refire that would have re-fired the gate onto a newer tip.
 *
 * The invariant pinned here: a run that has published `delivering` is NEVER replaceable, at
 * ANY age. If an age-only decision is reintroduced, the `delivering` cases below go red —
 * instead of the gate silently failing to converge again hours later.
 */
describe('classifyReplaceRequest (EI-18757156963245979: never kill a run that is about to deliver)', () => {
  const OLD = REPLACE_STALE_MIN_AGE_SEC + 60;

  it('refuses a run in its VERDICT path even when it is old enough to look wedged', () => {
    // The exact e4a93f8b shape: stale candidate, past the age line, mid re-triage.
    expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec: OLD, delivering: true })).toEqual({
      replace: false,
      reason: 'delivering',
    });
  });

  it('phase beats age no matter how old the run gets (an age-only rule cannot pass this)', () => {
    for (const elapsed_sec of [OLD, OLD * 2, OLD * 10]) {
      expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec, delivering: true }).replace).toBe(false);
    }
  });

  it('still replaces a genuinely wedged run — old, stale, and NOT delivering (the EI-9672 case)', () => {
    expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec: OLD, delivering: false })).toEqual({
      replace: true,
    });
  });

  it('degrades to the age test when the run published no phase (older build / wedged early)', () => {
    // `delivering` undefined must not be read as "delivering" — that would make the flag inert.
    expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec: OLD })).toEqual({ replace: true });
    expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec: 60 })).toEqual({
      replace: false,
      reason: 'young',
    });
  });

  it('keeps the EI-11667 young-run guard: a young stale run is healthy-in-progress, not wedged', () => {
    expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec: 5 * 60, delivering: false })).toEqual({
      replace: false,
      reason: 'young',
    });
  });

  it('never touches a run judging the CURRENT candidate, regardless of age or phase', () => {
    expect(classifyReplaceRequest({ candidate_stale: false, elapsed_sec: OLD, delivering: false })).toEqual({
      replace: false,
      reason: 'not_stale',
    });
  });

  it('treats an unknown elapsed_sec as not-old-enough (systemd reported no start time)', () => {
    expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec: null })).toEqual({
      replace: false,
      reason: 'young',
    });
  });
});

/* ------------------------------------------------------------------------- *
 * P-004 (EI-18752644493166307) — does the judged candidate contain MY edits?
 *
 * The warning TEXT is the deliverable here, so it is asserted directly. The bug it
 * closes is a misREADING, not a missing field: a candidate without your fix reds on
 * the pre-fix failure with the pre-fix count, which reads as "your fix did not work"
 * and sends you to re-debug correct code.
 * ------------------------------------------------------------------------- */
describe('renderContainmentWarning (P-004)', () => {
  const p = (path: string, reason: 'uncommitted' | 'newer-commit' | 'absent') => ({
    path,
    inCandidate: false as const,
    reason,
    unknownReason: null,
  });

  it('pre-empts the misread: a red from this run is not evidence your fix failed', () => {
    const w = renderContainmentWarning(['a.ts'], [p('a.ts', 'uncommitted')], [], 'caller-supplied');
    expect(w).toMatch(/NOT evidence your change failed/);
    expect(w).toMatch(/ORIGINAL failure with the ORIGINAL count/);
  });

  it('routes an uncommitted miss to git-sync:run and a quiet-cut miss to the quiet window', () => {
    const uncommitted = renderContainmentWarning(['a.ts'], [p('a.ts', 'uncommitted')], [], 'caller-supplied');
    expect(uncommitted).toMatch(/git-sync:run/);
    expect(uncommitted).not.toMatch(/quiet window/);

    const newer = renderContainmentWarning(['b.ts'], [p('b.ts', 'newer-commit')], [], 'caller-supplied');
    expect(newer).toMatch(/quiet window/);
    // Sending an already-committed change to git-sync:run would waste another run.
    expect(newer).not.toMatch(/Fix: git-sync:run/);
  });

  /**
   * `absent` used to be folded into the NOT-COMMITTED bucket on the premise that a new
   * file "no commit can carry". False: a new file committed after the candidate is absent
   * there and committed here — the commonest shape on this tree, since the quiet-cut steps
   * the judged commit ~4 min behind the tip. The classifier now resolves that against HEAD,
   * so `absent` reaches this renderer ONLY when there was no HEAD to ask. Asserting
   * "NOT COMMITTED … Fix: git-sync:run" on that residue would state a lever that is a no-op
   * whenever the file was in fact already committed.
   */
  it('an absent-but-unknown miss does NOT claim "not committed", and prescribes no false lever', () => {
    const w = renderContainmentWarning(['new.test.ts'], [p('new.test.ts', 'absent')], [], 'caller-supplied');
    expect(w).toMatch(/committed-ness UNKNOWN/);
    expect(w).toMatch(/new\.test\.ts/);
    expect(w).not.toMatch(/NOT COMMITTED/);
    expect(w).not.toMatch(/Fix: git-sync:run/);
  });

  /**
   * The resolution of "if your fix is among them". The old warning named excluded SHAS,
   * which is the one space the reader has no information about — an agent knows its
   * FILES. Naming which excluded commit carries which file is the whole point.
   */
  it('names WHICH excluded commit carries the file, not just that commits were excluded', () => {
    const w = renderContainmentWarning(
      ['a.ts'],
      [p('a.ts', 'newer-commit')],
      [{ path: 'a.ts', commits: ['fff1234 my just-landed fix'] }],
      'caller-supplied',
    );
    expect(w).toMatch(/'a\.ts' is carried by EXCLUDED commit\(s\): fff1234 my just-landed fix/);
    expect(w).not.toMatch(/if your fix is among them/);
  });

  /**
   * This tree is edited concurrently by the whole fleet, so an INFERRED set routinely
   * contains peers' uncommitted work. Claiming those are "your files" is a false
   * positive, and a detector that cries wolf is one agents learn to scroll past —
   * which would cost more than the gap it closes.
   */
  it('claims ownership ONLY when the caller declared the paths', () => {
    const declared = renderContainmentWarning(['a.ts'], [p('a.ts', 'uncommitted')], [], 'caller-supplied');
    expect(declared).toMatch(/of your file\(s\)/);

    const inferred = renderContainmentWarning(['a.ts'], [p('a.ts', 'uncommitted')], [], 'inferred-uncommitted');
    expect(inferred).not.toMatch(/of your file\(s\)/);
    expect(inferred).toMatch(/may be a peer's/);
    // …and it must point at the route that WOULD give an exact answer.
    expect(inferred).toMatch(/pass `paths: \[\.\.\.\]`/);
  });

  /**
   * EI-18796358994458975: a torn TDD pair (test in, impl newer-commit) is a KNOWN false-red
   * shape, not just another "wait out the quiet window" miss — it must say so explicitly so
   * the reader does not spend the ~3h suite re-debugging code that was already correct.
   */
  it('names the torn-TDD-pair shape explicitly when splitRisk is detected', () => {
    const w = renderContainmentWarning(
      ['a.ts'],
      [p('a.ts', 'newer-commit')],
      [],
      'caller-supplied',
      { detected: true, includedTests: ['a.test.ts'], missingImpl: ['a.ts'] },
    );
    expect(w).toMatch(/KNOWN FALSE-RED SHAPE/);
    expect(w).toMatch(/torn TDD pair/);
    expect(w).toMatch(/a\.test\.ts/);
    expect(w).toMatch(/Do not debug it/);
  });

  it('says nothing about a torn pair when splitRisk is undetected or omitted', () => {
    const omitted = renderContainmentWarning(['a.ts'], [p('a.ts', 'newer-commit')], [], 'caller-supplied');
    expect(omitted).not.toMatch(/KNOWN FALSE-RED SHAPE/);

    const undetected = renderContainmentWarning(['a.ts'], [p('a.ts', 'newer-commit')], [], 'caller-supplied', {
      detected: false,
      includedTests: [],
      missingImpl: [],
    });
    expect(undetected).not.toMatch(/KNOWN FALSE-RED SHAPE/);
  });
});

describe('checkpointCandidateContainment (P-004)', () => {
  const BLOB_OLD = '0'.repeat(40);
  const BLOB_NEW = 'f'.repeat(40);

  /**
   * A git that answers by arg shape; status non-zero ⇒ the read FAILED (never "").
   * `<sha>^{commit}` resolves by default — the containment check probes that the candidate
   * COMMIT exists before judging any path, so a fixture that did not answer it would make
   * every case fall into the unknown branch.
   */
  const fakeExec =
    (answers: Record<string, string>) =>
    (_cmd: string, args: string[]) => {
      const key = args.slice(2).join(' ');
      if (key.endsWith('^{commit}') && !(key in answers)) return { status: 0, stdout: 'c'.repeat(40), stderr: '' };
      return key in answers
        ? { status: 0, stdout: answers[key], stderr: '' }
        : { status: 128, stdout: '', stderr: 'fatal' };
    };

  it('reports included/missing for caller-declared paths', async () => {
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'cand',
      paths: ['in.ts', 'out.ts'],
      execFn: fakeExec({
        'rev-parse --verify cand:in.ts': BLOB_OLD,
        'hash-object -- in.ts': BLOB_OLD,
        'rev-parse --verify cand:out.ts': BLOB_OLD,
        'hash-object -- out.ts': BLOB_NEW,
        'rev-parse --verify HEAD:out.ts': BLOB_OLD,
      }),
    });
    expect(r.source).toBe('caller-supplied');
    expect(r.included).toEqual(['in.ts']);
    expect(r.missing).toEqual(['out.ts']);
    expect(r.warning).toMatch(/THIS RUN WILL NOT SEE 1 of your file/);
  });

  it('is SILENT when every declared file is in the candidate — no warning to habituate to', async () => {
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'cand',
      paths: ['in.ts'],
      execFn: fakeExec({ 'rev-parse --verify cand:in.ts': BLOB_OLD, 'hash-object -- in.ts': BLOB_OLD }),
    });
    expect(r.missing).toEqual([]);
    expect(r.warning).toBeNull();
  });

  it('falls back to the working tree, and labels that set as INFERRED', async () => {
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'cand',
      execFn: fakeExec({
        'diff --name-only HEAD': 'dirty.ts',
        'ls-files --others --exclude-standard': '',
        'rev-parse --verify cand:dirty.ts': BLOB_OLD,
        'hash-object -- dirty.ts': BLOB_NEW,
        'rev-parse --verify HEAD:dirty.ts': BLOB_OLD,
      }),
    });
    expect(r.source).toBe('inferred-uncommitted');
    expect(r.missing).toEqual(['dirty.ts']);
    expect(r.warning).toMatch(/may be a peer's/);
  });

  it('attributes a missing file to the excluded commit that carries it', async () => {
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'tip',
      paths: ['a.ts'],
      execFn: fakeExec({
        'rev-parse --verify cand:a.ts': BLOB_OLD,
        'hash-object -- a.ts': BLOB_NEW,
        'rev-parse --verify HEAD:a.ts': BLOB_NEW,
        'log --oneline --no-decorate cand..tip -- a.ts': 'fff1234 my just-landed fix',
      }),
    });
    expect(r.excludedCommitsTouchingYourFiles).toEqual([{ path: 'a.ts', commits: ['fff1234 my just-landed fix'] }]);
    expect(r.warning).toMatch(/fff1234 my just-landed fix/);
  });

  it('a git that fails entirely produces UNKNOWN and NO warning — never a false all-clear', async () => {
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'cand',
      paths: ['a.ts'],
      execFn: () => ({ status: 128, stdout: '', stderr: 'fatal' }),
    });
    expect(r.unknown).toEqual(['a.ts']);
    expect(r.included).toEqual([]);
    expect(r.warning).toBeNull();
  });

  /**
   * EI-18796358994458975, reproduced end-to-end: candidate `2864c150` carried the test
   * (`deliberation-harness-fallback.test.ts`) but excluded the implementation commit
   * (`index.ts`, `newer-commit`) — a guaranteed-red candidate before the suite even runs.
   * `checkpointCandidateContainment` must surface this as `testImplSplitRisk.detected` AND
   * fold the explicit warning text into `warning`, so a caller who passes both files in
   * `paths` (as this incident's filer did) gets told the shape at launch time, for free.
   */
  it('detects + names the torn-TDD-pair shape from the real incident inputs', async () => {
    const TEST_FILE = 'packages/operator-core/lib/sync-resolver/deliberation-harness-fallback.test.ts';
    const IMPL_FILE = 'packages/operator-core/lib/sync-resolver/index.ts';
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'tip',
      paths: [TEST_FILE, IMPL_FILE],
      execFn: fakeExec({
        [`rev-parse --verify cand:${TEST_FILE}`]: BLOB_OLD,
        [`hash-object -- ${TEST_FILE}`]: BLOB_OLD,
        [`rev-parse --verify cand:${IMPL_FILE}`]: BLOB_OLD,
        [`hash-object -- ${IMPL_FILE}`]: BLOB_NEW,
        [`rev-parse --verify HEAD:${IMPL_FILE}`]: BLOB_NEW,
        [`log --oneline --no-decorate cand..tip -- ${IMPL_FILE}`]: '05422caf my just-landed fix',
      }),
    });
    expect(r.included).toEqual([TEST_FILE]);
    expect(r.missing).toEqual([IMPL_FILE]);
    expect(r.testImplSplitRisk).toEqual({ detected: true, includedTests: [TEST_FILE], missingImpl: [IMPL_FILE] });
    expect(r.warning).toMatch(/KNOWN FALSE-RED SHAPE/);
    expect(r.warning).toMatch(/torn TDD pair/);
  });
});
