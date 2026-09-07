/**
 * verify-tauri-headless-isolated-db.test.ts — the RECURRENCE GUARD for EI-10387.
 *
 * The bug: scripts/verify-tauri-headless.sh's header claimed the isolated
 * instance had its "own embedded-PG, own workspace state" — but the sidecar it
 * launched actually inherited the ambient env, so it connected to the SAME
 * live DATABASE_URL / PAPERCUSP_WORKSPACE as the real system. The Tauri
 * WebView also inherited the desktop profile, so localStorage preferences could
 * cross the supposedly write-safe boundary. An agent that trusted the header
 * could click a real Mug steering control (mutating owner state + waking the
 * real Mug) believing it was sandboxed.
 *
 * The fix: make the claim true, opt-in. VERIFY_TAURI_ISOLATED_DB=1 boots a
 * throwaway, fully-migrated, per-run embedded Postgres, scopes
 * PAPERCUSP_HOME/PAPERCUSP_WORKSPACE and the Tauri WebView profile to the run,
 * then *asserts at boot* by reading the REAL sidecar process's own
 * /proc/<pid>/environ — not just the launcher's own env construction — that the
 * resolved DB actually differs from the live one. It also round-trips a
 * localStorage sentinel in the private profile. The default (unset) mode is
 * left honestly documented as sharing the live DB/workspace/profile.
 *
 * A `readFileSync` text guard is the right shape here: the script boots a
 * real Tauri/Xvfb/Postgres stack, so its isolation wiring can only be
 * asserted at the wiring site, not by actually running it (same rationale as
 * verify-tauri-headless-spa-isolation.test.ts / tty-title-target.test.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-10387 — verify-tauri-headless can genuinely isolate the database', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
    expect(src).toContain('EI-10387');
  });

  it('no longer makes the false unconditional isolation claim', () => {
    // The original false claim, verbatim, must not appear as an assertion —
    // it may only appear (once) inside the corrective "used to claim" note.
    const falseClaimCount = (
      src.match(/own embedded-PG, own workspace state/g) ?? []
    ).length;
    expect(falseClaimCount).toBeLessThanOrEqual(1);
    expect(src).toMatch(/This header used to claim.*own embedded-PG, own workspace state/);
    expect(src).toContain('That was FALSE');
  });

  it('honestly documents the default (shared-DB) mode', () => {
    expect(src).toMatch(/\*\*NOT\*\* ISOLATED: the DATABASE, the WORKSPACE, and the WebView profile/);
    expect(src).toContain('EVERY WRITE YOU MAKE IN THIS WINDOW IS A REAL WRITE TO LIVE STATE');
  });

  it('is opt-in via VERIFY_TAURI_ISOLATED_DB and defaults OFF (unchanged default behavior)', () => {
    expect(src).toMatch(/ISOLATED_DB="\$\{VERIFY_TAURI_ISOLATED_DB:-0\}"/);
  });

  it('boots a throwaway, per-run embedded Postgres reusing the hermetic-test primitive', () => {
    // Reuse-first: the same primitive scripts/with-test-pg.mjs uses, not a
    // hand-rolled second embedded-PG bootstrapper.
    expect(src).toContain('startEmbeddedPostgresServer');
    expect(src).toMatch(/ISOLATED_PG_DATA_DIR="\$WORK\/isolated-pgdata"/);
  });

  it('scopes PAPERCUSP_HOME/PAPERCUSP_WORKSPACE to the run when isolated', () => {
    expect(src).toMatch(/ISOLATED_HOME="\$WORK\/papercusp-home"/);
    expect(src).toMatch(/ISOLATED_WORKSPACE="verify-tauri-isolated-\$DISPLAY_NUM"/);
    expect(src).toMatch(/PAPERCUSP_HOME=\\"\$ISOLATED_HOME\\"/);
    expect(src).toMatch(/PAPERCUSP_WORKSPACE=\\"\$ISOLATED_WORKSPACE\\"/);
  });

  it('isolates the Tauri WebView profile and guards localStorage with a sentinel', () => {
    expect(src).toMatch(/ISOLATED_WEBVIEW_ROOT="\$WORK\/webview-profile"/);
    expect(src).toMatch(/XDG_DATA_HOME=\\"\$ISOLATED_WEBVIEW_DATA\\"/);
    expect(src).toMatch(/XDG_CACHE_HOME=\\"\$ISOLATED_WEBVIEW_CACHE\\"/);
    expect(src).toMatch(/XDG_CONFIG_HOME=\\"\$ISOLATED_WEBVIEW_CONFIG\\"/);
    expect(src).toContain('PAPERCUSP_VERIFY_TAURI_ISOLATED=1');
    expect(src).toContain('dataDirectory');
    expect(src).toContain('verify-tauri-isolated=1');
    expect(src).toContain('ISOLATED_STORAGE_SENTINEL_KEY');
    expect(src).toContain('localStorage.getItem');
    expect(src).toContain('localStorage.setItem');
    expect(src).toContain('localStorage.removeItem');
    expect(src).toMatch(/rm -rf "\$ISOLATED_WEBVIEW_ROOT"/);
  });

  it('wins over .env.local DATABASE_URL via the admin/app URL resolver precedence', () => {
    expect(src).toContain('HARNESS_ADMIN_DATABASE_URL');
    expect(src).toContain('HARNESS_DATABASE_URL');
  });

  it('refuses to proceed if the isolated port collides with the live box-canonical PG', () => {
    expect(src).toMatch(/LIVE_PG_JSON="\$HOME\/\.papercusp\/embedded-pg\.json"/);
    expect(src).toMatch(/picked the SAME port .* as the live box-canonical embedded-pg\.json — refusing to proceed/);
  });

  it('asserts GROUND TRUTH at boot from the real sidecar\'s own /proc/<pid>/environ, not just its own env construction', () => {
    // This is the check that would have caught the original bug: an
    // intervening env layer (.env.local, DEFAULT_DEV_CMD) silently
    // re-clobbering our override must fail loudly, not "verify" the live DB.
    expect(src).toMatch(/tr '\\0' '\\n' < "\/proc\/\$p\/environ"/);
    expect(src).toContain('SIDECAR_ADMIN_URL');
    expect(src).toMatch(/if \[ "\$SIDECAR_ADMIN_URL" != "\$ISOLATED_ADMIN_URL" \]/);
    expect(src).toMatch(/Refusing to proceed — this would silently/);
  });

  it('hands the verified disposable database and workspace identity to assertion commands', () => {
    const handoff = src.match(
      /# EI-22622028658305763:[\s\S]*?log "running assertion command: \$\*"/,
    )?.[0];
    expect(handoff).toBeTruthy();
    expect(handoff).toContain('if [ "$ISOLATED_DB" = "1" ]');
    expect(handoff).toContain('export PAPERCUSP_HOME="$ISOLATED_HOME"');
    expect(handoff).toContain('export PAPERCUSP_WORKSPACE="$ISOLATED_WORKSPACE"');
    expect(handoff).toContain(
      'export HARNESS_ADMIN_DATABASE_URL="$ISOLATED_ADMIN_URL"',
    );
    expect(handoff).toContain(
      'export HARNESS_DATABASE_URL="$ISOLATED_APP_URL"',
    );
    expect(handoff).toContain('export PAPERCUSP_VERIFY_TAURI_ISOLATED=1');
  });

  it('discovers the frozen plain-node host as well as the legacy source-entry process', () => {
    expect(src).toContain(
      "OPERATOR_HOST_PROCESS_RE='bin/hono-host\\.ts|dist-verify/hono-host\\.mjs'",
    );
    const isolationGuard = src.match(
      /if \[ "\$ISOLATED_DB" = "1" \]; then[\s\S]*?EI-10387 isolation VERIFIED[\s\S]*?\nfi/,
    )?.[0];
    expect(isolationGuard).toBeTruthy();
    expect(isolationGuard).toContain('pgrep -f "$OPERATOR_HOST_PROCESS_RE"');
    expect(isolationGuard).toContain('OPERATOR_DEV_PORT=$DEV_PORT');
  });

  it('removes the throwaway datadir at teardown (never leaks a migrated cluster into $TMPDIR)', () => {
    expect(src).toMatch(/rm -rf "\$ISOLATED_PG_DATA_DIR"/);
  });

  it('prints an affirming banner (not the scary shared-DB warning) only when isolation is on', () => {
    expect(src).toContain('GENUINELY ISOLATED DATABASE (EI-10387)');
    expect(src).toMatch(/if \[ "\$ISOLATED_DB" = "1" \]/);
  });
});
