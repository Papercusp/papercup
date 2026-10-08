/**
 * scripts/run-operator-e2e-isolated.sh — the one-command isolated operator e2e runner
 * (WI-10006736; plan operator-e2e-standing-isolated-run-2026-10-06, P-001 / R-1).
 *
 * The real rig boots a whole desktop, so these tests swap in a stub rig that does exactly
 * what verify-tauri-headless.sh does at the assertion boundary: rebind
 * HARNESS_ADMIN_DATABASE_URL to a throwaway database, then run the command after `--`.
 * The stub playwright records the env and argv it was given and exits with a chosen code.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
const RUNNER = join(REPO_ROOT, 'scripts/run-operator-e2e-isolated.sh');
const SHARED = 'postgresql://shared-user:pw@shared-host:5432/papercusp';
const ISOLATED = 'postgresql://iso-user:pw@127.0.0.1:59999/throwaway';
const ISOLATED_WS = 'verify-tauri-isolated-99';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(playwrightExit: number, viteLogStyle: 'bare' | 'arrow' | 'color' = 'bare') {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-isolated-runner-'));
  dirs.push(dir);
  const record = join(dir, 'record.json');
  const viteCwd = join(dir, 'vite-cwd.txt');
  const rig = join(dir, 'rig.sh');
  writeFileSync(
    rig,
    [
      '#!/usr/bin/env bash',
      `[ "$VERIFY_TAURI_ISOLATED_DB" = "1" ] || { echo "rig: not isolated" >&2; exit 41; }`,
      '[ "$1" = "--" ] || { echo "rig: expected --" >&2; exit 42; }',
      'shift',
      `export HARNESS_ADMIN_DATABASE_URL='${ISOLATED}'`,
      // The real rig also rebinds the workspace identity for the app under test.
      `export PAPERCUSP_WORKSPACE_ID='${ISOLATED_WS}' PAPERCUSP_WORKSPACE='${ISOLATED_WS}'`,
      'export VERIFY_TAURI_DEV_URL=http://127.0.0.1:1420',
      'if [ -n "${E2E_FIXTURE_SOURCE_ROOT:-}" ]; then export OPERATOR_SOURCE_ROOT="$E2E_FIXTURE_SOURCE_ROOT"; fi',
      'if [ -n "${E2E_FIXTURE_ASSERT_DIR:-}" ]; then export VH_PHASE_DIR="$E2E_FIXTURE_ASSERT_DIR"; fi',
      '"$@"',
      'rc=$?',
      'if [ "${E2E_FIXTURE_REMOVE_SOURCE:-0}" = "1" ]; then rm -rf -- "$OPERATOR_SOURCE_ROOT"; fi',
      'exit "$rc"',
    ].join('\n'),
  );
  const pw = join(dir, 'playwright.sh');
  const npm = join(dir, 'npm');
  writeFileSync(
    npm,
    [
      '#!/usr/bin/env bash',
      'set -eu',
      'pwd > "$E2E_FIXTURE_VITE_CWD"',
      'if [ "${E2E_FIXTURE_VITE_FAIL:-0}" = "1" ]; then echo "fixture Vite bootstrap failure"; exit 74; fi',
      '[ "$1" = "run" ] && [ "$2" = "dev" ] || exit 73',
      'vite_port=',
      'expect_port=0',
      'for arg in "$@"; do',
      '  if [ "$expect_port" = "1" ]; then vite_port="$arg"; expect_port=0; continue; fi',
      '  case "$arg" in --port) expect_port=1 ;; --port=*) vite_port="${arg#--port=}" ;; esac',
      'done',
      '[ "$expect_port" = "0" ] && [ -n "$vite_port" ] || { echo "vite stub expected a port value" >&2; exit 78; }',
      'case "$vite_port" in *[!0-9]*|0) echo "vite stub expected a positive numeric port: $vite_port" >&2; exit 79;; esac',
      'if printenv PORT >/dev/null 2>&1; then echo "vite stub received a stale PORT" >&2; exit 77; fi',
      '[ "$OPERATOR_E2E_PORT" = "$vite_port" ] || { echo "vite stub CLI/env port mismatch: $vite_port / $OPERATOR_E2E_PORT" >&2; exit 80; }',
      'case " $* " in *" --host 127.0.0.1 "*) ;; *) echo "vite stub expected loopback host: $*" >&2; exit 74;; esac',
      'case " $* " in *" --strictPort "*) ;; *) echo "vite stub expected strictPort: $*" >&2; exit 76;; esac',
      // A formatted log that the runner never recognizes must fail promptly rather than
      // leave a server behind when spawnSync reaches its outer deadline.
      `exec node -e 'const http=require("node:http");const port=Number(process.env.OPERATOR_E2E_PORT);const style="${viteLogStyle}";const deadline=style==="bare"?null:setTimeout(()=>process.exit(81),5000);const s=http.createServer((_req,res)=>{clearTimeout(deadline);res.writeHead(200,{"content-type":"text/plain"});res.end("ready")});s.listen(port,"127.0.0.1",()=>{const url="http://127.0.0.1:"+s.address().port+"/";const esc=String.fromCharCode(27);console.log(style==="color"?"  "+esc+"[32m➜"+esc+"[39m  "+esc+"[1mLocal:"+esc+"[22m   "+esc+"[36m"+url+esc+"[39m":style==="arrow"?"  ➜  Local:   "+url:"  Local: "+url)})'`,
    ].join('\n'),
  );
  writeFileSync(
    pw,
    [
      '#!/usr/bin/env bash',
      'set -e',
      'artifact_dir=test-results',
      'for arg in "$@"; do case "$arg" in --output=*) artifact_dir="${arg#--output=}" ;; esac; done',
      'if [ "${E2E_FIXTURE_WRITE_ARTIFACTS:-0}" = "1" ]; then',
      '  mkdir -p "$artifact_dir/failed-spec"',
      '  for name in test-failed-1.png video.webm error-context.md trace.zip; do printf "fixture diagnostic %s\\n" "$name" > "$artifact_dir/failed-spec/$name"; done',
      'fi',
      'echo "fixture Playwright stdout"',
      'echo "fixture Playwright stderr" >&2',
      `node -e '(async()=>{const port=process.env.OPERATOR_E2E_PORT;const result={argv:process.argv.slice(2),cwd:process.cwd(),env:{ledger:process.env.PAPERCUSP_TEST_RUNS_DB_URL,admin:process.env.HARNESS_ADMIN_DATABASE_URL,group:process.env.PAPERCUSP_TEST_RUN_GROUP,port,api:process.env.PAPERCUSP_API_TARGET,disabled:process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER??null,ledgerWorkspace:process.env.PAPERCUSP_TEST_RUN_WORKSPACE??null,ledgerHarness:process.env.PAPERCUSP_TEST_RUN_HARNESS??null,appWorkspace:process.env.PAPERCUSP_WORKSPACE_ID??null,reuse:process.env.OPERATOR_E2E_REUSE_SERVER??null,baseUrl:process.env.OPERATOR_E2E_BASE_URL??null},viteStatus:null};if(port)result.viteStatus=(await fetch("http://127.0.0.1:"+port+"/")).status;require("node:fs").writeFileSync(process.argv[1],JSON.stringify(result))})().catch(error=>{console.error(error);process.exitCode=1})' '${record}' "$@"`,
      `exit ${playwrightExit}`,
    ].join('\n'),
  );
  chmodSync(rig, 0o755);
  chmodSync(npm, 0o755);
  chmodSync(pw, 0o755);
  return { dir, rig, pw, npm, record, viteCwd };
}

function run(f: ReturnType<typeof fixture>, args: string[], env: Record<string, string> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    'PAPERCUSP_TEST_RUNS_DB_URL',
    'PAPERCUSP_TEST_RUN_GROUP',
    'PAPERCUSP_TEST_RUN_WORKSPACE',
    'PAPERCUSP_TEST_RUN_HARNESS',
    'PAPERCUSP_WORKSPACE_ID',
    'PAPERCUSP_WORKSPACE',
    'HARNESS_SLUG',
    'PAPERCUSP_HARNESS_SLUG',
    'OPERATOR_SOURCE_ROOT',
    'VH_PHASE_DIR',
  ]) delete base[k];
  const res = spawnSync('bash', [RUNNER, ...args], {
    env: {
      ...base,
      HARNESS_ADMIN_DATABASE_URL: SHARED,
      OPERATOR_E2E_RIG: f.rig,
      OPERATOR_E2E_PLAYWRIGHT: f.pw,
      E2E_FIXTURE_VITE_CWD: f.viteCwd,
      PATH: `${f.dir}:${base.PATH ?? ''}`,
      ...env,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const recorded = existsSync(f.record) ? JSON.parse(readFileSync(f.record, 'utf8')) : null;
  const viteCwd = existsSync(f.viteCwd) ? readFileSync(f.viteCwd, 'utf8').trim() : null;
  return { status: res.status, out: `${res.stdout}\n${res.stderr}`, recorded, viteCwd };
}

describe('run-operator-e2e-isolated.sh', () => {
  it('exits with the playwright exit code when a spec fails', () => {
    const r = run(fixture(1), []);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('OPERATOR_E2E_ISOLATED exit=1');
  });

  it('exits 0 when the suite passes', () => {
    const r = run(fixture(0), []);
    expect(r.status, r.out).toBe(0);
  });

  it('points the ledger at the shared database while the app keeps the isolated one', () => {
    const r = run(fixture(0), []);
    expect(r.recorded, r.out).not.toBeNull();
    // Ledger rows go to the caller's shared database ...
    expect(r.recorded.env.ledger).toBe(SHARED);
    // ... while the system under test still sees the rig's throwaway database.
    expect(r.recorded.env.admin).toBe(ISOLATED);
    expect(r.recorded.cwd).toBe(join(REPO_ROOT, 'apps/operator'));
    expect(r.recorded.env.port).toMatch(/^\d+$/);
    expect(r.recorded.env.port).not.toBe('0');
    expect(r.recorded.env.reuse).toBe('1');
    expect(r.recorded.env.baseUrl).toBe(`http://127.0.0.1:${r.recorded.env.port}`);
    expect(r.recorded.viteStatus).toBe(200);
    expect(r.recorded.env.api).toBe('http://127.0.0.1:1420');
  });

  it('allocates a positive Vite port and passes it to Playwright reuse mode', () => {
    const r = run(fixture(0), [], { PORT: '39428', OPERATOR_E2E_PORT: '39428' });
    expect(r.status, r.out).toBe(0);
    expect(Number(r.recorded.env.port)).toBeGreaterThan(0);
    expect(r.recorded.env.port).not.toBe('39428');
    expect(r.out).toContain(`vite-port=${r.recorded.env.port}`);
    expect(r.recorded.env.reuse).toBe('1');
    expect(r.recorded.viteStatus).toBe(200);
  });

  it.each(['arrow', 'color'] as const)('recognizes the %s Vite readiness line and reaches Playwright', (style) => {
    const r = run(fixture(0, style), []);
    expect(r.status, r.out).toBe(0);
    expect(r.recorded, r.out).not.toBeNull();
    expect(r.recorded.viteStatus).toBe(200);
    expect(r.recorded.env.port).toMatch(/^[1-9]\d*$/);
    expect(r.out).toContain(`vite-port=${r.recorded.env.port}`);
  });

  it('runs Vite and Playwright from the verifier snapshot rather than the shared checkout', () => {
    const f = fixture(0);
    const sourceRoot = join(f.dir, 'committed snapshot');
    const operator = join(sourceRoot, 'apps/operator');
    mkdirSync(operator, { recursive: true });
    const r = run(f, ['cloud-tutorial', '--workers', '1'], { E2E_FIXTURE_SOURCE_ROOT: sourceRoot });
    expect(r.status, r.out).toBe(0);
    expect(r.viteCwd).toBe(operator);
    expect(r.recorded.cwd).toBe(operator);
    expect(r.recorded.argv).toEqual(['cloud-tutorial', '--workers', '1']);
    expect(r.recorded.viteStatus).toBe(200);
  });

  it('exports the frozen source root through the real verifier assertion boundary', () => {
    const verifier = readFileSync(join(REPO_ROOT, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const boundary = verifier.slice(verifier.lastIndexOf('\nverify_assertion_input_integrity || exit $?'));
    expect(boundary).toContain('log "running assertion command: $*"');
    const sourceRoot = join(fixture(0).dir, 'frozen source');
    const res = spawnSync('bash', ['-c', [
      'set -eu',
      'verify_assertion_input_integrity() { return 0; }',
      'vh_begin() { :; }',
      'log() { :; }',
      'ISOLATED_DB=0',
      'OPERATOR_SOURCE_ROOT="$1"',
      'shift',
      boundary,
    ].join('\n'), 'assertion-boundary', sourceRoot, process.execPath, '-e',
      'process.stdout.write(process.env.OPERATOR_SOURCE_ROOT ?? "missing")'], {
      env: { ...process.env, OPERATOR_SOURCE_ROOT: undefined },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(sourceRoot);
  });

  it('exports the retained assertion phase through the real verifier boundary', () => {
    const verifier = readFileSync(join(REPO_ROOT, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const boundary = verifier.slice(verifier.lastIndexOf('\nverify_assertion_input_integrity || exit $?'));
    const phaseDir = join(fixture(0).dir, 'retained assertion');
    const res = spawnSync('bash', ['-c', [
      'set -eu',
      'verify_assertion_input_integrity() { return 0; }',
      'vh_begin() { VH_PHASE_DIR="$E2E_FIXTURE_ASSERT_DIR"; }',
      'log() { :; }',
      'ISOLATED_DB=0',
      'OPERATOR_SOURCE_ROOT=/unused/frozen/source',
      boundary,
    ].join('\n'), 'assertion-boundary', process.execPath, '-e',
      'process.stdout.write(process.env.VH_PHASE_DIR ?? "missing")'], {
      env: { ...process.env, VH_PHASE_DIR: undefined, E2E_FIXTURE_ASSERT_DIR: phaseDir },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(phaseDir);
  });

  it('retains failed Playwright artifacts and both logs after frozen source teardown', () => {
    const f = fixture(1);
    const sourceRoot = join(f.dir, 'disposable source');
    const phaseDir = join(f.dir, 'retained assertion');
    mkdirSync(join(sourceRoot, 'apps/operator'), { recursive: true });
    const r = run(f, ['ongoing-work-ui', '--workers', '1'], {
      E2E_FIXTURE_SOURCE_ROOT: sourceRoot,
      E2E_FIXTURE_ASSERT_DIR: phaseDir,
      E2E_FIXTURE_REMOVE_SOURCE: '1',
      E2E_FIXTURE_WRITE_ARTIFACTS: '1',
    });
    expect(r.status, r.out).toBe(1);
    expect(existsSync(sourceRoot)).toBe(false);
    for (const name of ['test-failed-1.png', 'video.webm', 'error-context.md', 'trace.zip']) {
      expect(readFileSync(join(phaseDir, 'playwright/failed-spec', name), 'utf8')).toContain(name);
    }
    expect(readFileSync(join(phaseDir, 'vite.log'), 'utf8')).toContain('Local:');
    const output = readFileSync(join(phaseDir, 'playwright.log'), 'utf8');
    expect(output).toContain('fixture Playwright stdout');
    expect(output).toContain('fixture Playwright stderr');
    expect(r.recorded.argv).toContain('--trace=retain-on-failure');
    expect(r.recorded.argv.slice(0, 3)).toEqual(['ongoing-work-ui', '--workers', '1']);
  });

  it('retains the Vite bootstrap failure log without claiming Playwright ran', () => {
    const f = fixture(0);
    const phaseDir = join(f.dir, 'retained assertion');
    const r = run(f, [], { E2E_FIXTURE_ASSERT_DIR: phaseDir, E2E_FIXTURE_VITE_FAIL: '1' });
    expect(r.status, r.out).toBe(98);
    expect(r.recorded).toBeNull();
    expect(readFileSync(join(phaseDir, 'vite.log'), 'utf8')).toContain('fixture Vite bootstrap failure');
  });

  it('refuses a missing snapshot operator instead of falling back to shared source', () => {
    const f = fixture(0);
    const r = run(f, [], { E2E_FIXTURE_SOURCE_ROOT: join(f.dir, 'missing snapshot') });
    expect(r.status, r.out).toBe(97);
    expect(r.viteCwd).toBeNull();
    expect(r.recorded).toBeNull();
  });

  it('stamps one run group on the whole invocation and honours a caller-supplied one', () => {
    const auto = run(fixture(0), []);
    expect(auto.recorded.env.group).toMatch(/^operator-e2e-isolated-\d{8}T\d{6}Z-\d+$/);
    expect(auto.out).toContain(`group=${auto.recorded.env.group}`);
    const pinned = run(fixture(0), [], { PAPERCUSP_TEST_RUN_GROUP: 'nightly-42' });
    expect(pinned.recorded.env.group).toBe('nightly-42');
  });

  it('prefers an explicit PAPERCUSP_TEST_RUNS_DB_URL over the caller admin URL', () => {
    const r = run(fixture(0), [], { PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://ledger-only/db' });
    expect(r.recorded.env.ledger).toBe('postgresql://ledger-only/db');
  });

  it('pins the ledger workspace + harness to the caller while the app keeps the rig workspace', () => {
    // Measured 2026-10-06: without this, rows 20845991/20845992 were stamped
    // workspace_id=verify-tauri-isolated-90 and refused by workspace-scoped readers.
    const r = run(fixture(0), [], { PAPERCUSP_WORKSPACE_ID: 'caller-ws' });
    expect(r.recorded, r.out).not.toBeNull();
    expect(r.recorded.env.ledgerWorkspace).toBe('caller-ws');
    expect(r.recorded.env.appWorkspace).toBe(ISOLATED_WS);
    expect(r.recorded.env.ledgerHarness).toBe('papercusp');
  });

  it('keeps an explicit ledger workspace/harness override and falls back to PAPERCUSP_WORKSPACE', () => {
    const explicit = run(fixture(0), [], {
      PAPERCUSP_TEST_RUN_WORKSPACE: 'explicit-ws',
      PAPERCUSP_WORKSPACE_ID: 'caller-ws',
      PAPERCUSP_TEST_RUN_HARNESS: 'other-harness',
    });
    expect(explicit.recorded.env.ledgerWorkspace).toBe('explicit-ws');
    expect(explicit.recorded.env.ledgerHarness).toBe('other-harness');
    const legacy = run(fixture(0), [], { PAPERCUSP_WORKSPACE: 'legacy-ws' });
    expect(legacy.recorded.env.ledgerWorkspace).toBe('legacy-ws');
  });

  it('warns, and leaves the override unset, when the caller has no workspace', () => {
    const r = run(fixture(0), []);
    expect(r.status, r.out).toBe(0);
    expect(r.recorded.env.ledgerWorkspace).toBeNull();
    expect(r.out).toContain('WARNING no caller workspace');
  });

  it('forwards spec filters to playwright', () => {
    const r = run(fixture(0), ['card-response', '--workers', '2']);
    expect(r.recorded.argv).toEqual(['card-response', '--workers', '2']);
  });

  it('refuses --reporter (it would disable the ledger reporter) without starting the rig', () => {
    for (const arg of ['--reporter=list', '--reporter']) {
      const f = fixture(0);
      const r = run(f, [arg, 'list']);
      expect(r.status, r.out).toBe(2);
      expect(r.out).toContain('EI-25232220211651248');
      expect(r.recorded).toBeNull();
    }
  });

  it('clears a caller-level reporter opt-out so the run always records', () => {
    const r = run(fixture(0), [], { PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1' });
    expect(r.recorded.env.disabled).toBeNull();
  });
});
