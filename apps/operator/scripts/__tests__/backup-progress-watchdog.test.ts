import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');
const source = readFileSync(SCRIPT, 'utf8');

function watchdogSource(): string {
  const match = source.match(/run_bounded_watched\(\) \{[\s\S]*?\n\}/);
  expect(match, 'run_bounded_watched must be extractable').toBeTruthy();
  // Server-priority policy has its own focused tests. Watchdog fixtures must
  // neither query the workstation's database nor depend on an absent helper.
  return 'prioritize_backup_backends() { :; }\nlog_backup_diagnostics() { :; }\n' + (match?.[0] ?? '');
}

function functionBody(name: string): string {
  // Anchor the declaration so dump_one cannot match guarded_dump_one.
  const start = source.indexOf(`\n${name}() {\n`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
  return source.slice(start + 1, end + 3);
}

describe('papercusp database-backup progress watchdog', () => {
  it('publishes a PID-bound host writer marker and removes it on EXIT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-host-progress-marker-'));
    try {
      const dump = join(root, 'dump');
      const ready = join(root, 'ready');
      const release = join(root, 'release');
      const harness = join(root, 'marker-harness.sh');
      const markerWriter = functionBody('write_host_backup_progress_marker');
      const markerCleanup = functionBody('cleanup_host_backup_progress_marker');
      writeFileSync(harness, [
        '#!/usr/bin/env bash',
        'set -uo pipefail',
        'DUMP="$TEST_DUMP"',
        'mkdir -p "$DUMP"',
        'HOST_BACKUP_PROGRESS_PATH="$DUMP/IN_PROGRESS.$$.json"',
        markerWriter,
        markerCleanup,
        'trap cleanup_host_backup_progress_marker EXIT',
        'write_host_backup_progress_marker',
        'touch "$READY_PATH"',
        'while [ ! -e "$RELEASE_PATH" ]; do sleep 0.01; done',
        '',
      ].join('\n'));
      chmodSync(harness, 0o755);

      const child = spawn('bash', [harness], {
        env: { ...process.env, TEST_DUMP: dump, READY_PATH: ready, RELEASE_PATH: release },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
      try {
        const deadline = Date.now() + 5_000;
        while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(ready), `marker child exit=${child.exitCode}; stderr=${stderr}`).toBe(true);

        const markerPath = join(dump, `IN_PROGRESS.${child.pid}.json`);
        const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
        expect(marker).toMatchObject({ pid: child.pid, phase: 'host-backup' });
        expect(marker.processStartTicks).toMatch(/^\d+$/);
        expect(marker.startedAtEpoch).toBeTypeOf('number');

        writeFileSync(release, 'finish');
        expect(await closed, stderr).toBe(0);
        expect(existsSync(markerPath)).toBe(false);
      } finally {
        // Failed readiness/assertions must not strand the fixture's live shell.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await closed;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a finite stall floor and a 150-minute absolute ceiling', () => {
    expect(source).toContain('TIMEOUT_SEC="${PC_BACKUP_TIMEOUT_SEC:-2700}"');
    expect(source).toContain('TIMEOUT_MAX_SEC="${PC_BACKUP_TIMEOUT_MAX_SEC:-9000}"');
    expect(source).toContain('PROGRESS_STALE_SEC="${PC_BACKUP_PROGRESS_STALE_SEC:-300}"');
    expect(source).toContain('KILL_GRACE_SEC="${PC_BACKUP_KILL_GRACE_SEC:-5}"');
    expect(source).toContain('[ "$TIMEOUT_MAX_SEC" -lt "$TIMEOUT_SEC" ]');
  });

  it('lets archive growth extend the floor but never the absolute ceiling', () => {
    const body = functionBody('run_bounded_watched');
    expect(body).toContain('measurement_output=$(timeout --kill-after=1s 4s sudo -n -u postgres du -sb "$progress_path" 2>&1)');
    expect(body).not.toContain('current_bytes=$(du -sb "$progress_path"');
    expect(body).not.toContain('current_bytes=${current_bytes:-0}');
    expect(body).toContain('[ "$current_bytes" -gt "$last_bytes" ]');
    expect(body).toContain('last_progress_epoch="$now_epoch"');
    expect(body).toContain('[ "$elapsed" -ge "$max_secs" ]');
    expect(body).toContain('[ "$elapsed" -ge "$floor_secs" ]');
    expect(body).toContain('[ $(( now_epoch - last_progress_epoch )) -ge "$PROGRESS_STALE_SEC" ]');
  });

  it('wires the live temporary directory into the watchdog and removes the blind timeout wrapper', () => {
    expect(source).toContain(
      'run_bounded_watched "$TIMEOUT_SEC" "$TIMEOUT_MAX_SEC" "$out.tmp"',
    );
    expect(source).not.toContain(
      'run_bounded_watched "$TIMEOUT_SEC" timeout --kill-after=20s "$TIMEOUT_SEC"',
    );
  });

  it.each([
    ['growing', 9, 'absolute watchdog ceiling', 1],
    ['stalled-after-floor', 6, 'killing stalled producer', 1],
    ['stalled-from-start', 4, 'killing stalled producer', 1],
    ['growing-sparse', 9, 'absolute watchdog ceiling', 100],
  ] as const)('observes liveness before and termination at the %s boundary', (mode, due, reason, step) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-watchdog-boundary-'));
    try {
      const clock = join(root, 'clock');
      const observations = join(root, 'observations');
      const progress = join(root, 'archive.tmp');
      const harness = join(root, 'boundary.sh');
      writeFileSync(clock, '0');
      // The injected clock and growth schedule drive the real watchdog. Its
      // privileged du still measures an actual directory and compressed-named
      // member. Only the fixture's wait/clock are synthetic (D-005).
      writeFileSync(harness, `#!/usr/bin/env bash
set -uo pipefail
PC_BACKUP_WATCH_SEC=1
PC_BACKUP_MIN_FREE_GB=0
PROGRESS_STALE_SEC=$(( 2 * TICK_STEP ))
KILL_GRACE_SEC=0
mkdir -p "$PROGRESS_PATH"
: > "$PROGRESS_PATH/1.dat.zst"
fs_avail_gb() { echo 999999; }
log() { printf '%s\\n' "$*" >&2; }
reap_own_stragglers() { :; }
sudo() { shift 3; command "$@"; }
timeout() { shift 2; "$@"; }
date() {
  local now
  now=$(cat "$CLOCK")
  if [[ -v dump_pid ]] && builtin kill -0 "$dump_pid" 2>/dev/null; then
    printf 'alive %s\\n' "$now" >> "$OBSERVATIONS"
  fi
  printf '%s\\n' "$now"
}
sleep() {
  [ "$1" != 0 ] || return 0
  local tick
  tick=$(( $(cat "$CLOCK") + TICK_STEP ))
  printf '%s\\n' "$tick" > "$CLOCK"
  if [[ "$MODE" = growing* ]] || { [ "$MODE" = stalled-after-floor ] && [ "$tick" -le 4 ]; }; then
    printf x >> "$PROGRESS_PATH/1.dat.zst"
  fi
}
kill() {
  if [ "$1" = -TERM ]; then
    printf 'terminate %s\\n' "$(cat "$CLOCK")" >> "$OBSERVATIONS"
  fi
  builtin kill "$@"
}
${watchdogSource()}
log_backup_diagnostics() {
  printf 'diagnose %s\\n' "$(cat "$CLOCK")" >> "$OBSERVATIONS"
}
run_bounded_watched "$(( 4 * TICK_STEP ))" "$(( 9 * TICK_STEP ))" "$PROGRESS_PATH" /bin/sleep 30
`);
      const run = spawnSync('bash', [harness], {
        encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, MODE: mode, CLOCK: clock, OBSERVATIONS: observations, PROGRESS_PATH: progress, TICK_STEP: String(step) },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect([137, 143], run.stderr).toContain(run.status);
      expect(run.stderr).toContain(reason);
      const observed = readFileSync(observations, 'utf8').trim().split('\n');
      expect(observed).toEqual([
        ...Array.from({ length: due }, (_, i) => (i + 1) * step).flatMap((time) =>
          time === 300 || time === 600 ? [`alive ${time}`, `diagnose ${time}`] : [`alive ${time}`]),
        `diagnose ${due * step}`,
        `terminate ${due * step}`,
      ]);
      // The complete ordered trace falsifies an early kill even when a later
      // "dead by ceiling" assertion would pass. Production defaults are pinned
      // separately above; this fixture preserves the same predicate ordering.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['success', 'failure', 'timeout', 'killed-timeout', 'signal-kill'])('retains bounded COPY diagnostics through probe %s', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-copy-diagnostics-'));
    try {
      const sudo = join(root, 'sudo');
      const args = join(root, 'args');
      writeFileSync(sudo, `#!/bin/bash
printf '%s\\n' "$@" > "$PROBE_ARGS"
[ "$PROBE_MODE" != timeout ] || exec /bin/sleep 30
[ "$PROBE_MODE" != killed-timeout ] || { trap '' TERM; exec /bin/sleep 30; }
[ "$PROBE_MODE" != signal-kill ] || kill -KILL $$
[ "$PROBE_MODE" != failure ] || { echo 'database unavailable' >&2; exit 13; }
printf '%s\\n' '[{"pid":42,"wait":"DataFileRead","copyBytes":8192}]'
`);
      chmodSync(sudo, 0o755);
      const run = spawnSync('bash', ['-c', [
        'set -uo pipefail',
        'HOST_BACKUP_APPLICATION_NAME=pcbackup',
        'log() { printf "%s\\n" "$*"; }',
        functionBody('log_backup_diagnostics'),
        'log_backup_diagnostics /archive/state.tmp 9000 43862092935 ceiling',
        'printf "producer continues\\n"',
      ].join('\n')], {
        encoding: 'utf8', timeout: 7_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PROBE_ARGS: args, PROBE_MODE: mode },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('elapsed=9000 archive_bytes=43862092935 reason=ceiling');
      const outcomes = {
        success: [0, 'ok'],
        failure: [13, 'failed'],
        timeout: [124, 'wall-timeout'],
        'killed-timeout': [137, 'wall-timeout-kill'],
        'signal-kill': [137, 'signal-kill'],
      } as const;
      const [status, outcome] = outcomes[mode as keyof typeof outcomes];
      expect(run.stdout).toContain(`probe_status=${status} probe_outcome=${outcome}`);
      expect(run.stdout).toContain(mode === 'success'
        ? 'snapshot_source=current snapshot_elapsed=9000 snapshot=[{"pid":42'
        : 'snapshot_source=unavailable snapshot_elapsed=unknown snapshot=[]');
      if (mode === 'failure') expect(run.stdout).toContain('probe_detail=database unavailable');
      if (mode === 'killed-timeout') expect(run.stdout).toContain('sending signal KILL');
      expect(run.stdout).toContain('producer continues');
      const probe = readFileSync(args, 'utf8');
      expect(probe).toContain('PGOPTIONS=-c statement_timeout=2000 -c lock_timeout=1000');
      expect(probe).toContain("application_name = 'pcbackup'");
      expect(probe).toContain('pg_stat_progress_copy');
      // Non-COPY SQL may include application data and must never enter logs.
      expect(probe).toContain("CASE WHEN a.query LIKE 'COPY %'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 8_000);

  it('retains the last successful COPY sample on failure without attributing it to another artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-copy-diagnostics-history-'));
    try {
      const sudo = join(root, 'sudo');
      writeFileSync(sudo, `#!/bin/bash
[ "$PROBE_MODE" != failure ] || { echo 'database unavailable' >&2; exit 13; }
printf '%s\\n' '[{"pid":42,"copy_bytes":8192}]'
`);
      chmodSync(sudo, 0o755);
      const run = spawnSync('bash', ['-c', [
        'set -uo pipefail',
        'HOST_BACKUP_APPLICATION_NAME=pcbackup',
        'log() { printf "%s\\n" "$*"; }',
        functionBody('log_backup_diagnostics'),
        'export PROBE_MODE=success',
        'log_backup_diagnostics /archive/state.tmp 300 1024 progress',
        'export PROBE_MODE=failure',
        'log_backup_diagnostics /archive/state.tmp 9000 2048 abort',
        'log_backup_diagnostics /archive/transcript.tmp 300 4096 progress',
      ].join('\n')], {
        encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      const lines = run.stdout.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('snapshot_source=current snapshot_elapsed=300 snapshot=[{"pid":42');
      expect(lines[1]).toContain('probe_status=13 probe_outcome=failed');
      expect(lines[1]).toContain('snapshot_source=previous snapshot_elapsed=300 snapshot=[{"pid":42');
      expect(lines[1]).toContain('elapsed=9000 archive_bytes=2048 reason=abort');
      expect(lines[1]).toContain('probe_detail=database unavailable');
      expect(lines[2]).toContain('snapshot_source=unavailable snapshot_elapsed=unknown snapshot=[]');
      expect(lines[2]).not.toContain('"pid":42');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['success', 'zero', 'failure-with-output', 'malformed', 'hang', 'hang-ignore-term'])('distinguishes valid zero from an unavailable space measurement: %s', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-space-deadline-'));
    try {
      const df = join(root, 'df');
      writeFileSync(df, [
        '#!/bin/bash',
        'printf "Avail\\n"',
        '[ "$MEASURE_MODE" != zero ] || { printf "0\\n"; exit 0; }',
        '[ "$MEASURE_MODE" != malformed ] || { printf "not-a-number\\n"; exit 0; }',
        'printf "2097152\\n"',
        '[ "$MEASURE_MODE" != failure-with-output ] || exit 1',
        '[ "$MEASURE_MODE" != hang-ignore-term ] || trap "" TERM',
        '[[ "$MEASURE_MODE" != hang* ]] || exec /bin/sleep 30',
      ].join('\n'));
      chmodSync(df, 0o755);
      const run = spawnSync('timeout', ['--kill-after=1s', '2s', 'bash', '-c', [
        'set -uo pipefail',
        'PGOUT=/fixture/backup-volume',
        'log() { printf "%s\\n" "$*" >&2; }',
        'timeout() {',
        '  [ "$1" = --kill-after=1s ] && [ "$2" = 4s ] || return 98',
        '  shift 2',
        '  command timeout --kill-after=0.1s 0.1s "$@"',
        '}',
        functionBody('fs_avail_gb'),
        'fs_avail_gb',
      ].join('\n')], {
        encoding: 'utf8', timeout: 4_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, MEASURE_MODE: mode },
      });
      expect(run.error, run.stderr).toBeUndefined();
      const valid = mode === 'success' || mode === 'zero';
      expect(run.status, run.stderr).toBe(valid ? 0 : 1);
      expect(run.stdout.trim()).toBe(valid ? (mode === 'success' ? '2' : '0') : '');
      if (valid) {
        expect(run.stderr).toBe('');
      } else {
        expect(run.stderr).toContain('SPACE MEASUREMENT FAILED:');
        expect(run.stderr).toContain(`df_status=${mode === 'malformed' ? 0 : mode === 'hang' ? 124 : mode === 'hang-ignore-term' ? 137 : 1}`);
        expect(run.stderr).toContain(`probe_outcome=${mode === 'malformed' ? 'invalid-output' : mode === 'hang' ? 'wall-timeout' : mode === 'hang-ignore-term' ? 'wall-timeout-kill' : 'failed'}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['unavailable', 'zero', 'low'])('aborts safely with the correct space diagnosis: %s', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-space-diagnosis-'));
    try {
      const df = join(root, 'df');
      writeFileSync(df, [
        '#!/bin/bash',
        '[ "$MEASURE_MODE" != unavailable ] || { printf "fixture df unavailable\\n" >&2; exit 1; }',
        'printf "Avail\\n"',
        'if [ "$MEASURE_MODE" = zero ]; then printf "0\\n"; else printf "1048576\\n"; fi',
      ].join('\n'));
      chmodSync(df, 0o755);
      const run = spawnSync('timeout', ['--kill-after=1s', '2s', 'bash', '-c', [
        'set -uo pipefail',
        'PGOUT=/fixture/backup-volume',
        'PC_BACKUP_WATCH_SEC=0.01',
        'PC_BACKUP_MIN_FREE_GB=120',
        'PROGRESS_STALE_SEC=1',
        'KILL_GRACE_SEC=0',
        'log() { printf "%s\\n" "$*" >&2; }',
        'reap_own_stragglers() { :; }',
        'sleep() { [ "$1" != 5 ] || return 0; command sleep "$@"; }',
        functionBody('fs_avail_gb'),
        watchdogSource(),
        'log_backup_diagnostics() { printf "diagnostic reason=%s\\n" "$4" >&2; }',
        'run_bounded_watched 1 8 /fixture/archive.tmp /bin/sleep 30',
        'rc=$?',
        'printf "watchdog returned:%s\\n" "$rc"',
        'test "$rc" -ne 0',
      ].join('\n')], {
        encoding: 'utf8', timeout: 4_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, MEASURE_MODE: mode },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('watchdog returned:');
      if (mode === 'unavailable') {
        expect(run.stderr).toContain('df_status=1 probe_outcome=failed');
        expect(run.stderr).toContain('unable to measure free space');
        expect(run.stderr).toContain('diagnostic reason=space-unreadable');
        expect(run.stderr).not.toContain('free space fell to');
      } else {
        expect(run.stderr).toContain(`free space fell to ${mode === 'zero' ? 0 : 1} GiB`);
        expect(run.stderr).toContain('diagnostic reason=space-floor');
        expect(run.stderr).not.toContain('unable to measure free space');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['preflight', 'per-artifact'])('refuses %s admission when free space cannot be measured', (boundary) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-space-admission-'));
    try {
      const df = join(root, 'df');
      writeFileSync(df, '#!/bin/bash\nprintf "fixture df unavailable\\n" >&2\nexit 1\n');
      chmodSync(df, 0o755);
      const preflight = source.match(/^(?:if ! )?PC_FREE_GB=\$\(fs_avail_gb\)[\s\S]*?^log "headroom ok:.*$/m)?.[0];
      expect(preflight).toBeTruthy();
      const run = spawnSync('bash', ['-c', [
        'set -uo pipefail',
        'PGOUT=/fixture/backup-volume',
        'PC_BACKUP_MIN_FREE_GB=120',
        'PC_BACKUP_SPACE_SAFETY=140',
        'log() { printf "%s\\n" "$*" >&2; }',
        'rm_tmp() { :; }',
        'unexpected_producer() { printf "UNEXPECTED DATABASE ACCESS\\n" >&2; return 99; }',
        'PSQL=unexpected_producer',
        'run_bounded_watched() { unexpected_producer; }',
        functionBody('fs_avail_gb'),
        boundary === 'preflight' ? preflight! : functionBody('dump_one'),
        boundary === 'per-artifact' ? 'dump_one fixture fixture' : '',
      ].join('\n')], {
        encoding: 'utf8', timeout: 4_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(1);
      expect(run.stderr).toContain('df_status=1 probe_outcome=failed');
      expect(run.stderr).toContain('unable to measure free space');
      expect(run.stderr).not.toContain('UNEXPECTED DATABASE ACCESS');
      expect(run.stderr).not.toContain('only 0 GiB free');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['hang', 'hang-ignore-term'])('terminates its producer when the archive-size observer %s', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-size-deadline-'));
    try {
      const sudo = join(root, 'sudo');
      const progress = join(root, 'archive.tmp');
      writeFileSync(progress, 'x');
      writeFileSync(sudo, [
        '#!/bin/bash',
        '[ "$*" = "-n -u postgres du -sb $PROGRESS_PATH" ] || exit 97',
        '[ "$MEASURE_MODE" != hang-ignore-term ] || trap "" TERM',
        'exec /bin/sleep 30',
      ].join('\n'));
      chmodSync(sudo, 0o755);
      const run = spawnSync('timeout', ['--kill-after=1s', '2s', 'bash', '-c', [
        'set -uo pipefail',
        'PC_BACKUP_WATCH_SEC=0.01',
        'PC_BACKUP_MIN_FREE_GB=1',
        'PROGRESS_STALE_SEC=1',
        'KILL_GRACE_SEC=0',
        'fs_avail_gb() { echo 999; }',
        'log() { printf "%s\\n" "$*" >&2; }',
        'reap_own_stragglers() { :; }',
        'timeout() {',
        '  [ "$1" = --kill-after=1s ] && [ "$2" = 4s ] || return 98',
        '  shift 2',
        '  command timeout --kill-after=0.1s 0.1s "$@"',
        '}',
        watchdogSource(),
        'run_bounded_watched 1 8 "$PROGRESS_PATH" /bin/sleep 30',
        'rc=$?',
        'printf "watchdog returned:%s\\n" "$rc"',
        'test "$rc" -ne 0',
      ].join('\n')], {
        encoding: 'utf8', timeout: 4_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PROGRESS_PATH: progress, MEASURE_MODE: mode },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('watchdog returned:');
      expect(run.stderr).toContain('unable to measure archive progress');
      expect(run.stderr).toContain(mode === 'hang' ? 'du_status=124' : 'du_status=137');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('extends a growing archive past the floor but stops a stalled producer and a forever-growing one', () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-progress-watchdog-'));
    try {
      const harness = join(root, 'watchdog.sh');
      const progress = join(root, 'archive.tmp');
      writeFileSync(
        harness,
        `#!/usr/bin/env bash
set -uo pipefail
PC_BACKUP_WATCH_SEC=0.25
PC_BACKUP_MIN_FREE_GB=0
PROGRESS_STALE_SEC=2
KILL_GRACE_SEC=0
fs_avail_gb() { echo 999999; }
log() { printf '%s\\n' "$*" >&2; }
reap_own_stragglers() { :; }
sudo() {
  printf '%s\\n' "$*" >>"$SUDO_LOG"
  [ "$1" = "-n" ] && [ "$2" = "-u" ] && [ "$3" = "postgres" ] || return 125
  shift 3
  if [ "\${FAIL_PROGRESS_MEASURE:-0}" = "1" ]; then
    printf '%s\\n' 'du: Permission denied' >&2
    return 1
  fi
  command "$@"
}
timeout() { shift 2; "$@"; }
${watchdogSource()}
case "$1" in
  growing)
    run_bounded_watched 2 12 "$PROGRESS_PATH" bash -c 'for i in 1 2 3 4 5 6 7 8; do printf x >> "$PROGRESS_PATH"; sleep 0.5; done'
    ;;
  startup)
    run_bounded_watched 2 12 "$PROGRESS_PATH" bash -c 'sleep 1; for i in 1 2 3 4; do printf x >> "$PROGRESS_PATH"; sleep 0.25; done'
    ;;
  stalled)
    : > "$PROGRESS_PATH"
    run_bounded_watched 2 8 "$PROGRESS_PATH" bash -c 'sleep 20'
    ;;
  ceiling)
    : > "$PROGRESS_PATH"
    run_bounded_watched 2 4 "$PROGRESS_PATH" bash -c 'for i in $(seq 1 20); do printf x >> "$PROGRESS_PATH"; sleep 1; done'
    ;;
  unmeasurable)
    : > "$PROGRESS_PATH"
    run_bounded_watched 2 8 "$PROGRESS_PATH" bash -c 'sleep 20'
    ;;
esac
`,
      );
      chmodSync(harness, 0o755);
      const sudoLog = join(root, 'sudo.log');
      const run = (mode: string, failMeasurement = false) => spawnSync('bash', [harness, mode], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PROGRESS_PATH: progress,
          SUDO_LOG: sudoLog,
          FAIL_PROGRESS_MEASURE: failMeasurement ? '1' : '0',
        },
        timeout: 15_000,
      });

      const growing = run('growing');
      expect(growing.status, growing.stderr).toBe(0);
      expect(readFileSync(progress, 'utf8')).toHaveLength(8);
      expect(readFileSync(sudoLog, 'utf8')).toContain('-n -u postgres du -sb');

      rmSync(progress, { force: true });
      const startup = run('startup');
      expect(startup.status, startup.stderr).toBe(0);
      expect(readFileSync(progress, 'utf8')).toHaveLength(4);

      rmSync(progress, { force: true });
      const stalled = run('stalled');
      expect(stalled.status, stalled.stderr).not.toBe(0);
      expect(stalled.stderr).toContain('killing stalled producer');

      rmSync(progress, { force: true });
      const ceiling = run('ceiling');
      expect(ceiling.status, ceiling.stderr).not.toBe(0);
      expect(ceiling.stderr).toContain('absolute watchdog ceiling 4s reached');

      rmSync(progress, { force: true });
      rmSync(sudoLog, { force: true });
      const unmeasurable = run('unmeasurable', true);
      expect(unmeasurable.status, unmeasurable.stderr).not.toBe(0);
      expect(unmeasurable.stderr).toContain('unable to measure archive progress');
      expect(unmeasurable.stderr).toContain('du_status=1 output=du: Permission denied');
      expect(unmeasurable.stderr).not.toContain('killing stalled producer');
      expect(readFileSync(sudoLog, 'utf8')).toContain('-n -u postgres du -sb');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
