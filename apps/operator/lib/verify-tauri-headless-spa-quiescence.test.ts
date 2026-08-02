/**
 * verify-tauri-headless-spa-quiescence.test.ts — the RECURRENCE GUARD for
 * EI-19382195051346372.
 *
 * The bug: scripts/verify-tauri-headless.sh freezes its per-run SPA snapshot
 * (EI-10364) by `cp -a`-ing the shared apps/operator-vite/dist the moment it's
 * reached — with no check that the shared `vite build --watch` (which rewrites
 * dist/assets every ~3min and RETAINS old hashed chunks, emptyOutDir:false)
 * isn't mid-rewrite right then. A freeze racing a rebuild can copy a MIX of
 * old+new chunks with no single consistent build behind it. From inside the
 * webview that is indistinguishable from a live regression — a fatal error
 * card naming an identifier that exists nowhere in current source — and it
 * cost ~25min of bundle archaeology once before the snapshot was even
 * suspected (measured 2026-08-02: two consecutive instances reproduced an
 * already-fixed `Can't find variable: opts` bug this way).
 *
 * The fix: before the freeze copy, poll the newest mtime under
 * $SHARED_SPA_DIST/assets and require it to be unchanged for a stability
 * window (bounded by a max wait, so a wedged watcher — EI-5202 — can never
 * hang the boot; it warns and freezes anyway on timeout). The frozen snapshot
 * also carries the vite-watch heartbeat's builtAtMs, so check-freshness.sh can
 * report "the shared watcher has rebuilt at least once since your freeze" —
 * the sentence the original filing said would have saved the 25 minutes.
 *
 * Static text-guard test (same rationale as verify-tauri-headless-spa-
 * isolation.test.ts / tty-title-target.test.ts): the script boots a real
 * Xvfb/Tauri stack, so its freeze-point wiring can only be asserted at the
 * wiring site, not by actually running it end-to-end in a unit test.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-19382195051346372 — verify-tauri-headless waits for SPA dist quiescence before freezing', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
    expect(src).toContain('EI-19382195051346372');
  });

  it('polls the shared assets dir for mtime stability BEFORE the freeze copy', () => {
    // The quiescence wait must run before `cp -a "$SHARED_SPA_DIST/."`, not after —
    // waiting after the copy has already happened protects nothing.
    const quiesceIdx = src.indexOf('QUIESCE_STABLE_SEC');
    const copyIdx = src.indexOf('cp -a "$SHARED_SPA_DIST/."');
    expect(quiesceIdx).toBeGreaterThan(-1);
    expect(copyIdx).toBeGreaterThan(-1);
    expect(quiesceIdx).toBeLessThan(copyIdx);
  });

  it('is bounded — a wedged/rebuild-storming watcher can never hang the boot', () => {
    // Both the stability window and the outright max-wait ceiling must exist,
    // and the max-wait path must fall through to freezing anyway (never blocks
    // indefinitely, per the "warn and proceed on timeout" requirement).
    expect(src).toMatch(/QUIESCE_STABLE_SEC="\$\{PAPERCUSP_SPA_QUIESCE_STABLE_SEC:-\d+\}"/);
    expect(src).toMatch(/QUIESCE_MAX_WAIT_SEC="\$\{PAPERCUSP_SPA_QUIESCE_MAX_WAIT_SEC:-\d+\}"/);
    expect(src).toMatch(/did NOT quiesce within.*freezing anyway/);
  });

  it('env overrides are honored (PAPERCUSP_SPA_QUIESCE_STABLE_SEC / _MAX_WAIT_SEC)', () => {
    expect(src).toContain('PAPERCUSP_SPA_QUIESCE_STABLE_SEC');
    expect(src).toContain('PAPERCUSP_SPA_QUIESCE_MAX_WAIT_SEC');
  });

  it('stamps the vite-watch heartbeat builtAtMs into the frozen snapshot', () => {
    expect(src).toContain('.frozen-heartbeat-built-at-ms');
    expect(src).toMatch(/SPA_HB_BUILT_AT_MS.*builtAtMs/);
  });

  it('check-freshness.sh compares the frozen heartbeat against the LIVE one and reports a rebuild since freeze', () => {
    // The generated helper (write_freshness_check_script's heredoc) must read
    // BOTH the frozen stamp and the current heartbeat, and only report when the
    // current one is strictly newer.
    expect(src).toContain('.frozen-heartbeat-built-at-ms');
    expect(src).toMatch(/CUR_HB_MS" -gt "\\?\$FROZEN_HB_MS/);
    expect(src).toMatch(/rebuilt at least once since this snapshot's freeze/);
  });

  it('never applies the quiescence wait when there is no shared assets dir to poll (no-op, not an error)', () => {
    // The polling LOOP itself is scoped inside `if [ -d "$SHARED_SPA_DIST/assets" ]`
    // so a not-yet-built operator-vite (the existing "WARNING: no built SPA"
    // branch) never spins on a directory that doesn't exist. The threshold vars
    // are declared just above the guard; the actual poll/sleep loop must be
    // inside it, terminated by its own `done` before the guard's `fi`.
    const guardIdx = src.indexOf('if [ -d "$SHARED_SPA_DIST/assets" ]; then');
    expect(guardIdx).toBeGreaterThan(-1);
    const afterGuard = src.slice(guardIdx, guardIdx + 1600);
    expect(afterGuard).toMatch(/while :; do[\s\S]*sleep "\$QUIESCE_POLL_SEC"[\s\S]*?\n\s*done\n\s*fi/);
  });
});
