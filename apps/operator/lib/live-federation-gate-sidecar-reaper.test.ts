/**
 * live-federation-gate-sidecar-reaper.test.ts — RECURRENCE GUARD for EI-14500.
 *
 * The bug: a `live-federation-gate.sh` leg boots the packaged "Papercusp Server"
 * (node … serve.mjs --ensure, with its OWN isolated PAPERCUSP_HOME + embedded PG on
 * a private port) to verify the real binary. That sidecar is setsid-detached, so if a
 * leg tears down uncleanly — or the gate takes ANY early / non-zero exit — the sidecar
 * (and its embedded PG) get reparented to systemd --user and keep running for HOURS as
 * orphans (observed: pid 3703547 + embedded PG pid 3704905 survived ~10h). While alive
 * each internal `--ensure` retry was a standing hazard for the embedded-pg.json
 * box-hijack class (EI-13917).
 *
 * The fix: a `reap_gate_sidecars` swept from the gate's EXIT trap, so it fires on EVERY
 * exit path (happy, early, non-zero, external TERM). It reaps only sidecars THIS gate
 * transitively spawned, gated by the SAME rig-ownership test the prod-port guard uses
 * (cgroup membership in this gate service — reliable in the timer run, since a setsid
 * child stays in the spawning service's cgroup and at EXIT-trap time the gate is still
 * alive so its subtree is intact — OR a cwd/cmdline under a rig sandbox), so a real
 * (prod/live) operator sidecar is NEVER touched. SIGTERM, brief grace, then SIGKILL.
 *
 * A `readFileSync` wiring guard is the right shape for the trap/pgrep/escalation wiring
 * (same rationale as the sibling verify-tauri-headless-*.test.ts family — the gate boots
 * a real packaged binary, so its EXIT wiring can only be asserted at the wiring site).
 * The SAFETY-CRITICAL half — that the ownership predicate reaps a rig-owned serve.mjs
 * process while sparing a foreign one — is verified BEHAVIORALLY against real processes
 * (hermetic: a run-random nonce keeps it matching only its own two fixtures, never a
 * box-wide pgrep, so it can never disturb a concurrently-running live gate).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../papercusp-desktop/bin/live-federation-gate.sh');
const src = readFileSync(SCRIPT, 'utf8');

// Body of one shell function, from its `name() {` header to the first column-0 `}`.
function fnBody(name: string): string {
  const m = src.match(new RegExp(`^${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`, 'm'));
  return m?.[1] ?? '';
}

describe('EI-14500 — live-federation-gate reaps its leaked packaged-server sidecars on exit', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('live-federation-gate');
    // The whole premise: a leg boots `serve.mjs --ensure` sidecars that can leak.
    expect(src).toContain('serve.mjs');
  });

  it('the EXIT trap fires the reaper — so it runs on EVERY exit path, not just the happy one', () => {
    // The single EXIT trap already reaped the port-guard sweep; the reaper joins it there
    // (an EXIT trap fires on early/non-zero/normal exit alike — the fix requirement).
    expect(src).toContain(
      `trap 'guard_prod_ports exit-trap; reap_gate_sidecars; kill "$GUARD_SWEEP_PID" 2>/dev/null || true' EXIT`,
    );
    // And it is a real reaper, not a no-op.
    expect(src).toContain('reap_gate_sidecars() {');
    expect(src).toContain('gate_owns_rig_pid() {');
  });

  it('the reaper enumerates the sidecar AND its embedded PG, and escalates SIGTERM → SIGKILL', () => {
    const body = fnBody('reap_gate_sidecars');
    expect(body).toBeTruthy();
    // serve.(mjs|ts) = the sidecar (incl. `--ensure`); embedded-pg-data = the leaked
    // `postgres -D …` child that was its own orphaned pid in the incident.
    expect(body).toContain("pgrep -f 'serve\\.(mjs|ts)|embedded-pg-data'");
    // Graceful first (lets serve.mjs drain its embedded PG), then force any survivor.
    const term = body.indexOf('kill "$pid" 2>/dev/null || true');
    const grace = body.indexOf('sleep "$GATE_SIDECAR_REAP_GRACE_S"');
    const forceKill = body.indexOf('kill -9 "$pid"');
    expect(term).toBeGreaterThan(-1);
    expect(grace).toBeGreaterThan(term);
    expect(forceKill).toBeGreaterThan(grace);
  });

  it('ownership is gated by the same rig test as the prod-port guard (a prod/live sidecar is NEVER touched)', () => {
    const body = fnBody('gate_owns_rig_pid');
    expect(body).toBeTruthy();
    // Timer-run catch-all: a setsid child stays in the spawning SERVICE's cgroup.
    expect(body).toContain(`grep -qa 'live-federation-gate' "/proc/$pid/cgroup"`);
    // Manual-run catch: cwd/cmdline under a rig sandbox (a lane fed dir, a rig mktemp
    // prefix, or the gate's own $WORK). A grep here reads BOTH cwd and cmdline.
    expect(body).toContain('readlink -f "/proc/$pid/cwd"');
    expect(body).toContain('papercusp-lane-[a-z0-9-]*-fed');
    expect(body).toContain('/tmp/hive-fromrepo-smoke');
  });
});

describe('EI-14500 — ownership predicate behavior (reaps rig-owned, spares foreign)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('gate_owns_rig_pid claims a rig-owned serve.mjs pid and a scoped reap kills it, while a foreign one survives', () => {
    if (process.platform !== 'linux' || !existsSync('/proc/self/cwd')) return; // needs procfs
    // dot-free temp dirs so $WORK is a literal-safe grep -E operand.
    const work = mkdtempSync(join(tmpdir(), 'reaprig-'));
    const other = mkdtempSync(join(tmpdir(), 'reapforeign-'));
    dirs.push(work, other);

    // The harness sources the REAL gate_owns_rig_pid from the script (not a copy), then
    // exercises it against two real fixtures. Two invariants keep it hermetic:
    //   1. It NEVER box-wide-pgreps for real sidecars — the reap loop only ever considers
    //      its own two fixture pids — so a concurrent live gate is never disturbed.
    //   2. The fixture-identifying nonces are generated at RUNTIME (never in any argv), so
    //      pgrep/pkill can never self-match the harness (the marker-in-argv trap).
    const harness = `
set -uo pipefail
log(){ :; }
GATE_SIDECAR_REAP_GRACE_S=1
WORK="$1"; OTHER="$2"; SCRIPT="$3"
eval "$(sed -n '/^gate_owns_rig_pid() {/,/^}/p' "$SCRIPT")"
NOWN="reapo$(od -An -N6 -tx1 /dev/urandom | tr -d ' \\n')"
NFGN="reapf$(od -An -N6 -tx1 /dev/urandom | tr -d ' \\n')"
mkdir -p "$WORK/side" "$OTHER/side"
( cd "$WORK/side"  && exec -a "node --require sidecar-preload.js serve.mjs --ensure $NOWN" sleep 20 ) >/dev/null 2>&1 &
( cd "$OTHER/side" && exec -a "node --require sidecar-preload.js serve.mjs --ensure $NFGN" sleep 20 ) >/dev/null 2>&1 &
sleep 0.5
OWNED="$(pgrep -f "$NOWN" | head -1)"
FOREIGN="$(pgrep -f "$NFGN" | head -1)"
ov=foreign; [ -n "$OWNED" ]   && gate_owns_rig_pid "$OWNED"   && ov=owned
fv=foreign; [ -n "$FOREIGN" ] && gate_owns_rig_pid "$FOREIGN" && fv=owned
# scoped reap over exactly our two pids, using the REAL predicate:
for pid in "$OWNED" "$FOREIGN"; do [ -n "$pid" ] && gate_owns_rig_pid "$pid" && kill "$pid" 2>/dev/null || true; done
sleep 0.6
oa=dead; [ -n "$OWNED" ]   && kill -0 "$OWNED"   2>/dev/null && oa=alive
fa=dead; [ -n "$FOREIGN" ] && kill -0 "$FOREIGN" 2>/dev/null && fa=alive
pkill -f "$NOWN" 2>/dev/null || true
pkill -f "$NFGN" 2>/dev/null || true
echo "OWNED=$ov FOREIGN=$fv OWNED_ALIVE=$oa FOREIGN_ALIVE=$fa"
`;
    const out = execFileSync('bash', ['-c', harness, 'harness', work, other, SCRIPT], {
      encoding: 'utf8',
      timeout: 20_000,
    }).trim();

    // The rig-owned sidecar is claimed and reaped; the foreign one is neither.
    expect(out).toContain('OWNED=owned');
    expect(out).toContain('FOREIGN=foreign');
    expect(out).toContain('OWNED_ALIVE=dead');
    expect(out).toContain('FOREIGN_ALIVE=alive');
  });
});
