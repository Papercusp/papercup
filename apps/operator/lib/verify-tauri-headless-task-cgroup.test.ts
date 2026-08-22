/**
 * verify-tauri-headless-task-cgroup.test.ts — recurrence guard for
 * EI-21080873216359703.
 *
 * A capability:bash background job already owns a durable managed task
 * service. Starting verifier children with nested systemd scopes creates
 * sibling cgroups outside that task ledger, so the verifier must inherit the
 * caller's cgroup whenever the reserved task marker is present.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const scopeSelection = src.match(
  /CAPABILITY_BASH_BACKGROUND_TASK_ID="\$\{PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID:-\}"[\s\S]*?\nfi\n\n# Ports are DERIVED/,
 )?.[0];
const launcher = src.match(/start_verify_process\(\) \{[\s\S]*?\n\}/)?.[0];
const bootOnlyWriter = src.match(/write_boot_only_env_script\(\) \{[\s\S]*?\n\}/)?.[0];

describe('EI-21080873216359703 — verifier children stay in the managed bash task', () => {
  it('uses capability:bash task provenance to select inherited cgroup mode', () => {
    expect(scopeSelection).toBeTruthy();
    expect(scopeSelection).toContain('PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID');
    expect(scopeSelection).toContain('if [ -n "$CAPABILITY_BASH_BACKGROUND_TASK_ID" ]; then');
    expect(scopeSelection).toContain('VERIFY_SCOPE_MODE="inherit"');
    expect(scopeSelection).toContain('VERIFY_SCOPE_INHERITED=1');
    expect(scopeSelection).toContain('elif [ "$(uname -s 2>/dev/null || true)" = "Linux" ]');
    expect(scopeSelection).toContain('VERIFY_SCOPE_MODE="sibling"');
  });

  it('inherits a visible terminal cgroup for direct launches instead of making a verifier sibling', () => {
    expect(scopeSelection).toBeTruthy();
    expect(src).toContain('verifier_caller_is_terminal_scope()');
    expect(src).toContain('*/vte-spawn-*.scope');
    expect(src).toContain('*/papercup-console-*.scope');
    expect(scopeSelection).toContain('elif verifier_caller_is_terminal_scope; then');
    expect(scopeSelection).toContain('VERIFY_SCOPE_MODE="terminal"');
    expect(scopeSelection).toContain('terminal window owns lifecycle');
  });

  it('launches inherited-mode processes with setsid, reserving systemd-run for sibling fallback', () => {
    expect(launcher).toBeTruthy();
    expect(launcher).toContain('if [ "$VERIFY_SCOPE_MODE" = "sibling" ]; then');
    expect(launcher).toContain('setsid systemd-run --user --scope');
    expect(launcher).toContain('setsid "$@" >"$output" 2>&1 &');
  });

  it('only advertises a verifier-local scope for local-scope teardown', () => {
    expect(src).toContain('if [ "$VERIFY_SCOPE_ENABLED" = 1 ] && command -v systemctl');
    expect(bootOnlyWriter).toBeTruthy();
    expect(bootOnlyWriter).toContain('if [ "$VERIFY_SCOPE_ENABLED" = 1 ]; then');
    expect(bootOnlyWriter).toContain('printf \'VERIFY_TAURI_SCOPE_UNIT=%q\\n\' "$EXPORTED_SCOPE_UNIT"');
    expect(bootOnlyWriter).toContain('printf \'VERIFY_TAURI_SCOPE_MODE=%q\\n\' "$VERIFY_SCOPE_MODE"');
    expect(bootOnlyWriter).toContain('printf \'VERIFY_TAURI_SCOPE_INHERITED=%q\\n\' "$VERIFY_SCOPE_INHERITED"');
  });
});
