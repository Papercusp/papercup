/** Regression coverage for serialize-and-slow-kopia-backups-2026-08-20. */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOST_BACKUP_APPLICATION_NAME,
  WORKSPACE_BACKUP_APPLICATION_NAME,
} from '@papercusp/backup/application-names';

const systemdDir = fileURLToPath(new URL('../../../apps/operator/scripts/systemd/', import.meta.url));
const guard = join(systemdDir, 'kopia-backup-guard.sh');
const hotScriptPath = join(systemdDir, 'kopia-snapshot-all.sh');
const tempDirs: string[] = [];

function pressureFile(path: string, fullAvg10: number): void {
  writeFileSync(
    path,
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=${fullAvg10.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`,
  );
}

function fixture(memory = 0, io = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'kopia-guard-'));
  tempDirs.push(dir);
  const memoryPath = join(dir, 'memory.pressure');
  const ioPath = join(dir, 'io.pressure');
  pressureFile(memoryPath, memory);
  pressureFile(ioPath, io);
  return {
    dir,
    env: {
      ...process.env,
      GUARD: guard,
      KOPIA_BACKUP_LOCK_PATH: join(dir, 'global.lock'),
      // Per-fixture, and NOT optional. The guard's staleness floor keeps its
      // bookkeeping under $XDG_STATE_HOME/$HOME by default, so without this every
      // test would read and write the REAL host's backup state: tests would
      // pollute production bookkeeping, and — worse — become order-dependent on
      // it, since a stale baseline left by the host makes a deferral test admit.
      KOPIA_BACKUP_STATE_DIR: join(dir, 'state'),
      KOPIA_BACKUP_MEM_PSI_PATH: memoryPath,
      KOPIA_BACKUP_IO_PSI_PATH: ioPath,
      KOPIA_BACKUP_MEM_FULL_AVG10_MAX: '5',
      KOPIA_BACKUP_IO_FULL_AVG10_MAX: '10',
      KOPIA_BACKUP_MONITOR_INTERVAL_SEC: '0.05',
      // The guard's OWN production default (20s), not a shortened test value. This was '2',
      // which made the runtime-pressure test a bet on host scheduling latency: the grace is
      // how long a TERM'd child has to run its trap, and on a loaded box (this one carries
      // ~76 agents) a bash child is not always scheduled within 2s. Past the deadline the
      // guard escalates to `kill -KILL`, and bash then writes its own job-control notice —
      // `kopia-backup-guard.sh: line NNN: <pid> Killed "$@"` — to the script's stderr, which
      // `expect(stderr).toBe('')` reads as a failure. Measured on the gate: 8 CI failures
      // across candidates 8e567cf5 and 8b151666 (2026-09-02), passing locally every time.
      // Raising it costs NOTHING in the happy path: `stop_grace` is a DEADLINE, not a sleep —
      // the guard polls `kill -0` every 0.1s and breaks the moment the child exits. No test
      // asserts the `killing-after-grace` escalation, so nothing depends on the short value.
      KOPIA_BACKUP_STOP_GRACE_SEC: '20',
    },
  };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [guard, ...args], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Kopia global backup guard', () => {
  it('uses one host-global default lock namespace instead of an effective-UID runtime', () => {
    const source = readFileSync(guard, 'utf8');

    expect(source).toContain(
      'lock_path="${KOPIA_BACKUP_LOCK_PATH:-/run/lock/papercusp/kopia-global.lock}"',
    );
    expect(source).not.toContain('runtime_dir=');
  });

  it('is valid shell and executes scheduled work under safe pressure', () => {
    expect(spawnSync('bash', ['-n', guard], { timeout: 10_000, killSignal: 'SIGKILL' }).status).toBe(0);
    const { dir, env } = fixture();
    const marker = join(dir, 'ran');
    const result = run(['--mode', 'scheduled', '--label', 'test', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('');
    expect(result.stdout).toContain('result=started mode=scheduled');
  });

  it('parses the complete guard before starting work so a live source update cannot tear it', async () => {
    const { dir, env } = fixture();
    const canonicalGuard = join(dir, 'canonical-guard.sh');
    const installedGuard = join(dir, 'installed-guard.sh');
    const ready = join(dir, 'ready');
    const source = readFileSync(guard, 'utf8');
    const commandTail = '"$@" &';
    expect(source).toContain(commandTail);

    // Make the still-unparsed tail much larger than Bash's read buffer. A
    // top-level implementation starts the child before this tail is parsed;
    // the parse-sealed main() implementation must parse it before any child
    // can create READY.
    const padding = Array.from(
      { length: 8_192 },
      (_, index) => `: # LIVE_SOURCE_PAD_${index.toString().padStart(5, '0')}\n`,
    ).join('');
    const paddedSource = source.replace(commandTail, `"$@" &\n${padding}child_pid=$!`);
    const mutationOffset = paddedSource.lastIndexOf(': # LIVE_SOURCE_PAD_');
    expect(mutationOffset).toBeGreaterThan(0);

    writeFileSync(canonicalGuard, paddedSource, { mode: 0o755 });
    symlinkSync(canonicalGuard, installedGuard);

    const child = spawn(
      'bash',
      [
        installedGuard,
        '--mode',
        'wait',
        '--label',
        'live-source-update',
        '--',
        'bash',
        '-c',
        'touch "$1"; sleep 0.4',
        '_',
        ready,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));

    await waitForPath(ready);
    const fd = openSync(canonicalGuard, 'r+');
    try {
      const brokenTail = Buffer.from('broken="');
      writeSync(fd, brokenTail, 0, brokenTail.length, mutationOffset);
      ftruncateSync(fd, mutationOffset + brokenTail.length);
    } finally {
      closeSync(fd);
    }

    const status = await closed;
    expect(status, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain('result=finished mode=wait rc=0');
  });

  it.each([
    ['memory', 5, 0, 'memory-pressure'],
    ['io', 0, 10, 'io-pressure'],
  ])('defers scheduled work at unsafe %s full PSI', (_signal, memory, io, reason) => {
    const { dir, env } = fixture(memory, io);
    const marker = join(dir, 'must-not-run');
    const result = run(['--mode', 'scheduled', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`result=deferred reason=${reason}`);
    expect(spawnSync('test', ['-e', marker], { timeout: 5_000, killSignal: 'SIGKILL' }).status).not.toBe(0);
  });

  it('fails safe when scheduled pressure telemetry is unavailable', () => {
    const { dir, env } = fixture();
    env.KOPIA_BACKUP_MEM_PSI_PATH = join(dir, 'missing-pressure-file');
    const marker = join(dir, 'must-not-run');
    const result = run(['--mode', 'scheduled', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('result=deferred reason=pressure-unavailable signal=memory');
    expect(spawnSync('test', ['-e', marker], { timeout: 5_000, killSignal: 'SIGKILL' }).status).not.toBe(0);
  });

  it('stops only the scheduled child when memory pressure rises during the run', async () => {
    const { dir, env } = fixture();
    const ready = join(dir, 'ready');
    const stopped = join(dir, 'stopped');
    const child = spawn(
      'bash',
      [
        guard,
        '--mode',
        'scheduled',
        '--label',
        'runtime-pressure',
        '--',
        'bash',
        '-c',
        'trap \'touch "$2"; exit 143\' TERM; touch "$1"; while :; do sleep 0.1; done',
        '_',
        ready,
        stopped,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));

    await waitForPath(ready);
    pressureFile(env.KOPIA_BACKUP_MEM_PSI_PATH!, 6);

    await expect(closed).resolves.toBe(0);
    expect(stderr).toBe('');
    expect(existsSync(stopped)).toBe(true);
    expect(stdout).toContain('result=stopping-during-run reason=memory-pressure');
    expect(stdout).toContain('result=deferred-during-run reason=memory-pressure');
    expect(stdout).not.toContain('result=finished mode=scheduled');
    // The grace must actually be HONOURED, not just configured. Asserting the absence of the
    // escalation is what pins that: the guard computed its stop deadline with a bare awk
    // `print`, whose default OFMT (%.6g) truncated the epoch to 1.78836e+09 — ~3700s in the
    // past — so the grace loop exited on its first evaluation and every TERM'd child was
    // SIGKILLed within ~50ms regardless of KOPIA_BACKUP_STOP_GRACE_SEC. The stderr assertion
    // above only caught it as a side effect (bash's job-control notice) and read as a flake;
    // this asserts the behaviour directly.
    expect(stdout).not.toContain('result=killing-after-grace');
    // 30s, deliberately WIDER than the fixture's 20s KOPIA_BACKUP_STOP_GRACE_SEC. There is no
    // testTimeout in either vitest config, so the default is 5s — narrower than the grace the
    // guard is configured to honour. A child slow to be scheduled would then blow the test
    // timeout before the guard ever reached its deadline, and the grace could never actually
    // be exercised. Costs nothing normally: this test completes in well under a second when
    // the child handles TERM promptly.
  }, 30_000);

  it('defers a scheduled contender while a backup holds the lock', () => {
    const { dir, env } = fixture();
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode wait --label holder -- bash -c 'touch "$1"; sleep 0.4' _ "$READY" &
        holder=$!
        for _ in $(seq 1 100); do [ -e "$READY" ] && break; sleep 0.01; done
        [ -e "$READY" ] || exit 91
        out=$("$GUARD" --mode scheduled --label contender -- touch "$CONTENDER")
        rc=$?
        wait "$holder"
        [ "$rc" -eq 0 ] && [ ! -e "$CONTENDER" ] && grep -q 'result=deferred reason=lock-held' <<<"$out"
      `,
      ],
      {
        encoding: 'utf8',
        env: { ...env, READY: join(dir, 'ready'), CONTENDER: join(dir, 'contender') },
        timeout: 10_000,
      },
    );

    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}`).toBe(0);
  });

  it('hands the lock to a wait-mode producer instead of starving behind a hot sweep', () => {
    const { dir, env } = fixture();
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label hot -- bash -c 'touch "$1"; while :; do sleep 0.05; done' _ "$HOT_READY" >"$HOT_LOG" 2>&1 &
        hot=$!
        for _ in $(seq 1 100); do [ -e "$HOT_READY" ] && break; sleep 0.01; done
        [ -e "$HOT_READY" ] || exit 91
        "$GUARD" --mode wait --label db-dump -- bash -c 'touch "$1"' _ "$DB_RAN" >"$DB_LOG" 2>&1 &
        db=$!
        wait "$db"
        wait "$hot"
        [ -e "$DB_RAN" ] &&
          grep -q 'result=stopping-during-run reason=priority-waiter' "$HOT_LOG"
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...env,
          HOT_READY: join(dir, 'hot-ready'),
          HOT_LOG: join(dir, 'hot.log'),
          DB_RAN: join(dir, 'db-ran'),
          DB_LOG: join(dir, 'db.log'),
        },
        timeout: 10_000,
      },
    );

    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}`).toBe(0);
  });

  it('waits for the current holder and releases the lock after failure', () => {
    const { dir, env } = fixture();
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode wait --label holder -- bash -c 'touch "$1"; sleep 0.3' _ "$READY" &
        holder=$!
        for _ in $(seq 1 100); do [ -e "$READY" ] && break; sleep 0.01; done
        [ -e "$READY" ] || exit 91
        "$GUARD" --mode wait --label waiter -- touch "$WAITER"
        wait "$holder"
        [ -e "$WAITER" ]
      `,
      ],
      {
        encoding: 'utf8',
        env: { ...env, READY: join(dir, 'ready'), WAITER: join(dir, 'waiter') },
        timeout: 10_000,
      },
    );
    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}`).toBe(0);

    expect(run(['--mode', 'wait', '--', 'bash', '-c', 'exit 42'], env).status).toBe(42);
    const marker = join(dir, 'after-failure');
    const next = run(['--mode', 'scheduled', '--', 'touch', marker], env);
    expect(next.status, next.stderr).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('');
  });

  const canRunMixedUid =
    typeof process.getuid === 'function' && process.getuid() !== 0
      ? spawnSync('sudo', ['-n', '-u', 'root', 'true'], {
          stdio: 'ignore',
          timeout: 10_000,
          killSignal: 'SIGKILL',
        }).status === 0
      : false;

  it.skipIf(!canRunMixedUid)('serializes user and root guards in both directions', () => {
    const userHolder = fixture();
    const userReady = join(userHolder.dir, 'user-ready');
    const rootMarker = join(userHolder.dir, 'root-marker');
    const userScenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode wait --label user-holder -- bash -c 'test "$(id -u)" -ne 0 && touch "$1"; sleep 0.35' _ "$USER_READY" >"$USER_READY.user.log" 2>&1 &
        holder=$!
        for _ in $(seq 1 100); do [ -e "$USER_READY" ] && break; sleep 0.01; done
        [ -e "$USER_READY" ] || exit 91
        started=$(date +%s%3N)
        sudo -n -u root env -u XDG_RUNTIME_DIR KOPIA_BACKUP_LOCK_PATH="$LOCK_PATH" KOPIA_BACKUP_MEM_PSI_PATH="$MEMORY_PATH" KOPIA_BACKUP_IO_PSI_PATH="$IO_PATH" KOPIA_BACKUP_MEM_FULL_AVG10_MAX=5 KOPIA_BACKUP_IO_FULL_AVG10_MAX=10 bash "$GUARD" --mode wait --label root-waiter -- bash -c 'test "$(id -u)" -eq 0 && touch "$1"' _ "$ROOT_MARKER" >"$ROOT_MARKER.root.log" 2>&1
        root_rc=$?
        elapsed=$(( $(date +%s%3N) - started ))
        wait "$holder"
        [ "$root_rc" -eq 0 ] && [ -e "$ROOT_MARKER" ] && [ "$elapsed" -ge 250 ]
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...userHolder.env,
          GUARD: guard,
          LOCK_PATH: join(userHolder.dir, 'global.lock'),
          MEMORY_PATH: join(userHolder.dir, 'memory.pressure'),
          IO_PATH: join(userHolder.dir, 'io.pressure'),
          USER_READY: userReady,
          ROOT_MARKER: rootMarker,
        },
        timeout: 10_000,
      },
    );
    expect(userScenario.status, `${userScenario.stdout}\n${userScenario.stderr}`).toBe(0);

    const rootHolder = fixture();
    const rootReady = join(rootHolder.dir, 'root-ready');
    const userMarker = join(rootHolder.dir, 'user-marker');
    const rootScenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        sudo -n -u root env -u XDG_RUNTIME_DIR KOPIA_BACKUP_LOCK_PATH="$LOCK_PATH" KOPIA_BACKUP_MEM_PSI_PATH="$MEMORY_PATH" KOPIA_BACKUP_IO_PSI_PATH="$IO_PATH" KOPIA_BACKUP_MEM_FULL_AVG10_MAX=5 KOPIA_BACKUP_IO_FULL_AVG10_MAX=10 bash "$GUARD" --mode wait --label root-holder -- bash -c 'test "$(id -u)" -eq 0 && touch "$1"; sleep 0.35' _ "$ROOT_READY" >"$ROOT_READY.root.log" 2>&1 &
        holder=$!
        for _ in $(seq 1 100); do [ -e "$ROOT_READY" ] && break; sleep 0.01; done
        [ -e "$ROOT_READY" ] || exit 91
        started=$(date +%s%3N)
        env XDG_RUNTIME_DIR="$USER_RUNTIME" KOPIA_BACKUP_LOCK_PATH="$LOCK_PATH" KOPIA_BACKUP_MEM_PSI_PATH="$MEMORY_PATH" KOPIA_BACKUP_IO_PSI_PATH="$IO_PATH" KOPIA_BACKUP_MEM_FULL_AVG10_MAX=5 KOPIA_BACKUP_IO_FULL_AVG10_MAX=10 bash "$GUARD" --mode wait --label user-waiter -- bash -c 'test "$(id -u)" -ne 0 && touch "$1"' _ "$USER_MARKER" >"$USER_MARKER.user.log" 2>&1
        user_rc=$?
        elapsed=$(( $(date +%s%3N) - started ))
        wait "$holder"
        [ "$user_rc" -eq 0 ] && [ -e "$USER_MARKER" ] && [ "$elapsed" -ge 250 ]
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...rootHolder.env,
          GUARD: guard,
          LOCK_PATH: join(rootHolder.dir, 'global.lock'),
          USER_RUNTIME: join(rootHolder.dir, 'user-runtime'),
          MEMORY_PATH: join(rootHolder.dir, 'memory.pressure'),
          IO_PATH: join(rootHolder.dir, 'io.pressure'),
          ROOT_READY: rootReady,
          USER_MARKER: userMarker,
        },
        timeout: 10_000,
      },
    );
    expect(rootScenario.status, `${rootScenario.stdout}\n${rootScenario.stderr}`).toBe(0);
  });
});

describe('Kopia managed entrypoint contract', () => {
  const hotService = readFileSync(join(systemdDir, 'kopia-snapshots.service'), 'utf8');
  const homeService = readFileSync(join(systemdDir, 'kopia-home-snapshot.service'), 'utf8');
  const hotScript = readFileSync(join(systemdDir, 'kopia-snapshot-all.sh'), 'utf8');
  const homeScript = readFileSync(join(systemdDir, 'kopia-home-snapshot.sh'), 'utf8');
  const protectedScript = readFileSync(join(systemdDir, 'kopia-protected-snapshot.sh'), 'utf8');
  const dbService = readFileSync(join(systemdDir, 'papercusp-db-backup.service'), 'utf8');
  const dbScript = readFileSync(join(systemdDir, 'papercusp-db-backup.sh'), 'utf8');
  const timer = readFileSync(join(systemdDir, 'kopia-snapshots.timer'), 'utf8');
  const healthcheck = readFileSync(join(systemdDir, 'kopia-healthcheck.sh'), 'utf8');

  it('routes every managed path through the same guard', () => {
    expect(hotService).toContain('kopia-backup-guard.sh --mode scheduled --label hot');
    expect(homeService).toContain('kopia-backup-guard.sh --mode wait --label daily-home-vm');
    expect(hotScript).toContain('--mode scheduled --label hot');
    expect(homeScript).toContain('--mode wait --label daily-home-vm');
    expect(protectedScript).toContain('--mode wait --label protected-manual');
    expect(dbService).toContain('kopia-backup-guard.sh --mode wait --label db-dump');
    expect(dbService).toContain('-- %h/papercupai-workspace/papercusp/apps/operator/scripts/systemd/papercusp-db-backup.sh');
    expect(hotScript).not.toContain('snapshot-all.lock');
    expect(homeScript).not.toContain('home-snapshot.lock');
    expect(hotService).toContain('ExecStopPost=%h/.config/kopia/snapshot-all.sh --cleanup');
  });

  it('bounds the hot snapshot with the proven daily parallelism and memory envelope', () => {
    expect(hotScript).toContain('snapshot create "--parallel=1" "$@"');
    expect(hotService).toContain('MemoryAccounting=yes');
    expect(hotService).toContain('MemoryHigh=8G');
    expect(hotService).toContain('MemoryMax=12G');
    expect(hotService).toContain('MemorySwapMax=0');
    expect(hotService).toContain('TimeoutStopSec=30s');
  });

  it('bounds the hourly database dump after a serialized run breached host PSI', () => {
    expect(dbService).toContain('MemoryAccounting=yes');
    expect(dbService).toContain('MemoryHigh=32G');
    expect(dbService).toContain('MemoryMax=40G');
    expect(dbService).toContain('MemorySwapMax=0');
    expect(dbService).toContain('OOMPolicy=kill');
    expect(dbService).toContain('kopia-backup-guard.sh --mode wait --label db-dump');
  });

  it('reaps only host-owned database dumps, never the concurrent workspace dump', () => {
    expect(HOST_BACKUP_APPLICATION_NAME).not.toBe(WORKSPACE_BACKUP_APPLICATION_NAME);
    expect(dbScript).toContain(
      `readonly HOST_BACKUP_APPLICATION_NAME=${HOST_BACKUP_APPLICATION_NAME}`,
    );
    expect(dbScript).toContain(
      "WHERE application_name = '$HOST_BACKUP_APPLICATION_NAME' AND pid <> pg_backend_pid();",
    );
    expect(dbScript).not.toContain(
      `WHERE application_name = '${WORKSPACE_BACKUP_APPLICATION_NAME}'`,
    );
  });

  it('hot cleanup kills only the exact recorded root Kopia child', () => {
    const { dir } = fixture();
    const stateDir = join(dir, 'state');
    const procRoot = join(dir, 'proc');
    const exactPid = '4242';
    const reusedPid = '4343';
    const fakeKopia = join(dir, 'kopia');
    const fakeOther = join(dir, 'other');
    const sudoStub = join(dir, 'sudo-stub.sh');
    const killLog = join(dir, 'kill.log');
    const pidFile = join(stateDir, 'snapshot-all.kopia.pid');

    mkdirSync(stateDir);
    mkdirSync(join(procRoot, exactPid), { recursive: true });
    mkdirSync(join(procRoot, reusedPid), { recursive: true });
    writeFileSync(fakeKopia, 'fixture');
    writeFileSync(fakeOther, 'fixture');
    symlinkSync(fakeKopia, join(procRoot, exactPid, 'exe'));
    symlinkSync(fakeOther, join(procRoot, reusedPid, 'exe'));
    writeFileSync(join(procRoot, exactPid, 'cmdline'), Buffer.from(`${fakeKopia}\0snapshot\0create\0/source\0`));
    writeFileSync(join(procRoot, reusedPid, 'cmdline'), Buffer.from(`${fakeOther}\0sleep\0`));
    writeFileSync(sudoStub, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >>"$KOPIA_TEST_KILL_LOG"\n');
    chmodSync(sudoStub, 0o755);

    const env = {
      ...process.env,
      KOPIA_SNAPSHOT_LOG_DIR: stateDir,
      KOPIA_SNAPSHOT_PROC_ROOT: procRoot,
      KOPIA_SNAPSHOT_SUDO: sudoStub,
      KOPIA_SNAPSHOT_BIN: fakeKopia,
      KOPIA_TEST_KILL_LOG: killLog,
    };

    writeFileSync(pidFile, `${exactPid}\n`);
    const killed = spawnSync('bash', [hotScriptPath, '--cleanup'], {
      encoding: 'utf8',
      env,
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    expect(killed.status).toBe(0);
    expect(readFileSync(killLog, 'utf8')).toContain(`-KILL ${exactPid}`);
    expect(existsSync(pidFile)).toBe(false);

    writeFileSync(pidFile, `${reusedPid}\n`);
    const refused = spawnSync('bash', [hotScriptPath, '--cleanup'], {
      encoding: 'utf8',
      env,
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    expect(refused.status).toBe(0);
    expect(readFileSync(killLog, 'utf8')).not.toContain(`-KILL ${reusedPid}`);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('pins the 30-minute cadence and matching 60-minute stale threshold', () => {
    expect(timer).toMatch(/^OnCalendar=\*:0\/30$/m);
    expect(healthcheck).toContain('MAX_SNAP_AGE_S="${MAX_SNAP_AGE_S:-3600}"');
  });

  it('keeps the hourly database writer canonical and dedupe-friendly', () => {
    const executableDbScript = dbScript
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(dbService).toContain(
      '-- %h/papercupai-workspace/papercusp/apps/operator/scripts/systemd/papercusp-db-backup.sh',
    );
    expect(dbService).not.toContain('%h/.config/kopia/db-backup.sh');
    expect(executableDbScript.match(/--compress=none/g)).toHaveLength(2);
    expect(executableDbScript).not.toMatch(/(?:^|\s)-Z1(?:\s|$)/m);
    expect(dbScript).toContain('pg_restore -l');
  });

  // WI-2146225 defect B. The pressure gate had no floor, so on a host whose
  // memory PSI sits permanently above the budget it did not DELAY the backup, it
  // CANCELLED it — every cycle deferred for the same reason while the service
  // still reported healthy. Measured 2026-09-05: full avg10=23.84 against a
  // limit of 5, no snapshot for 6h43m, newest recoverable dump 19h old. These
  // tests exist so that floor cannot be quietly removed again; the failure it
  // guards against is SILENT, which is exactly why it needs a test rather than a
  // comment.
  function seedDeadlineBase(dir: string, label: string, ageSec: number): string {
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, `${label}.deadline-base`);
    writeFileSync(path, `${Math.floor(Date.now() / 1000) - ageSec}\n`);
    return path;
  }

  it('seeds the staleness clock rather than admitting on the very first evaluation', () => {
    const { dir, env } = fixture(23.84);
    const marker = join(dir, 'must-not-run');
    const result = run(['--mode', 'scheduled', '--label', 'seed', '--', 'touch', marker], env);

    // Enabling the floor must not make every label on the host ignore pressure
    // at once on its first tick, so an unknown baseline still defers.
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('result=deferred reason=memory-pressure');
    expect(result.stdout).toContain('staleness_sec=unknown-seeded');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, 'state', 'seed.deadline-base'))).toBe(true);
  });

  it('admits a scheduled cycle once pressure has deferred it past the staleness deadline', () => {
    const { dir, env } = fixture(23.84);
    seedDeadlineBase(dir, 'stale', 25_200);
    const marker = join(dir, 'ran');
    const result = run(['--mode', 'scheduled', '--label', 'stale', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('result=admitted-despite-pressure reason=memory-pressure');
    expect(result.stdout).toContain('result=finished mode=scheduled rc=0');
    expect(existsSync(marker)).toBe(true);
  });

  it('escalates past unreadable pressure telemetry too, so a host that stops publishing PSI still backs up', () => {
    const { dir, env } = fixture();
    env.KOPIA_BACKUP_MEM_PSI_PATH = join(dir, 'missing-pressure-file');
    seedDeadlineBase(dir, 'nopsi', 25_200);
    const marker = join(dir, 'ran');
    const result = run(['--mode', 'scheduled', '--label', 'nopsi', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('result=admitted-despite-pressure reason=pressure-unavailable');
    expect(existsSync(marker)).toBe(true);
  });

  it('does not ignore pressure again on the very next tick after an escalation', () => {
    const { dir, env } = fixture(23.84);
    seedDeadlineBase(dir, 'retry', 25_200);
    expect(run(['--mode', 'scheduled', '--label', 'retry', '--', 'true'], env).stdout).toContain(
      'result=admitted-despite-pressure',
    );

    // A backup failing for a NON-pressure reason would otherwise override
    // pressure on every 5-minute tick forever, so re-staleness alone is not
    // enough to escalate twice in a row.
    seedDeadlineBase(dir, 'retry', 25_200);
    const marker = join(dir, 'must-not-run');
    const second = run(['--mode', 'scheduled', '--label', 'retry', '--', 'touch', marker], env);

    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('result=deferred reason=memory-pressure');
    expect(second.stdout).toMatch(/escalation_retry_in_sec=\d+/);
    expect(second.stdout).not.toContain('result=admitted-despite-pressure');
    expect(existsSync(marker)).toBe(false);
  });

  it('does not retire an escalated run on the same pressure that admitted it', () => {
    const { dir, env } = fixture(23.84);
    seedDeadlineBase(dir, 'armed', 25_200);
    const done = join(dir, 'done');
    // Leaving the runtime abort armed would kill this child within one monitor
    // interval on the very pressure admission just overrode, making the whole
    // floor inert: the log would say admitted, then deferred, and still produce
    // no snapshot. The unit's cgroup limits remain the brake for such a run.
    const result = run(
      ['--mode', 'scheduled', '--label', 'armed', '--', 'bash', '-c', `sleep 0.6; touch "${done}"`],
      env,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('deferred-during-run');
    expect(result.stdout).toContain('result=finished mode=scheduled rc=0');
    expect(existsSync(done)).toBe(true);
  });

  it('resets the staleness clock only for a run that actually completed', () => {
    const { dir, env } = fixture();
    const basePath = seedDeadlineBase(dir, 'failing', 25_200);
    const before = readFileSync(basePath, 'utf8');
    const result = run(['--mode', 'scheduled', '--label', 'failing', '--', 'false'], env);

    // A non-zero child must not look like coverage, or a permanently broken
    // backup would keep pushing its own deadline forward and never escalate —
    // the deadline would then measure "how recently we tried", which is exactly
    // the reassuring-but-empty signal this whole floor exists to replace.
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('result=finished mode=scheduled');
    expect(readFileSync(basePath, 'utf8')).toBe(before);
  });

  it('lets a stale cycle finish even when it passed admission and pressure rose mid-run', async () => {
    // THE DOMINANT REAL FAILURE, and the one an admission-only floor misses
    // entirely: 46 of 51 cycles in the 48h sample passed admission during a lull
    // and were then retired seconds in by a transient crossing. If the override
    // only covered admission, every one of those would still die and coverage
    // would still never complete.
    const { dir, env } = fixture();
    seedDeadlineBase(dir, 'midrun', 25_200);
    const ready = join(dir, 'ready');
    const finished = join(dir, 'finished');
    const child = spawn(
      'bash',
      [guard, '--mode', 'scheduled', '--label', 'midrun', '--', 'bash', '-c', `touch "$1"; sleep 1; touch "$2"`, '_', ready, finished],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });

    await waitForPath(ready);
    // Admission already passed under safe pressure; now cross both budgets hard.
    pressureFile(env.KOPIA_BACKUP_MEM_PSI_PATH as string, 23.84);
    pressureFile(env.KOPIA_BACKUP_IO_PSI_PATH as string, 40);
    const status: number = await new Promise((resolve) => child.on('close', (code) => resolve(code ?? -1)));

    expect(stdout).toContain('result=staleness-override-armed');
    expect(stdout).not.toContain('stopping-during-run');
    expect(stdout).not.toContain('deferred-during-run');
    expect(status).toBe(0);
    expect(existsSync(finished)).toBe(true);
  });

  it('still retires a mid-run pressure crossing when coverage is NOT stale', async () => {
    // The override must not become an always-on bypass: with a fresh baseline
    // the original protection has to behave exactly as before.
    const { dir, env } = fixture();
    seedDeadlineBase(dir, 'fresh', 0);
    const ready = join(dir, 'ready');
    const child = spawn(
      'bash',
      [guard, '--mode', 'scheduled', '--label', 'fresh', '--', 'bash', '-c', `touch "$1"; while :; do sleep 0.1; done`, '_', ready],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });

    await waitForPath(ready);
    pressureFile(env.KOPIA_BACKUP_MEM_PSI_PATH as string, 23.84);
    await new Promise((resolve) => child.on('close', resolve));

    expect(stdout).not.toContain('result=staleness-override-armed');
    expect(stdout).toContain('deferred-during-run reason=memory-pressure');
  });
});
