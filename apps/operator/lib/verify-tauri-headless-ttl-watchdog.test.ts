/**
 * EI-18805100008031244 — a `--boot-only` verify-tauri-headless instance that
 * nobody tears down used to run forever: an 8-day-old orphan holding a
 * display, a webview and an operator sidecar was found live on the dev box,
 * with 125 accumulated `/tmp/verify-tauri-headless.*` work dirs. The script's
 * own header already warned "NEVER leave it running unattended" — nothing
 * enforced it.
 *
 * The external sweep (`gc-verify-instances`, WI-6684, hourly, 6h TTL) already
 * reaps the accumulated backlog from OUTSIDE the instance. This fix adds the
 * two remaining "correct state" asks from the bug report, both handled INSIDE
 * the script itself:
 *
 *   1. a TTL self-watchdog: `--boot-only` self-terminates after
 *      `VERIFY_TAURI_BOOT_ONLY_TTL_MIN` minutes (default 240) unless a caller
 *      refreshes a heartbeat file — no dependency on any external sweep ever
 *      running at all;
 *   2. honest contention reporting at boot: every boot, and every port-bind
 *      retry/failure, reports how many live verifier instances and
 *      accumulated work dirs the box is carrying, instead of leaving a
 *      collision to read as an opaque EADDRINUSE.
 *
 * Same rationale as every sibling verify-tauri-headless-*.test.ts: the script
 * boots a real Xvfb/Tauri stack, so a `readFileSync` text guard is the right
 * shape for CI (the actual watchdog fire + contention_summary output were
 * functionally verified live against a real throwaway Xvfb instance — see the
 * work-item's completion evidence — which this static guard complements
 * rather than duplicates).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-18805100008031244 — verify-tauri-headless contention_summary', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
    expect(src).toContain('contention_summary');
  });

  it('counts live verifier Xvfb instances while excluding the protected :0/:1/:2 displays', () => {
    const fn = src.match(/contention_summary\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/pgrep -a -f 'Xvfb :'/);
    expect(fn).toMatch(/grep -Ecv 'Xvfb :\[0-2\] '/);
  });

  it('counts accumulated work dirs under $TMPDIR', () => {
    const fn = src.match(/contention_summary\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/find "\$\{TMPDIR:-\/tmp\}" -maxdepth 1 -type d -name 'verify-tauri-headless\.\*'/);
  });

  it('is reported at the initial boot log line', () => {
    expect(src).toMatch(/log "display=:\$DISPLAY_NUM devPort=\$DEV_PORT ptyPort=\$PTY_PORT work=\$WORK"\nlog "contention: \$\(contention_summary\)"/);
  });

  it('is reported on the EADDRINUSE bind-time retry', () => {
    const retryLine = src.match(/log "EADDRINUSE racing[^\n]*"/)?.[0];
    expect(retryLine).toBeTruthy();
    expect(retryLine).toContain('$(contention_summary)');
  });

  it('is reported on the final EADDRINUSE FATAL', () => {
    const fatalBlock = src.match(
      /echo "FATAL: our operator sidecar could not bind[\s\S]*?exit 1/,
    )?.[0];
    expect(fatalBlock).toBeTruthy();
    expect(fatalBlock).toContain('$(contention_summary)');
  });
});

describe('EI-18805100008031244 — verify-tauri-headless --boot-only TTL self-watchdog', () => {
  it('defaults BOOT_ONLY_TTL_MIN from VERIFY_TAURI_BOOT_ONLY_TTL_MIN, and 0 disables it', () => {
    expect(src).toMatch(/BOOT_ONLY_TTL_MIN="\$\{VERIFY_TAURI_BOOT_ONLY_TTL_MIN:-240\}"/);
    expect(src).toMatch(/if \[ "\$BOOT_ONLY_TTL_MIN" -gt 0 \] 2>\/dev\/null; then/);
  });

  it('the watchdog subshell lives inside the --boot-only branch, after write_stop_script and the trap clear', () => {
    const branch = src.match(/if \[ "\$\{1:-\}" = "--boot-only" \]; then([\s\S]*?)\nfi/)?.[1];
    expect(branch).toBeTruthy();
    // write_stop_script must run before the watchdog can rely on $WORK/stop.sh existing.
    const writeIdx = branch!.indexOf('write_stop_script');
    const heartbeatIdx = branch!.indexOf('HEARTBEAT_FILE=');
    const watchdogIdx = branch!.indexOf('WATCHDOG_PID=');
    expect(writeIdx).toBeGreaterThan(-1);
    expect(heartbeatIdx).toBeGreaterThan(writeIdx);
    expect(watchdogIdx).toBeGreaterThan(heartbeatIdx);
  });

  it('the watchdog subshell clears inherited EXIT/INT/TERM traps before it loops (WI-4975 property)', () => {
    const watchdog = src.match(/\( trap - EXIT INT TERM\s*\n\s*while kill -0 "\$XVFB_PID" 2>\/dev\/null; do\s*\n\s*sleep 60[\s\S]*?\) &\s*\n\s*WATCHDOG_PID=\$!/)?.[0];
    expect(watchdog).toBeTruthy();
  });

  it('the watchdog reads the heartbeat file mtime and self-terminates via the SAME stop.sh teardown, never a hand-rolled kill', () => {
    const watchdog = src.match(/\( trap - EXIT INT TERM\s*\n\s*while kill -0 "\$XVFB_PID"[\s\S]*?\) &\s*\n\s*WATCHDOG_PID=\$!/)?.[0];
    expect(watchdog).toBeTruthy();
    expect(watchdog).toMatch(/stat -c %Y "\$HEARTBEAT_FILE"/);
    expect(watchdog).toMatch(/hb_age_min=\$\(\( \( \$\(date \+%s\) - hb_epoch \) \/ 60 \)\)/);
    expect(watchdog).toMatch(/\[ "\$hb_age_min" -ge "\$BOOT_ONLY_TTL_MIN" \]/);
    expect(watchdog).toContain('"$WORK/stop.sh"');
    // Must never issue its own kill/pkill — teardown is stop.sh's job alone
    // (mirrors gc-verify-instances.ts's own "never reimplement it" design note).
    expect(watchdog).not.toMatch(/\bkill -9\b|\bpkill\b/);
  });

  it('exports VERIFY_TAURI_HEARTBEAT and documents the refresh + disable knobs to the caller', () => {
    const envWriter = src.match(
      /write_boot_only_env_script\(\) \{[\s\S]*?BOOT_ONLY_ENV_SCRIPT/,
    )?.[0];
    expect(envWriter).toBeTruthy();
    expect(envWriter).toContain("printf 'VERIFY_TAURI_HEARTBEAT=%q\\n' \"$HEARTBEAT_FILE\"");
    expect(envWriter).toContain(
      'export VERIFY_TAURI_SCOPE_ENABLED VERIFY_TAURI_SCOPE_UNIT VERIFY_TAURI_HEARTBEAT',
    );
    expect(envWriter).toContain('verify_tauri_assert_owned');

    // --boot-only exposes only a source command for the private env file; the
    // heartbeat refresh and TTL-disable knobs remain documented alongside it.
    expect(src).toContain("printf 'source %q\\n' \"$BOOT_ONLY_ENV\"");
    expect(src).toContain('chmod 600 "$BOOT_ONLY_ENV"');
    expect(src).toContain('touch "$WORK/.heartbeat"');
    expect(src).toContain('VERIFY_TAURI_BOOT_ONLY_TTL_MIN');
    expect(src).not.toMatch(/cat <<EOF\nexport VERIFY_TAURI_PID/);
  });
});
