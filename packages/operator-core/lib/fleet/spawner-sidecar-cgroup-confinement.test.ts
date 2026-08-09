/**
 * spawner-sidecar-cgroup-confinement.test.ts — EI-19479764372783341.
 *
 * THE PROPERTY: the spawner sidecar must be born into its OWN transient systemd
 * scope, which is a SIBLING of `papercup-bg-host.service`, not a child of it.
 *
 * Before this, the site was a raw `spawn(cmd, args, { detached: false })`, which
 * inherits the caller's cgroup. That put the sidecar — and the five desktop-app
 * `serve.mjs` processes it goes on to parent — inside bg-host's control group, so
 * `systemctl restart papercup-bg-host` (the documented way to activate ANY
 * routines code change) killed all of them, plus an in-flight `pg_dump`: ~208
 * tasks measured 2026-08-04. All three restart triggers hit it, including
 * `bghost-watchdog.mjs` firing UNATTENDED, which alerts nobody on a single
 * successful restart.
 *
 * WHY THIS FILE EXISTS RATHER THAN A LINT RULE: `lint:no-unenrolled-spawn` keys on
 * `detached: true`, and this site is `detached: false` — it was invisible to that
 * guard BY CONSTRUCTION, never even reaching its allowlist (EI-19483245448673321).
 * Detachment is the wrong property; the hazard is CGROUP LIFETIME COUPLING, which
 * a long-lived `detached: false` child has in full. So the property is asserted
 * here, against the argv that actually reaches `spawn()`.
 *
 * FALSIFIABILITY: `legacyRawSpawnArgv()` below is a PERMANENT control — the exact
 * pre-fix launch shape, kept in this file and asserted to FAIL the same predicate
 * the real subject must pass. A guard that has never failed is a guard nobody has
 * tested; keeping the wrong implementation here means the predicate is proven
 * discriminating on every run, without ever mutating the shared tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
// Partial mock — keep the real surface for everything this file does not stub
// (a full replacement breaks at import time on transitive promisify(execFile)).
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...a: unknown[]) => spawnMock(...a),
}));

// Hermetic ledger. The real store needs Postgres, and this file is about the
// ARGV, not the database — but it also lets us drive the two ledger failure
// modes deliberately, which is the point of the fail-soft cases below.
const L = vi.hoisted(() => ({
  registerThrows: null as Error | null,
  markThrows: null as Error | null,
  marked: [] as unknown[],
}));
// The task-manager flag. `setTaskManagerEnabledForTest` is NOT enough here: it
// only sets the cache the SYNC reader consults, while `managedSpawn` takes the
// ASYNC `isTaskManagerEnabled()`, which unconditionally awaits `getFlag(...)`.
// With no flag backend in a unit test that promise simply stays pending, so the
// spawn never happens and every assertion below reads "called 0 times" — a
// hang wearing the costume of a missing call.
vi.mock('../task-manager/enabled', () => ({
  isTaskManagerEnabled: async () => true,
  taskManagerEnabledSync: () => true,
  warmTaskManagerFlag: () => {},
  setTaskManagerEnabledForTest: () => {},
}));

vi.mock('../task-manager/store', () => ({
  registerTask: async (_spec: unknown, opts: { taskId?: string }) => {
    if (L.registerThrows) throw L.registerThrows;
    return { taskId: opts?.taskId ?? 'task-test', state: 'pending' };
  },
  markSpawned: async (_id: string, v: unknown) => {
    if (L.markThrows) throw L.markThrows;
    L.marked.push(v);
  },
  closeTask: async () => {},
}));

import { _resetSpawnerSidecarSpawnStateForTests, spawnSpawnerSidecar } from './spawner-sidecar-spawn';
import { probeScopeSupport, resetScopeProbe } from '../task-manager/managed-spawn';
import { setTaskManagerEnabledForTest } from '../task-manager/enabled';

type FakeChild = EventEmitter & {
  pid: number;
  killed: boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    child.killed = true;
  });
  return child;
}

/** Let the promise chain inside managedSpawn (probe → ledger → spawn) settle.
 *  managedSpawn is async, so unlike the old synchronous spawn() the child does
 *  not exist on the tick the caller returns. */
async function flush(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/**
 * THE PREDICATE. "Was this launch confined into its own transient scope?"
 *
 * `--scope` (not `--service`/`--unit=…service`) is load-bearing twice over: the
 * payload stays OUR child, so piped stdio survives and the PAPERCUSP_SPAWNER_READY
 * handshake still arrives; and the transient scope is a SIBLING of the calling
 * service, so KillMode=control-group on that service cannot reach it.
 */
function isConfinedToSiblingScope(cmd: string, args: string[]): boolean {
  return (
    cmd === 'systemd-run' &&
    args.includes('--user') &&
    args.includes('--scope') &&
    args.some((a) => a.startsWith('--unit='))
  );
}

/** THE PERMANENT CONTROL — the pre-fix launch shape, verbatim in spirit:
 *  `spawn(cmd, args, { detached: false })`, no wrapper, inherits the caller's
 *  cgroup. Kept forever so `isConfinedToSiblingScope` is proven able to FAIL. */
function legacyRawSpawnArgv(): [string, string[]] {
  return ['npx', ['tsx', '/repo/apps/operator/bin/spawner-sidecar.ts']];
}

/** Seed the module-level scope probe without letting its own `systemd-run` spawn
 *  reach `spawnMock` — that leak shifts every `spawnMock.mock.calls[N]` index a
 *  test reads (WI-7377). */
async function seedScopeProbe(ok: boolean): Promise<void> {
  resetScopeProbe();
  await probeScopeSupport(((): unknown => {
    const c = makeChild();
    process.nextTick(() => c.emit('exit', ok ? 0 : 1));
    return c;
  }) as never);
}

const SOCK = '/tmp/papercusp-test-spawner.sock';

describe('spawner sidecar cgroup confinement (EI-19479764372783341)', () => {
  beforeEach(async () => {
    spawnMock.mockReset();
    L.registerThrows = null;
    L.markThrows = null;
    L.marked = [];
    _resetSpawnerSidecarSpawnStateForTests();
    setTaskManagerEnabledForTest(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedScopeProbe(true);
  });

  afterEach(() => {
    _resetSpawnerSidecarSpawnStateForTests();
    setTaskManagerEnabledForTest(null);
    resetScopeProbe();
    vi.restoreAllMocks();
  });

  it('launches the sidecar into a NAMED transient --user --scope (a sibling of bg-host), not bg-host\'s own cgroup', async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];

    expect(isConfinedToSiblingScope(cmd, args)).toBe(true);
    // Into the SIDECAR class slice — that grouping is what makes the subtree
    // enumerable no matter how the child goes on to fork.
    expect(args).toContain('--slice=papercusp-sidecar.slice');
    // The real payload is appended verbatim at the tail (buildTaskScopeArgv
    // pushes `...base` last; there is deliberately no `--` separator).
    expect(args[args.length - 1]).toContain('spawner-sidecar');

    // ...and the handshake still arrives THROUGH the scope wrapper. This is the
    // property that made the change safe to make: `--scope` execs in the caller's
    // context, so stdout is still a pipe we own (verified against a real
    // systemd-run in isolation before the change; asserted structurally here).
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(p).resolves.toBeUndefined();
  });

  it('CONTROL: the pre-fix raw spawn shape FAILS the same predicate (proves it can fail)', () => {
    const [cmd, args] = legacyRawSpawnArgv();
    expect(isConfinedToSiblingScope(cmd, args)).toBe(false);
  });

  it('CALIBRATION: the predicate rejects a --service wrapper too — only --scope keeps piped stdio and sibling lifetime', () => {
    expect(isConfinedToSiblingScope('systemd-run', ['--user', '--unit=x.service', '--', 'node', 'x'])).toBe(false);
    expect(isConfinedToSiblingScope('systemd-run', ['--scope', '--unit=x.scope', '--', 'node', 'x'])).toBe(false); // no --user
  });

  // ── fail-soft: the ledger must never be able to take down agent-spawn ───────
  //
  // managed-spawn's header promises "FAILS SOFT, ALWAYS ... refusing to spawn
  // because the task manager is unavailable would make an observability feature
  // into an outage." That covered the systemd leg but NOT the ledger leg, whose
  // INSERT was unguarded — so before this, a PG blip threw straight out of the
  // chokepoint and the fleet's agent-spawn path simply did not come up.

  it('still spawns — and still CONFINES — when the ledger register fails (PG down)', async () => {
    L.registerThrows = new Error('connection refused');
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    // Confinement does not depend on the database: the scope name is derived
    // locally, so a ledger outage costs accounting, never isolation.
    expect(isConfinedToSiblingScope(cmd, args)).toBe(true);

    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(p).resolves.toBeUndefined();
  });

  it('does not abandon a LIVE child when markSpawned fails after the fork', async () => {
    L.markThrows = new Error('write timeout');
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    // The child is already running by the time markSpawned runs; a throw there
    // would report a failed spawn while leaking the process.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(p).resolves.toBeUndefined();
  });

  it('degrades to an UNCONFINED plain spawn on a box with no working user scopes (never refuses to spawn)', async () => {
    await seedScopeProbe(false);
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(isConfinedToSiblingScope(cmd, args)).toBe(false); // unconfined, by design
    expect(cmd).not.toBe('systemd-run'); // the payload itself, no wrapper

    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(p).resolves.toBeUndefined();
  });

  // EI-20006410617437313. The UNCONFINED notice is an OPERATOR-RUNTIME diagnostic:
  // it tells a human that a bg-host restart will take the sidecar with it. Under a
  // test runner it is never the subject — confinement there depends on ambient host
  // state the test neither sets up nor asserts on (the task manager is disabled on
  // most boxes), so the SAME COMMIT warns or stays quiet depending on the machine.
  // `vitest-fail-on-console` then converts that ambient condition into a red on
  // whichever test is executing, and because `warnedUnconfined` is a MODULE-SCOPED
  // latch the victim is simply the first file in the worker to touch this path —
  // measured landing on `scout/observation-consumption-wiring.test.ts`, which has
  // nothing to do with sidecar confinement.
  //
  // Note this file could never have caught that: its own `beforeEach` installs a
  // blanket `vi.spyOn(console, 'warn')`, so the one suite that most exercises the
  // unconfined path is precisely the one that cannot see the warn. Hence an
  // explicit assertion rather than reliance on fail-on-console.
  it('does NOT emit the UNCONFINED diagnostic through console.warn under a test runner', async () => {
    await seedScopeProbe(false);
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    // The spawn really did go out unconfined — otherwise this asserts nothing.
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(isConfinedToSiblingScope(cmd, args)).toBe(false);

    const warned = warn.mock.calls.map((c) => String(c[0] ?? ''));
    expect(warned.filter((m) => m.includes('UNCONFINED'))).toEqual([]);

    // CALIBRATION: prove the assertion above is live rather than vacuously true.
    // A spy that records nothing would satisfy it even if the diagnostic were
    // still being emitted, so demonstrate this spy does capture a real warn.
    console.warn('[calibration] UNCONFINED — this control MUST be captured');
    expect(warn.mock.calls.map((c) => String(c[0] ?? '')).filter((m) => m.includes('UNCONFINED'))).toHaveLength(1);

    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(p).resolves.toBeUndefined();
  });

  // ── the re-entrancy window the async chokepoint opened ─────────────────────

  it('two concurrent callers spawn exactly ONE sidecar (managedSpawn is async — the old raw spawn was not)', async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const a = spawnSpawnerSidecar(SOCK);
    const b = spawnSpawnerSidecar(SOCK);
    await flush();

    // Without the in-flight guard both callers sail past the `sidecarProcess`
    // null-check (it is no longer in the same tick as the assignment) and race
    // for the pid-keyed socket.
    expect(spawnMock).toHaveBeenCalledTimes(1);

    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
  });
});
