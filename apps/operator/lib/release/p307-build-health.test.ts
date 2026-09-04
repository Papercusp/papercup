/**
 * EI-22353142436290538 / P-307 — regression coverage for the rootful Podman
 * build-health detector and its bake-script integration.
 *
 * `kill -0` reports success for a zombie, and a process can also exit during
 * the detector's sampling sleep. Before the fix both cases were reported as
 * STALLED even though there was no live build left to diagnose. These tests
 * run the shipped shell, rather than a copied model of it, against real
 * exited, zombie, and live-idle processes.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const P307_SCRIPT = resolve(REPO_ROOT, 'infra/images/bootc/p307-build-health.sh');
const BAKE_SCRIPT = resolve(REPO_ROOT, 'infra/images/bootc/bake-cloud-images.sh');

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function shellHarness(source: string, root: string, timeout = 10_000) {
  return spawnSync('bash', ['-c', source], {
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      P307_SCRIPT,
      TMP: root,
    },
  });
}

function outputOf(result: ReturnType<typeof shellHarness>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function expectSuccessfulHarness(result: ReturnType<typeof shellHarness>): string {
  const output = outputOf(result);
  expect(result.status, output).toBe(0);
  return output;
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe('P-307 build-health process liveness', () => {
  it('does not report STALLED after the monitored process exits during sleep', () => {
    const root = tempRoot('p307-exited-');
    const result = shellHarness(
      String.raw`set -u
: >"$TMP/build.log"
(sleep 0.2) &
pid=$!
bash "$P307_SCRIPT" --pid "$pid" --log "$TMP/build.log" \
  --interval-sec 1 --stalled-after-sec 1 >"$TMP/monitor.out" 2>&1
rc=$?
wait "$pid" 2>/dev/null || true
test "$rc" -eq 0
! grep -q 'status=STALLED' "$TMP/monitor.out"
`,
      root,
    );

    expectSuccessfulHarness(result);
  });

  it('does not treat a live zombie root as a stalled build', () => {
    const root = tempRoot('p307-zombie-');
    const result = shellHarness(
      String.raw`set -u
: >"$TMP/build.log"
python3 - "$TMP/child.pid" <<'PY' &
import os
import pathlib
import sys
import time

child = os.fork()
if child == 0:
    time.sleep(0.2)
    os._exit(0)
pathlib.Path(sys.argv[1]).write_text(str(child))
time.sleep(5)
PY
parent=$!
for _ in $(seq 1 100); do
  [ -s "$TMP/child.pid" ] && break
  sleep 0.01
done
test -s "$TMP/child.pid"
pid=$(cat "$TMP/child.pid")
sleep 0.5
state=$(awk '{print $3}' "/proc/$pid/stat")
test "$state" = Z
bash "$P307_SCRIPT" --pid "$pid" --log "$TMP/build.log" \
  --interval-sec 1 --stalled-after-sec 1 >"$TMP/monitor.out" 2>&1
rc=$?
kill "$parent" 2>/dev/null || true
wait "$parent" 2>/dev/null || true
test "$rc" -eq 0
! grep -q 'status=STALLED' "$TMP/monitor.out"
`,
      root,
    );

    expectSuccessfulHarness(result);
  });

  it('still reports a live idle process after the configured quiet interval', () => {
    const root = tempRoot('p307-live-idle-');
    const result = shellHarness(
      String.raw`set -u
: >"$TMP/build.log"
(sleep 30) &
pid=$!
bash "$P307_SCRIPT" --pid "$pid" --log "$TMP/build.log" \
  --interval-sec 1 --stalled-after-sec 1 >"$TMP/monitor.out" 2>&1 &
monitor=$!
for _ in $(seq 1 80); do
  grep -q 'status=STALLED' "$TMP/monitor.out" && break
  sleep 0.05
done
grep -q 'status=STALLED' "$TMP/monitor.out"
kill "$monitor" 2>/dev/null || true
wait "$monitor" 2>/dev/null || true
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
`,
      root,
    );

    expectSuccessfulHarness(result);
  });
});

describe('P-307 bake integration', () => {
  it('routes monitored command completion through the shipped detector without masking its exit code', () => {
    const source = readFileSync(BAKE_SCRIPT, 'utf8');
    const start = source.indexOf('run_monitored() {');
    const end = source.indexOf('\n\n# Requested clouds', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const root = tempRoot('p307-bake-integration-');
    const result = shellHarness(
      [
        'set -uo pipefail',
        `BUILD_HEALTH=${JSON.stringify(P307_SCRIPT)}`,
        source.slice(start, end),
        String.raw`run_monitored "$TMP/integration.log" bash -c 'sleep 0.2'`,
        'rc=$?',
        'printf "RUN_MONITORED_RC=%s\\n" "$rc"',
        'exit "$rc"',
      ].join('\n'),
      root,
    );

    const output = expectSuccessfulHarness(result);
    expect(output).toContain('RUN_MONITORED_RC=0');
    expect(output).not.toContain('status=STALLED');
  });
});
