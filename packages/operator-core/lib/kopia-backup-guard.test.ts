/** Regression coverage for serialize-and-slow-kopia-backups-2026-08-20. */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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
      KOPIA_BACKUP_MEM_PSI_PATH: memoryPath,
      KOPIA_BACKUP_IO_PSI_PATH: ioPath,
      KOPIA_BACKUP_MEM_FULL_AVG10_MAX: '5',
      KOPIA_BACKUP_IO_FULL_AVG10_MAX: '10',
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
    expect(spawnSync('bash', ['-n', guard]).status).toBe(0);
    const { dir, env } = fixture();
    const marker = join(dir, 'ran');
    const result = run(['--mode', 'scheduled', '--label', 'test', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('');
    expect(result.stdout).toContain('result=started mode=scheduled');
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
    expect(spawnSync('test', ['-e', marker]).status).not.toBe(0);
  });

  it('fails safe when scheduled pressure telemetry is unavailable', () => {
    const { dir, env } = fixture();
    env.KOPIA_BACKUP_MEM_PSI_PATH = join(dir, 'missing-pressure-file');
    const marker = join(dir, 'must-not-run');
    const result = run(['--mode', 'scheduled', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('result=deferred reason=pressure-unavailable signal=memory');
    expect(spawnSync('test', ['-e', marker]).status).not.toBe(0);
  });

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
      ? spawnSync('sudo', ['-n', '-u', 'root', 'true'], { stdio: 'ignore' }).status === 0
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
    const killed = spawnSync('bash', [hotScriptPath, '--cleanup'], { encoding: 'utf8', env });
    expect(killed.status).toBe(0);
    expect(readFileSync(killLog, 'utf8')).toContain(`-KILL ${exactPid}`);
    expect(existsSync(pidFile)).toBe(false);

    writeFileSync(pidFile, `${reusedPid}\n`);
    const refused = spawnSync('bash', [hotScriptPath, '--cleanup'], { encoding: 'utf8', env });
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
});
