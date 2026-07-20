/**
 * dev-operator-ifneeded-stale-reuse-warning.test.ts — the RECURRENCE GUARD for
 * EI-13537.
 *
 * The bug: `papercusp-desktop/bin/dev-operator-ifneeded.sh`'s reuse path
 * (`in_use`) only proves the port is BOUND — it never checks that the bound
 * process is actually the low-privilege, background-workers-OFF dev operator
 * this wrapper is supposed to guarantee (DEFAULT_DEV_CMD explicitly pins
 * `PAPERCUSP_BACKGROUND_WORKERS=0`). Confirmed live 2026-07-19: an orphaned
 * `hono-host.ts` process with no dev-operator-ifneeded.sh ancestry and no
 * reaper was squatting :3270 with `PAPERCUSP_BACKGROUND_WORKERS=1` (running
 * its own DBOS orchestrator/curation against the shared DB — the EI-126
 * two-hosts-one-DB class of bug) and was silently backing a real desktop
 * session's webview, because every `npm run dev` blindly reuse-adopts
 * whatever is already bound to :$PORT.
 *
 * The fix: on the reuse path, probe the already-public `/api/health/deep`
 * (which echoes `dbosEnabled`, mirroring `backgroundWorkersEnabled()` —
 * packages/operator-core/lib/background-workers.ts) and print a loud stderr
 * warning (visible in the Tauri dev console) instead of silently trusting a
 * misconfigured/leaked process. Best-effort — never blocks the reuse fast
 * path (still `exit 0` either way).
 *
 * A `readFileSync` text guard is the right shape here (same rationale as the
 * sibling verify-tauri-headless-*.test.ts): this wrapper boots a real
 * Tauri/operator stack, so its reuse-path wiring can only be asserted at the
 * wiring site, not by running it in CI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../papercusp-desktop/bin/dev-operator-ifneeded.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-13537 — dev-operator-ifneeded warns on a stale/misconfigured reuse instead of trusting it blindly', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('dev-operator-ifneeded');
    expect(src).toMatch(/^if in_use; then/m);
  });

  it('the reuse branch probes /api/health/deep for the bound process\'s dbosEnabled identity', () => {
    const reuseBranch = src.match(/if in_use; then([\s\S]*?)\nfi/)?.[1];
    expect(reuseBranch).toBeTruthy();
    expect(reuseBranch).toMatch(/curl -s --max-time 2 "http:\/\/127\.0\.0\.1:\$PORT\/api\/health\/deep"/);
  });

  it('warns (stderr) when the probe reports dbosEnabled:true — background workers unexpectedly ON', () => {
    const reuseBranch = src.match(/if in_use; then([\s\S]*?)\nfi/)?.[1];
    expect(reuseBranch).toBeTruthy();
    // The `case "$health" in` probe classifies a dbosEnabled:true bind as a
    // squatter (sets `squatter=1`); the warn-and-act response lives in the
    // subsequent `if [ "$squatter" = "1" ]; then … fi` block (EI-18175101264082617
    // moved the action out of the case so the squatter is actively terminated,
    // not merely logged).
    expect(reuseBranch).toMatch(/\*'"dbosEnabled":true'\*\)/);
    expect(reuseBranch).toMatch(/WARNING:.*dbosEnabled=true/);
    // Every warning line must go to stderr (>&2), not stdout — it must not be
    // mistaken for the normal "reusing" status line Tauri's beforeDevCommand
    // output parses. Extract the whole squatter-handling block, anchoring its
    // end on the outer `else` (uniquely the one followed by the reuse-path
    // comment), so it is robust to the exact indentation of the nested branch.
    const warningBlock = reuseBranch!.match(/if \[ "\$squatter" = "1" \]; then([\s\S]*?)\n\s*else\n\s*#/)?.[1];
    expect(warningBlock).toBeTruthy();
    const echoLines = warningBlock!.match(/^\s*echo .*$/gm) ?? [];
    expect(echoLines.length).toBeGreaterThan(0);
    for (const line of echoLines) expect(line).toMatch(/>&2\s*$/);
  });

  it('never blocks the reuse fast path — still exits 0 whether or not the probe warns', () => {
    const reuseBranch = src.match(/if in_use; then([\s\S]*?)\nfi/)?.[1];
    expect(reuseBranch).toBeTruthy();
    const exitIdx = reuseBranch!.lastIndexOf('exit 0');
    const caseIdx = reuseBranch!.indexOf('case "$health" in');
    expect(exitIdx).toBeGreaterThan(-1);
    expect(caseIdx).toBeGreaterThan(-1);
    // The exit must come AFTER the probe/warning block (so the probe always
    // gets a chance to run first) but is unconditional either way.
    expect(exitIdx).toBeGreaterThan(caseIdx);
  });

  it('the probe is best-effort: guarded by `command -v curl`, never a hard dependency', () => {
    const reuseBranch = src.match(/if in_use; then([\s\S]*?)\nfi/)?.[1];
    expect(reuseBranch).toMatch(/if command -v curl >\/dev\/null 2>&1; then/);
  });
});
