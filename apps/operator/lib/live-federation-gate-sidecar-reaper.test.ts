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
 * transitively spawned, gated by cgroup membership in this gate service (reliable in
 * the timer run, since a setsid child stays in the spawning service's cgroup) OR an
 * exact inherited per-run marker / cwd under this gate's own $WORK. A shared rig-prefix
 * match is deliberately insufficient: that would reap a concurrently-live foreign run.
 * A real prod/live operator sidecar is NEVER touched. SIGTERM, brief grace, then SIGKILL.
 *
 * Test shape: a `readFileSync` wiring guard for the trap/pgrep/escalation wiring (same
 * rationale as the sibling verify-tauri-headless-*.test.ts family — the gate boots a
 * real packaged binary, so its EXIT wiring can only be asserted at the wiring site),
 * PLUS a behavioral check of the SAFETY-CRITICAL half: that the real `gate_owns_rig_pid`
 * predicate claims a rig-owned process (cwd under the gate $WORK) while sparing a foreign
 * one. The behavioral check is hermetic and portable — a subshell `cd`s under the sandbox
 * and evaluates the predicate on its OWN pid ($BASHPID), so there is no cross-process
 * /proc read, no pgrep, and nothing outside the test is ever touched.
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
    // (an EXIT trap fires on early/non-zero/normal exit alike — the fix requirement). It
    // also cleans up the EI-16828 self-snapshot dir (bash traps don't stack — only ONE
    // EXIT trap handler is ever active — so every EXIT-time cleanup lives in this one line).
    expect(src).toContain(
      `trap 'guard_prod_ports exit-trap; reap_gate_sidecars; kill "$GUARD_SWEEP_PID" 2>/dev/null || true; rm -rf -- "\${GATE_SELF_SNAPSHOT_DIR:-}" 2>/dev/null || true' EXIT`,
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

  it('ownership is exact-run scoped (a prod/live or foreign rig sidecar is NEVER touched)', () => {
    const body = fnBody('gate_owns_rig_pid');
    expect(body).toBeTruthy();
    // Timer-run catch-all: a setsid child stays in the spawning SERVICE's cgroup.
    expect(body).toContain(`grep -qa 'live-federation-gate' "/proc/$pid/cgroup"`);
    // Manual-run catch: an exact inherited run marker, with this gate's own $WORK
    // as a narrow cwd/cmdline fallback. A canonical rig prefix is a class, not ownership.
    expect(src).toContain('export PAPERCUSP_LIVE_FED_GATE_RUN="$WORK"');
    expect(body).toContain('"/proc/$pid/environ"');
    expect(body).toContain('[ "$marker" = "PAPERCUSP_LIVE_FED_GATE_RUN=$WORK" ]');
    expect(body).toContain('readlink -f "/proc/$pid/cwd"');
    expect(body).toContain('grep -qaF "$WORK" <<<"$info"');
    expect(body).not.toMatch(/grep[^\n]*\/tmp\/hive-fromrepo-smoke/);
  });
});

describe('EI-14500 — ownership predicate behavior (claims rig-owned, spares foreign)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('the real gate_owns_rig_pid claims a cwd under the gate $WORK and spares one outside it', () => {
    if (process.platform !== 'linux' || !existsSync('/proc/self/cwd')) return; // needs procfs
    const parent = mkdtempSync(join(tmpdir(), 'reaptest-'));
    dirs.push(parent);

    // Source the REAL gate_owns_rig_pid from the script (not a copy). Each check runs in a
    // subshell that cd's into the target dir and evaluates the predicate on its OWN pid
    // ($BASHPID) — a same-process /proc read, so it is portable and touches nothing else.
    // WORK/OTHER are minted INSIDE the harness (dot-free, so $WORK is a literal-safe grep
    // operand) — their values never enter any argv, so the predicate's cmdline branch,
    // which reads the parent bash's argv, cannot spuriously match on them.
    const harness = `
set -uo pipefail
log(){ :; }
SCRIPT="$1"; PARENT="$2"
eval "$(sed -n '/^gate_owns_rig_pid() {/,/^}/p' "$SCRIPT")"
WORK="$(mktemp -d "$PARENT/reaprigXXXXXX")"
OTHER="$(mktemp -d "$PARENT/reapotherXXXXXX")"
export WORK
mkdir -p "$WORK/side" "$OTHER/side"
( cd "$WORK/side"  && gate_owns_rig_pid "$BASHPID" ) && ov=owned || ov=foreign
( cd "$OTHER/side" && gate_owns_rig_pid "$BASHPID" ) && fv=owned || fv=foreign
echo "OWNED=$ov FOREIGN=$fv"
`;
    const out = execFileSync('bash', ['-c', harness, 'harness', SCRIPT, parent], {
      encoding: 'utf8',
      timeout: 20_000,
    }).trim();

    // A rig-owned sidecar (cwd under $WORK) is reaped; a foreign one (a prod/live
    // sidecar, cwd elsewhere) is spared — the effectiveness AND the safety guarantee.
    expect(out).toContain('OWNED=owned');
    expect(out).toContain('FOREIGN=foreign');
  });
});
