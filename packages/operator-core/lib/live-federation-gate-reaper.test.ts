/**
 * live-federation-gate-reaper.test.ts — regression guard for EI-14500.
 *
 * The live-federation gate (papercusp-desktop/bin/live-federation-gate.sh) boots a
 * packaged "Papercusp Server" sidecar (node … serve.mjs --ensure) with its OWN isolated
 * PAPERCUSP_HOME + embedded PG. On ANY early / non-zero gate exit that setsid-detached
 * sidecar (and its embedded PG) got reparented to systemd --user and ran for ~10h as an
 * orphan — a standing box-hijack hazard (each internal --ensure retry could re-trigger the
 * embedded-pg.json hijack class). The fix wired an EXIT-trap reaper (reap_gate_sidecars)
 * that SIGTERM→SIGKILLs rig-owned leftover serve.(mjs|ts)/embedded-pg processes, gated by a
 * rig-ownership test (gate_owns_rig_pid) so a REAL prod/live sidecar is NEVER touched.
 *
 * Writing this guard surfaced a REAL latent defect in that first fix (not just a testing
 * gap): gate_owns_rig_pid / guard_prod_ports read the target's cwd+cmdline via
 * `{ readlink…; tr…; } | grep -q …`. The gate runs under `set -o pipefail`, so `grep -q`
 * short-circuits on the FIRST matching line, closes the pipe, `tr` takes SIGPIPE, and the
 * pipeline reports non-zero — making `… && return 0` MISFIRE. gate_owns_rig_pid then returned
 * "not owned" for a genuinely rig-owned pid, so reap_gate_sidecars `continue`d past every
 * owned orphan and NEVER reaped it: the EI-14500 leak persisted despite the trap. The fix
 * captures the proc info into a var and greps a here-string (no pipeline → no SIGPIPE).
 *
 * BEHAVIORAL leg (Linux only): runs the bash micro-test, which extracts the REAL reaper
 * functions from the gate and proves a rig-owned fake is reaped while a non-rig one is
 * spared. STATIC leg (all platforms): pins the pipefail-safe shape + the wired trap so a
 * later edit cannot reinstate the SIGPIPE-fragile pipeline or drop the reaper from EXIT.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-reaper.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'live-federation-gate.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/live-federation-gate.sh above this test)',
  );
}

const ROOT = repoRoot();
const GATE_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const SELFTEST_PATH = join(
  ROOT,
  'papercusp-desktop',
  'bin',
  'lib',
  'live-federation-gate-reaper.selftest.sh',
);
const gate = readFileSync(GATE_PATH, 'utf8');

describe('EI-14500: leaked-sidecar reaper is wired and rig-scoped', () => {
  it('defines reap_gate_sidecars and calls it on the EXIT path', () => {
    expect(gate).toMatch(/reap_gate_sidecars\(\)\s*\{/);
    // The reaper must run on EXIT — including a non-zero / early exit — or orphans leak.
    expect(gate).toMatch(/trap '[^']*reap_gate_sidecars[^']*' EXIT/);
  });

  it('reaps rig-owned serve.(mjs|ts) + embedded-pg leftovers, escalating SIGTERM→SIGKILL', () => {
    expect(gate).toMatch(/pgrep -f 'serve\\\.\(mjs\|ts\)\|embedded-pg-data'/);
    // SIGTERM first, then SIGKILL for a survivor after the drain grace.
    expect(gate).toMatch(/kill "\$pid"/);
    expect(gate).toMatch(/kill -9 "\$pid"/);
  });
});

describe('EI-14500/WI-40905: ownership read is pipefail-safe and exact-run scoped', () => {
  it('uses exact marker/$WORK reads, while the prod-port guard keeps its pipefail-safe here-string', () => {
    // The buggy shape short-circuited grep -q → SIGPIPE on tr → pipefail non-zero →
    // owned pids misread as "not owned" → never reaped. The prod-port ownership read
    // retains its capture-then-here-string form.
    const hereStrings = gate.match(/grep -qaE "papercusp-lane[^"]*" <<<"\$info"/g) ?? [];
    expect(hereStrings.length).toBeGreaterThanOrEqual(1);
    // The reaper's manual-run path is narrower: exact inherited marker, then exact
    // $WORK fallback. Broad canonical-prefix ownership killed a live peer rig.
    expect(gate).toContain('export PAPERCUSP_LIVE_FED_GATE_RUN="$WORK"');
    expect(gate).toContain('[ "$marker" = "PAPERCUSP_LIVE_FED_GATE_RUN=$WORK" ]');
    expect(gate).toContain('grep -qaF "$WORK" <<<"$info"');
    // The SIGPIPE-fragile pipeline form must be gone for the rig-ownership check.
    expect(gate).not.toMatch(/2>\/dev\/null; \} \\\s*\n\s*\| grep -qaE "papercusp-lane/);
  });
});

describe('EI-14500: behavioral reaper micro-test passes on the real gate functions', () => {
  it('reaps a rig-owned fake and spares a non-rig one (Linux)', () => {
    if (process.platform !== 'linux') {
      // The reaper inspects /proc/<pid>/cwd — meaningful only on Linux (the gate's box).
      return;
    }
    expect(existsSync(SELFTEST_PATH)).toBe(true);
    let out = '';
    try {
      out = execFileSync('bash', [SELFTEST_PATH], { encoding: 'utf8', timeout: 30_000 });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        `reaper selftest failed:\n${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`,
      );
    }
    expect(out).toContain('live-federation-gate reaper selftest: PASS');
    expect(out).not.toMatch(/✗/);
  });
});
