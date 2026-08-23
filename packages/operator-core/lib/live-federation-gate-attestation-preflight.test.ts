/**
 * Regression guard for WI-38664 / EI-20192345878553998.
 *
 * GitHub permits authenticated READS for an account whose email is unverified while rejecting
 * gist CREATION with 422. The live federation wrapper used to prove only a read, rebuild a
 * multi-GB desktop bundle, and discover the account wall deep inside the smokes. These tests
 * execute the real shipping preflight functions with only `gh` and `npx` replaced at their I/O
 * boundaries. They pin two distinct accounts, both write probes, fail-fast ordering before the
 * build, and the exact email_unverified signal. The content-matrix's own probe stays as a second
 * defense for direct invocations.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'live-federation-gate.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate papercusp-desktop/bin/live-federation-gate.sh');
}

const ROOT = repoRoot();
// PROBE_SCRIPT makes the subject path overridable so falsifiability can be proven with a
// tier-2 copy-out mutation (scripts/mutation-probe.sh) instead of mutating the shared tree.
// An in-tree probe here is unsafe for a reason no `trap` can fix: git-sync sweeps the whole
// working tree on a schedule, so a mutant held for the duration of a run can be COMMITTED
// even when nothing goes wrong. Defaults to the real shipping script.
const GATE_PATH =
  process.env.PROBE_SCRIPT ?? join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const FEDERATION_ASSERTS_PATH = join(
  ROOT,
  'papercusp-desktop',
  'bin',
  'lib',
  'federation-asserts.sh',
);
const LOCAL_MATRIX_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'local-matrix.sh');
const MATRIX_PATH = join(
  ROOT,
  'papercusp-desktop',
  'bin',
  'two-instance-content-matrix-smoke.sh',
);
const gate = readFileSync(GATE_PATH, 'utf8');
const federationAsserts = readFileSync(FEDERATION_ASSERTS_PATH, 'utf8');
const localMatrix = readFileSync(LOCAL_MATRIX_PATH, 'utf8');
const matrix = readFileSync(MATRIX_PATH, 'utf8');

function extractFnFrom(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}$`, 'm'));
  expect(match?.[0], `could not extract ${name}() from the shipping gate`).toBeTruthy();
  return match![0];
}

function extractFn(name: string): string {
  return extractFnFrom(gate, name);
}

function extractFederationFn(name: string): string {
  return extractFnFrom(federationAsserts, name);
}

function runPreflight(opts: {
  a?: string;
  b?: string;
  failUser?: string;
  mismatchUser?: string;
  unavailableUser?: string;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fed-attestation-preflight-'));
  const calls = join(dir, 'calls');
  const gh = join(dir, 'gh');
  const npx = join(dir, 'npx');

  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = auth ] && [ "\${2:-}" = token ] && [ "\${3:-}" = --user ]; then
  printf 'tok-%s\\n' "\${4:-}"
  exit 0
fi
if [ "\${1:-}" = api ] && [ "\${2:-}" = user ]; then
  login="\${GH_TOKEN#tok-}"
  if [ "\${UNAVAILABLE_USER:-}" = "$login" ]; then
    printf '{"message":"API rate limit exceeded"}\\n'
    exit 1
  fi
  [ "\${MISMATCH_USER:-}" = "$login" ] && login="wrong-account"
  printf '%s\\n' "$login"
  exit 0
fi
exit 97
`,
  );
  writeFileSync(
    npx,
    `#!/usr/bin/env bash
set -u
printf '%s\\n' "\${PAPERCUSP_ATTEST_LOGIN:-missing}" >>"$CALLS_FILE"
if [ "\${FAIL_USER:-}" = "\${PAPERCUSP_ATTEST_LOGIN:-}" ]; then
  printf '{"user":"%s","ok":false,"code":"email_unverified","status":422,"detail":"POST /gists returned 422","remediation":"https://github.com/settings/emails"}\\n' "$PAPERCUSP_ATTEST_LOGIN"
  exit 1
fi
printf '{"user":"%s","ok":true,"cleanedUp":true}\\n' "$PAPERCUSP_ATTEST_LOGIN"
`,
  );
  chmodSync(gh, 0o755);
  chmodSync(npx, 0o755);

  const script = [
    'set -uo pipefail',
    `DESKTOP_DIR=${JSON.stringify(join(ROOT, 'papercusp-desktop'))}`,
    `P_A_USER=${JSON.stringify(opts.a ?? 'papercupai')}`,
    `P_B_USER=${JSON.stringify(opts.b ?? 'aviynw')}`,
    extractFederationFn('_fed_github_user_with_retry'),
    extractFederationFn('fed_github_login_with_retry'),
    extractFn('preflight_attestation_write_account'),
    extractFn('preflight_attestation_write_accounts'),
    'preflight_attestation_write_accounts',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      CALLS_FILE: calls,
      FAIL_USER: opts.failUser ?? '',
      MISMATCH_USER: opts.mismatchUser ?? '',
      UNAVAILABLE_USER: opts.unavailableUser ?? '',
      ATTESTATION_IDENTITY_RETRY_DELAY_SEC: '0',
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

describe('live-federation gate attestation write preflight', () => {
  it('probes both distinct accounts successfully', () => {
    const result = runPreflight();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toEqual(['papercupai', 'aviynw']);
    expect(result.stdout).toContain('"user":"papercupai","ok":true');
    expect(result.stdout).toContain('"user":"aviynw","ok":true');
  });

  it('keeps probing the second account while returning the exact email wall from the first', () => {
    const result = runPreflight({ failUser: 'papercupai' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(['papercupai', 'aviynw']);
    expect(result.stdout).toContain('"code":"email_unverified"');
    expect(result.stdout).toContain('https://github.com/settings/emails');
  });

  it('refuses a same-account fallback before any write probe (D-030)', () => {
    const result = runPreflight({ a: 'aviynw', b: 'AViYnW' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toContain('code=same_account');
    expect(result.stdout).toContain('D-030-requires-distinct-accounts');
  });

  it('rejects a token that authenticates as a different account', () => {
    const result = runPreflight({ mismatchUser: 'papercupai' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(['aviynw']);
    expect(result.stdout).toContain('code=identity_mismatch');
    expect(result.stdout).toContain('actual=wrong-account');
  });

  it('treats a non-zero identity probe with a JSON error body as unavailable, not as a login', () => {
    const result = runPreflight({ unavailableUser: 'aviynw' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(['papercupai']);
    expect(result.stdout).toContain('user=aviynw code=identity_unavailable');
    expect(result.stdout).not.toContain('code=identity_mismatch actual={');
  });

  it('runs before sidecar build and is not bypassed by GATE_FORCE', () => {
    const call = gate.indexOf('ATTESTATION_PREFLIGHT_OUTPUT="$(preflight_attestation_write_accounts');
    const build = gate.indexOf('# ── 2. fresh artifact:');
    expect(call).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(call);
    expect(gate.slice(call, build)).not.toContain('GATE_FORCE');
  });

  it('keeps the inner content-matrix write probe as defense-in-depth', () => {
    expect(matrix).toContain('probeGistWriteCapability(token)');
    expect(matrix).toContain('preflight_attestation "$P_A_USER" "$A_TOKEN"');
    expect(matrix).toContain('preflight_attestation "$P_B_USER" "$B_TOKEN"');
  });

  it('deduplicates email_unverified against the active owner wall, including needs-human', () => {
    expect(gate).toContain(
      'Fresh-home P2P gate depends on both GitHub accounts being able to create attestation gists',
    );
    expect(gate).toContain('find_open_duplicate "$wall_prefix" active');
    expect(gate).toContain("[ \"$scope\" = active ] && item_filter='\"notTerminal\":true'");
  });
});

function runGithubRestPreflight(opts: { failUser?: string; missingUser?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fed-github-rest-preflight-'));
  const calls = join(dir, 'calls');
  const gh = join(dir, 'gh');
  const curl = join(dir, 'curl');
  const sleep = join(dir, 'sleep');

  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = auth ] && [ "\${2:-}" = token ] && [ "\${3:-}" = --user ]; then
  [ "\${MISSING_USER:-}" = "\${4:-}" ] && exit 1
  printf 'tok-%s\\n' "\${4:-}"
  exit 0
fi
exit 97
`,
  );
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
set -u
header=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -H) header="\${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
token="\${header#Authorization: Bearer }"
user="\${token#tok-}"
printf '%s\\n' "$user" >>"$CALLS_FILE"
if [ "\${FAIL_USER:-}" = "$user" ]; then
  printf '403'
else
  printf '200'
fi
`,
  );
  writeFileSync(sleep, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(gh, 0o755);
  chmodSync(curl, 0o755);
  chmodSync(sleep, 0o755);

  const script = [
    'set -uo pipefail',
    'P_A_USER=papercupai',
    'P_B_USER=aviynw',
    extractFederationFn('preflight_github_rest_accounts'),
    'preflight_github_rest_accounts',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      CALLS_FILE: calls,
      FAIL_USER: opts.failUser ?? '',
      MISSING_USER: opts.missingUser ?? '',
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

describe('live-federation gate GitHub REST preflight', () => {
  it('probes both smoke identities, not only the first account', () => {
    const result = runGithubRestPreflight();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toEqual(['papercupai', 'aviynw']);
    expect(result.stdout).toContain('user=papercupai code=ok http=200');
    expect(result.stdout).toContain('user=aviynw code=ok http=200');
  });

  it('retries a second-account REST wall three times and returns non-zero', () => {
    const result = runGithubRestPreflight({ failUser: 'aviynw' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(['papercupai', 'aviynw', 'aviynw', 'aviynw']);
    expect(result.stdout).toContain('user=aviynw code=unhealthy http=403 attempts=3');
  });

  it('fails closed on a missing token while still probing the other identity', () => {
    const result = runGithubRestPreflight({ missingUser: 'aviynw' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(['papercupai']);
    expect(result.stdout).toContain('user=aviynw code=token_missing detail=no-gh-token');
  });

  it('runs before the build and again after content-matrix but before from-repo', () => {
    const definitions = gate.indexOf('P_A_USER="${P_A_USER:-papercupai}"');
    const firstCall = gate.indexOf('GH_PREFLIGHT_OUTPUT="$(preflight_github_rest_accounts');
    const build = gate.indexOf('# ── 2. fresh artifact:');
    const matrixVerdict = gate.indexOf('log "content-matrix → $MATRIX_RES"');
    const secondCall = gate.indexOf(
      'GH_FROMREPO_PREFLIGHT_OUTPUT="$(preflight_github_rest_accounts',
    );
    const fromRepo = gate.indexOf('FROMREPO_RES="$(run_smoke from-repo');
    expect(definitions).toBeGreaterThan(-1);
    expect(firstCall).toBeGreaterThan(definitions);
    expect(build).toBeGreaterThan(firstCall);
    expect(secondCall).toBeGreaterThan(matrixVerdict);
    expect(fromRepo).toBeGreaterThan(secondCall);
  });

  it('makes a late wall explicitly partial while preserving the force override', () => {
    const start = gate.indexOf(
      'GH_FROMREPO_PREFLIGHT_OUTPUT="$(preflight_github_rest_accounts',
    );
    const end = gate.indexOf('FROMREPO_RES="$(run_smoke from-repo');
    const lateBoundary = gate.slice(start, end);
    expect(lateBoundary).toContain('FROMREPO_RES="SKIPPED-GITHUB-API"');
    expect(lateBoundary).toContain('WITNESS_RES="SKIPPED-GITHUB-API"');
    expect(lateBoundary).toContain('check_staleness');
    expect(lateBoundary).toContain('GATE: PARTIAL (github-api-unhealthy-before-from-repo)');
    expect(lateBoundary).toContain('GATE_FORCE=1 — proceeding anyway');
  });
});

/**
 * WI-39359 / WI-40008 — the credential wall must not blind coverage that can
 * still authenticate, and must not launch a vacuous matrix when identity auth
 * itself is unavailable.
 *
 * Measured 2026-08-16: local-matrix.sh does not need attestation GIST WRITES, while the
 * content-matrix and from-repo smokes do. WI-40008 tightened the boundary after a later live
 * run proved that local-matrix still needs each token to authenticate as its requested GitHub
 * identity: a write-only wall may preserve the leg, but an identity/auth wall cannot.
 *
 * The rule these pin: run what CAN be run, name what CANNOT, and never call the result green.
 */
function runDuePredicate(opts: {
  runLocalMatrix?: string;
  wrapperPresent?: boolean;
  matrixGreenAgeH?: number;
  ttlH?: string;
}): number {
  const dir = mkdtempSync(join(tmpdir(), 'fed-local-matrix-due-'));
  const stateDir = join(dir, 'state');
  const desktopDir = join(dir, 'papercusp-desktop');
  const binDir = join(desktopDir, 'bin');
  spawnSync('mkdir', ['-p', stateDir, binDir]);
  if (opts.wrapperPresent !== false) writeFileSync(join(binDir, 'local-matrix.sh'), '#!/bin/bash\n');
  // age_h() reads an epoch-seconds stamp; a MISSING file is 999999h (never green => due).
  if (opts.matrixGreenAgeH !== undefined) {
    const stamp = Math.floor(Date.now() / 1000) - opts.matrixGreenAgeH * 3600;
    writeFileSync(join(stateDir, 'last-matrix-green'), `${stamp}\n`);
  }
  const script = [
    'set -uo pipefail',
    'now_s() { date +%s; }',
    extractFn('age_h'),
    `STATE_DIR=${JSON.stringify(stateDir)}`,
    `DESKTOP_DIR=${JSON.stringify(desktopDir)}`,
    extractFn('local_matrix_due'),
    'local_matrix_due',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      RUN_LOCAL_MATRIX: opts.runLocalMatrix ?? '1',
      ...(opts.ttlH ? { MATRIX_TTL_H: opts.ttlH } : {}),
    },
  });
  return result.status ?? -1;
}

describe('live-federation gate: credential walls preserve only executable coverage', () => {
  it('reports the local-matrix leg DUE when it has never gone green', () => {
    // The real state on 2026-08-16: last-matrix-green predated the TTL by weeks.
    expect(runDuePredicate({})).toBe(0);
  });

  it('reports NOT due inside the cadence window, preserving the cheap early exit', () => {
    // This is the cost control: the preflight exists to avoid a multi-GB build, and every
    // window where the independent leg would not have run anyway must still exit early.
    expect(runDuePredicate({ matrixGreenAgeH: 1, ttlH: '144' })).toBe(1);
  });

  it('reports NOT due when the leg is disabled or its wrapper is absent', () => {
    expect(runDuePredicate({ runLocalMatrix: '0' })).toBe(1);
    expect(runDuePredicate({ wrapperPresent: false })).toBe(1);
  });

  it('only exits early when the independent leg would not have run', () => {
    // The defect being pinned is an UNCONDITIONAL `exit 1` here, which is what voided the runs.
    expect(gate).toContain('if [ "$ATTESTATION_BLOCKED" != 1 ]; then');
    const guard = gate.indexOf('if [ "$ATTESTATION_BLOCKED" != 1 ]; then');
    const build = gate.indexOf('# ── 2. fresh artifact:');
    expect(guard).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(guard);
  });

  it('names the blocked legs with a token that can never read as a pass', () => {
    // is_skip_result() matches SKIPPED* — so the wall token is counted as "nothing proven",
    // never folded into a green. A token not starting with SKIPPED would silently break that.
    expect(gate).toContain('ATTESTATION_WALL_TOKEN="SKIPPED-ATTESTATION-WALL"');
    expect('SKIPPED-ATTESTATION-WALL'.startsWith('SKIPPED')).toBe(true);
    expect(gate).toContain('MATRIX_RES="${ATTESTATION_WALL_TOKEN:-SKIPPED}"');
    expect(gate).toContain('FROMREPO_RES="${ATTESTATION_WALL_TOKEN:-SKIPPED}"');
    expect(gate).toContain('WITNESS_RES="${ATTESTATION_WALL_TOKEN:-SKIPPED}"');
  });

  it('lets the independent leg past the content-matrix coupling ONLY on the credential wall', () => {
    // Must be a guard on the existing condition, not its own elif branch: a branch that merely
    // logged would match and fall out of the chain WITHOUT running the matrix — the silent
    // no-coverage outcome this change exists to end. A genuine content RED still declines.
    expect(gate).toContain(
      'elif [ "${ATTESTATION_BLOCKED:-0}" != 1 ] && ! { [ "$MATRIX_RES" = PASS ] || [ "$MATRIX_RES" = PASS-971 ]; }; then',
    );
  });

  it('refuses the local matrix when the failed preflight is an identity/authentication wall', () => {
    expect(gate).toContain('ATTESTATION_IDENTITY_BLOCKED=0');
    expect(gate).toContain(
      "grep -qE 'code=(token_missing|identity_unavailable|identity_mismatch|same_account)([[:space:]]|$)'",
    );
    expect(gate).toContain(
      'if local_matrix_due && [ "$ATTESTATION_IDENTITY_BLOCKED" != 1 ]; then',
    );
    expect(gate).toContain('local-matrix cannot admit joiners; refusing a vacuous, expensive run');
  });

  it('can NEVER stamp a green while attestation-dependent legs went unexercised (D-018)', () => {
    // The single most important invariant here. A green in this state asserts coverage nobody
    // produced. The guard must precede the last-green write, not merely exist somewhere.
    const guard = gate.indexOf('if [ "${ATTESTATION_BLOCKED:-0}" = 1 ]; then\n    check_matrix_staleness');
    const green = gate.indexOf('echo "$(now_s)" >"$STATE_DIR/last-green"');
    expect(guard).toBeGreaterThan(-1);
    expect(green).toBeGreaterThan(guard);
    expect(gate).toContain('GATE: PARTIAL (attestation-blocked)');
  });
});

function runLocalMatrixHostPreflight(opts: {
  mismatchUser?: string;
  unavailableUser?: string;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fed-local-matrix-host-preflight-'));
  const desktopDir = join(dir, 'papercusp-desktop');
  const node = join(desktopDir, 'src-tauri', 'sidecar', 'bin', 'node');
  const deb = join(dir, 'Papercusp.deb');
  const gh = join(dir, 'gh');
  spawnSync('mkdir', ['-p', dirname(node)]);
  writeFileSync(node, '#!/usr/bin/env bash\\nexit 0\\n');
  chmodSync(node, 0o755);
  writeFileSync(deb, 'test-deb');
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = auth ] && [ "\${2:-}" = token ] && [ "\${3:-}" = --user ]; then
  printf 'tok-%s\\n' "\${4:-}"
  exit 0
fi
if [ "\${1:-}" = api ] && [ "\${2:-}" = user ]; then
  login="\${GH_TOKEN#tok-}"
  if [ "\${UNAVAILABLE_USER:-}" = "$login" ]; then
    printf '{"message":"API rate limit exceeded"}\\n'
    exit 1
  fi
  [ "\${MISMATCH_USER:-}" = "$login" ] && login="wrong-account"
  printf '%s\\n' "$login"
  exit 0
fi
exit 97
`,
  );
  chmodSync(gh, 0o755);

  const script = [
    'set -uo pipefail',
    `DESKTOP_DIR=${JSON.stringify(desktopDir)}`,
    `DEB=${JSON.stringify(deb)}`,
    `STATE_FILE=${JSON.stringify(join(dir, 'state'))}`,
    'REUSE=0',
    'NET=test-rig',
    'FRAMES=2',
    'P_A_USER=papercupai',
    'P_B_USER=aviynw',
    'log() { printf "%s\\n" "$*"; }',
    extractFnFrom(localMatrix, 'preflight_host_preconditions'),
    'preflight_host_preconditions',
  ].join('\n');
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      MISMATCH_USER: opts.mismatchUser ?? '',
      UNAVAILABLE_USER: opts.unavailableUser ?? '',
    },
  });
}

describe('local-matrix host preflight authenticates every frame identity before provisioning', () => {
  it('accepts two usable tokens that resolve to their requested accounts', () => {
    const result = runLocalMatrixHostPreflight();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('authenticated gh identities');
  });

  it('fails before provisioning when a token cannot resolve identity', () => {
    const result = runLocalMatrixHostPreflight({ unavailableUser: 'aviynw' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gh token for 'aviynw' cannot authenticate GitHub GET /user");
  });

  it('fails before provisioning when a requested token authenticates as another account', () => {
    const result = runLocalMatrixHostPreflight({ mismatchUser: 'aviynw' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gh token requested for 'aviynw' authenticates as 'wrong-account'");
  });
});
