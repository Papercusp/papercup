/**
 * dht-liveness-cross-host-preflight.test.ts — the RECURRENCE GUARD for the
 * cross-host preflight/fallback branch of
 * apps/operator/scripts/papercup-dht-liveness-check.sh (P-302 / EI-8892).
 *
 * WHAT IT PROTECTS
 * ----------------
 * In cross-host mode the probe's DIALLING leg runs on the REMOTE host, so an
 * unreachable remote makes the whole run INCONCLUSIVE (exit 3,
 * 'remote-leg-unavailable'). The remote here is a LAPTOP. Wiring DHT_REMOTE_HOST
 * in unconditionally would therefore have been a REGRESSION, not a win: every
 * closed lid would have cost us the LOCAL bootstrap-wedge detection this timer
 * exists for (EI-8892 — a 3-day silent outage) AND filed an INCONCLUSIVE EI
 * every DHT_STALE_H forever.
 *
 * The shipped design: cross-host SUBSUMES the local check, so we ssh-preflight
 * the remote; if it answers we run the stronger cross-host probe, and if it does
 * not we fall back to a LOCAL-ONLY run (logged, never filed) so wedge detection
 * survives every tick. A REACHABLE-but-failing remote is NOT skipped — that is
 * the real P-302 signal — and DHT_REQUIRE_CROSS_HOST=1 is never silently
 * downgraded to a local pass.
 *
 * WHY IT RUNS THE SCRIPT INSTEAD OF GREPPING IT
 * ---------------------------------------------
 * A text guard here would only restate the diff. The property under test is
 * behavioural — WHICH ARGV reaches the probe, WHICH EXIT CODE comes back, and
 * WHETHER an EI is filed — so the script is executed for real against stub
 * `systemctl` / `ssh` / `node` / `curl` on PATH. The stub `node` is a faithful
 * model of the measured probe: given `--remote-host` while the remote is
 * unreachable it exits 3, exactly as the real probe did on 2026-08-16. That
 * model is what makes the fallback arm falsifiable rather than vacuous — remove
 * the preflight and the local-only arm inherits the exit-3 the strict arm proves
 * this harness can produce.
 *
 * TIER 2 (CLAUDE.md § "Proving a guard is falsifiable"): the subject path is
 * overridable via PROBE_SCRIPT so a mutation probe can point this suite at a
 * COPY outside the tree and never dirty the shared checkout:
 *
 *   scripts/mutation-probe.sh --file apps/operator/scripts/papercup-dht-liveness-check.sh \
 *     --mutate 's/^\s*DHT_REMOTE_HOST=""\s*$//' \
 *     --test 'PROBE_SCRIPT={} npm run test:file -- apps/operator/lib/dht-liveness-cross-host-preflight.test.ts'
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = process.env.PROBE_SCRIPT
  ? resolve(process.env.PROBE_SCRIPT)
  : resolve(__dirname, '../scripts/papercup-dht-liveness-check.sh');

let ROOT: string;
let BIN: string;

/** A stub that records its argv and answers like the real thing. */
function stub(name: string, body: string): void {
  const p = join(BIN, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
  chmodSync(p, 0o755);
}

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'dht-liveness-guard-'));
  BIN = join(ROOT, 'bin');
  mkdirSync(BIN, { recursive: true });

  // systemd is not running the unit here; answer the three property reads the
  // script actually makes so it gets past resolve/active/boot-grace.
  stub(
    'systemctl',
    `prop=""; prev=""
for a in "$@"; do [ "$prev" = "-p" ] && prop="$a"; prev="$a"; done
case "$prop" in
  Environment) echo "Environment=PAPERCUSP_DHT_HOST=127.0.0.1 PAPERCUSP_DHT_PORT=49737" ;;
  ActiveState) echo "active" ;;
  ActiveEnterTimestampMonotonic) echo "0" ;;
  *) echo "" ;;
esac
exit 0`,
  );

  // The preflight's reachability oracle.
  stub(
    'ssh',
    `printf '%s\\n' "$*" >>"$STUB_LOG_DIR/ssh.log"
exit "\${STUB_SSH_EXIT:-0}"`,
  );

  // Faithful model of p2p-dht-liveness-probe.mjs: a cross-host run against an
  // unreachable remote cannot carry out its experiment ⇒ 3 (INCONCLUSIVE).
  stub(
    'node',
    `printf '%s\\n' "$*" >>"$STUB_LOG_DIR/node-argv.log"
remote=0; for a in "$@"; do [ "$a" = "--remote-host" ] && remote=1; done
if [ "$remote" = 1 ] && [ "\${STUB_REMOTE_REACHABLE:-0}" != 1 ]; then
  echo "FAIL verdict=remote-leg-unavailable — proved: nothing"
  exit 3
fi
if [ "$remote" = 1 ]; then
  echo "OK [cross-host-verified] Packets demonstrably crossed the machine boundary"
else
  echo "OK two-process announce/connect completed on this host"
fi
exit 0`,
  );

  // EI filing goes through curl-MCP; record the attempt instead of making one.
  stub(
    'curl',
    `printf '%s\\n' "$*" >>"$STUB_LOG_DIR/curl.log"
echo '{"jsonrpc":"2.0","id":1,"result":{"content":[]}}'
exit 0`,
  );
});

afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

interface Run {
  status: number;
  stderr: string;
  probeArgv: string;
  sshTried: boolean;
  eiFiled: boolean;
}

function run(env: Record<string, string>): Run {
  const logs = mkdtempSync(join(ROOT, 'run-'));
  const state = join(logs, 'state');
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${BIN}:${process.env.PATH ?? ''}`,
      HOME: logs,
      STUB_LOG_DIR: logs,
      DHT_STATE_DIR: state,
      DHT_BOOT_GRACE_SEC: '0',
      DHT_PROBE_TIMEOUT_MS: '1000',
      // Point the bearer read at a path that does not exist: never touch the
      // real superuser token from a test.
      GATE_SUPERUSER_TOKEN_PATH: join(logs, 'no-such-token'),
      OPERATOR_MCP_URL: 'http://127.0.0.1:1/api/mcp',
      ...env,
    },
  });
  const read = (f: string) => (existsSync(join(logs, f)) ? readFileSync(join(logs, f), 'utf8') : '');
  return {
    status: r.status ?? -1,
    stderr: r.stderr ?? '',
    probeArgv: read('node-argv.log'),
    sshTried: read('ssh.log').length > 0,
    eiFiled: read('curl.log').length > 0,
  };
}

const REMOTE = { DHT_REMOTE_HOST: 'nobody@192.0.2.1', DHT_REMOTE_CWD: '/tmp/dht-probe' };
const UNREACHABLE = { STUB_SSH_EXIT: '255', STUB_REMOTE_REACHABLE: '0' };
const REACHABLE = { STUB_SSH_EXIT: '0', STUB_REMOTE_REACHABLE: '1' };

describe('papercup-dht-liveness-check.sh — cross-host preflight is best-effort, and never costs local wedge detection', () => {
  it('is the right script (guards a vacuous suite)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('papercup-dht-liveness');
    expect(src).toContain('p2p-dht-liveness-probe.mjs');
  });

  // ── CALIBRATION ────────────────────────────────────────────────────────────
  // These two prove the harness CAN produce exit 3, which is what makes the
  // fallback arm's exit 0 below a real result rather than a stub artifact.

  it('CALIBRATION: DHT_REQUIRE_CROSS_HOST=1 is NOT silently downgraded — an unreachable remote stays INCONCLUSIVE', () => {
    const r = run({ ...REMOTE, ...UNREACHABLE, DHT_REQUIRE_CROSS_HOST: '1' });
    expect(r.status).toBe(3);
    // Strict mode skips the preflight entirely: there is nothing to fall back to.
    expect(r.sshTried).toBe(false);
    expect(r.probeArgv).toContain('--remote-host');
    expect(r.probeArgv).toContain('--require-cross-host');
    expect(r.stderr).toContain('INCONCLUSIVE');
    // A strict-mode inconclusive IS a real signal and is filed — the contrast
    // that makes "not filed" in the fallback arm meaningful.
    expect(r.eiFiled).toBe(true);
  });

  it('CALIBRATION: DHT_REMOTE_OPTIONAL=0 opts out of the preflight, so an unreachable remote is INCONCLUSIVE', () => {
    const r = run({ ...REMOTE, ...UNREACHABLE, DHT_REMOTE_OPTIONAL: '0' });
    expect(r.status).toBe(3);
    expect(r.sshTried).toBe(false);
    expect(r.probeArgv).toContain('--remote-host');
  });

  // ── THE PROPERTY ───────────────────────────────────────────────────────────

  it('an unreachable remote falls back to LOCAL-ONLY: exit 0, no --remote-host, and NO EI filed', () => {
    const r = run({ ...REMOTE, ...UNREACHABLE });
    expect(r.sshTried).toBe(true); // the preflight actually ran
    expect(r.status).toBe(0); // wedge detection survived the closed lid
    expect(r.probeArgv).not.toContain('--remote-host'); // the leg was dropped, not attempted
    expect(r.eiFiled).toBe(false); // an off laptop is not a DHT signal
    expect(r.stderr).toContain('cross-host leg SKIPPED');
  });

  it('a REACHABLE remote is never skipped — the stronger cross-host probe runs', () => {
    const r = run({ ...REMOTE, ...REACHABLE });
    expect(r.status).toBe(0);
    expect(r.probeArgv).toContain('--remote-host');
    expect(r.probeArgv).toContain('--remote-cwd');
    expect(r.stderr).toContain('HEALTHY (CROSS-HOST)');
  });

  it('a reachable-but-FAILING remote is reported, not swallowed (the real P-302 signal)', () => {
    // Reachable by ssh, but the probe's cross-host leg fails.
    const r = run({ ...REMOTE, STUB_SSH_EXIT: '0', STUB_REMOTE_REACHABLE: '0' });
    expect(r.sshTried).toBe(true);
    expect(r.probeArgv).toContain('--remote-host'); // NOT dropped
    expect(r.status).not.toBe(0);
  });

  // ── THE THREE SUCCESS MESSAGES MUST STAY DISTINGUISHABLE ───────────────────
  // A skipped cross-host leg must never render as a deliberate local-only run,
  // and neither may ever render as cross-host health.

  it('distinguishes a SKIPPED cross-host leg from a deliberate local-only run', () => {
    const skipped = run({ ...REMOTE, ...UNREACHABLE });
    expect(skipped.stderr).toContain('HEALTHY (LOCAL-ONLY, cross-host SKIPPED)');
    expect(skipped.stderr).not.toContain('HEALTHY (CROSS-HOST)');
    expect(skipped.stderr).toContain('NOTHING is proven about machine-to-machine transport');

    const deliberate = run({}); // no DHT_REMOTE_HOST configured at all
    expect(deliberate.status).toBe(0);
    expect(deliberate.sshTried).toBe(false);
    expect(deliberate.stderr).toContain('HEALTHY (LOCAL-ONLY)');
    expect(deliberate.stderr).not.toContain('cross-host SKIPPED');
  });

  it('a cross-host pass states its own scope limit, so it can never be quoted as P-302 progress', () => {
    const r = run({ ...REMOTE, ...REACHABLE });
    // The fault P-302 chases is a per-PROCESS (app bundle identity) denial; this
    // probe measures standalone processes and is blind to it. Say so on the green.
    expect(r.stderr).toMatch(/standalone probe process/);
    expect(r.stderr).toMatch(/per-process denial on the app itself is NOT covered/);
  });
});
