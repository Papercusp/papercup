/**
 * Recurrence guard for WI-6554700010048115: a host rebuild must not fail back to a stale
 * last-known-good bundle just because the testing-core witness helper has no committed version.
 *
 * The papercusp-bg-host ExecStartPre snapshots the WORKING-TREE bundle scripts, but every node
 * helper they run goes through COMMITTED_NODE, which refuses a file with no committed version.
 * While git-sync was frozen, `scripts/lib/testing-core-witness.mjs` stayed untracked, so the
 * host-testing-core step failed on every rebuild and bg-host kept serving a days-old bundle.
 * `bundle_host_prepare_testing_core` now degrades: with no committed helper it compiles the
 * worker UNWITNESSED (warns, never calls the helper) and the verify step skips with a warning.
 *
 * These tests run the real shell functions, sliced out of bundle-host-common.sh, against a
 * throwaway git repository with a stubbed esbuild and a stubbed committed-node runner. They pin
 * both branches: the degrade path (helper absent from HEAD) and the witnessed path (helper
 * committed), so neither can silently regress into the other.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMMON_SCRIPT = join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');
const HELPER = 'scripts/lib/testing-core-witness.mjs';
const WARN_TAG = 'WARN(WI-6554700010048115)';

/** The testing-core prepare/verify functions plus the constant they compare against. */
function testingCoreSlice(): string {
  const source = readFileSync(COMMON_SCRIPT, 'utf8');
  const start = source.indexOf("BUNDLE_HOST_TESTING_CORE_UNWITNESSED='");
  const end = source.indexOf('bundle_host_select_profile() {');
  expect(start, 'BUNDLE_HOST_TESTING_CORE_UNWITNESSED must exist in bundle-host-common.sh').toBeGreaterThan(-1);
  expect(end, 'bundle_host_select_profile must follow the testing-core functions').toBeGreaterThan(start);
  const slice = source.slice(start, end);
  expect(slice).toContain('bundle_host_prepare_testing_core() {');
  expect(slice).toContain('bundle_host_verify_testing_core() {');
  return slice;
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0);
}

interface Fixture { repo: string; out: string; log: string; stub: string }

/** A throwaway repo whose HEAD does (or does not) contain the witness helper. */
function fixture(helper: 'committed' | 'untracked'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'bundle-host-testing-core-'));
  scratch.push(root);
  const repo = join(root, 'repo');
  const out = join(root, 'out');
  mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
  mkdirSync(out);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'README'), 'fixture\n');
  git(repo, 'add', 'README');
  git(repo, 'commit', '-qm', 'base');
  writeFileSync(join(repo, HELPER), '// witness helper fixture\n');
  if (helper === 'committed') {
    git(repo, 'add', HELPER);
    git(repo, 'commit', '-qm', 'helper');
  }
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  // Stands in for COMMITTED_NODE: records every helper invocation and answers like the helper.
  const stub = join(root, 'committed-node');
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    'printf "helper %s\\n" "$*" >> "$LOG"',
    'if [[ "$2" == define ]]; then printf "%s" "--define:__PAPERCUSP_TESTING_CORE_WITNESS__=\\"witnessed\\""; fi',
    'exit "${HELPER_EXIT:-0}"',
    '',
  ].join('\n'));
  chmodSync(stub, 0o755);
  return { repo, out, log, stub };
}

interface Run { status: number | null; stdout: string; stderr: string; calls: string[]; vars: Record<string, string> }

function run(fx: Fixture, extraEnv: Record<string, string> = {}, prepareTwice = false): Run {
  const harness = [
    'set -euo pipefail',
    'HOST_COMMON_EXTERNALS=(--external:common)',
    'NATIVE_PKGS=(native-pkg)',
    "HOST_BANNER='/* banner */'",
    'HOST_BANNER_DEFINES=(--define:__banner=1)',
    // Stub esbuild: logs its receipt env + outfile; prints a binding only when asked to witness.
    'bundle_host_esbuild() {',
    '  printf "esbuild receipt=%s args=%s\\n" "${BUNDLE_HOST_TESTING_CORE_PREPARE_RECEIPT:-}" "$*" >> "$LOG"',
    '  [[ -z "${ESBUILD_EXIT:-}" ]] || return "$ESBUILD_EXIT"',
    '  if [[ -n "${BUNDLE_HOST_TESTING_CORE_PREPARE_RECEIPT:-}" ]]; then printf "sha256:fixture-binding"; fi',
    '}',
    'COMMITTED_NODE=("$STUB")',
    testingCoreSlice(),
    'prepare() { if bundle_host_prepare_testing_core "$REPO" "$OUT" --external:parent; then echo "PREPARE_RC=0"; else echo "PREPARE_RC=$?"; exit 0; fi; }',
    'prepare',
    ...(prepareTwice ? ['prepare'] : []),
    'printf "DEFINE=%s\\nBINDING=%s\\nRECEIPT=%s\\n" "$BUNDLE_HOST_TESTING_CORE_WITNESS_DEFINE" "$BUNDLE_HOST_TESTING_CORE_BINDING" "$BUNDLE_HOST_TESTING_CORE_RECEIPT"',
    'if bundle_host_verify_testing_core "$REPO"; then echo "VERIFY_RC=0"; else echo "VERIFY_RC=$?"; fi',
  ].join('\n');
  const result = spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    // A minimal env: an inherited BUNDLE_HOST_TESTING_CORE_* would take the reuse branch.
    env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? tmpdir(),
      LOG: fx.log, STUB: fx.stub, REPO: fx.repo, OUT: fx.out, ...extraEnv },
  });
  const vars: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  const calls = readFileSync(fx.log, 'utf8').split('\n').filter(Boolean);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, vars };
}

describe('WI-6554700010048115 — host testing-core step without a committed witness helper', () => {
  it('degrades to an UNWITNESSED worker build instead of failing the host rebuild', () => {
    const fx = fixture('untracked');
    const r = run(fx);
    expect(r.status, r.stderr).toBe(0);
    expect(r.vars.PREPARE_RC).toBe('0');
    expect(r.stderr).toContain(`${WARN_TAG}: ${HELPER} has no committed version`);
    expect(r.vars.DEFINE).toBe('--define:__PAPERCUSP_TESTING_CORE_WITNESS__=undefined');
    expect(r.vars.BINDING).toBe('unwitnessed:helper-not-committed');
    expect(r.vars.RECEIPT).toBe(join(fx.out, 'testing-core.worker.witness.json'));
    // The worker is still compiled, but never asked to produce a witness receipt…
    const esbuild = r.calls.filter(c => c.startsWith('esbuild '));
    expect(esbuild).toHaveLength(1);
    expect(esbuild[0]).toContain('esbuild receipt= args=');
    expect(esbuild[0]).toContain(`--outfile=${join(fx.out, 'testing-core.worker.mjs')}`);
    // …and the refused helper is never run.
    expect(r.calls.filter(c => c.startsWith('helper '))).toEqual([]);
    // Verify skips with a warning rather than refusing (78) or running the helper.
    expect(r.vars.VERIFY_RC).toBe('0');
    expect(r.stderr).toContain(`${WARN_TAG}: testing-core witness verification skipped`);
  });

  it('a second prepare in the same build reuses the unwitnessed binding without failing', () => {
    const fx = fixture('untracked');
    const r = run(fx, {}, true);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.match(/^PREPARE_RC=0$/gm)).toHaveLength(2);
    expect(r.calls.filter(c => c.startsWith('esbuild '))).toHaveLength(1);
    expect(r.calls.filter(c => c.startsWith('helper '))).toEqual([]);
  });

  it('still fails the step when the unwitnessed worker compile itself fails', () => {
    const fx = fixture('untracked');
    const r = run(fx, { ESBUILD_EXIT: '3' });
    expect(r.vars.PREPARE_RC).toBe('1');
    expect(r.calls.filter(c => c.startsWith('helper '))).toEqual([]);
  });

  it('uses the witness helper once it is committed (the degrade path stays dormant)', () => {
    const fx = fixture('committed');
    const r = run(fx);
    expect(r.status, r.stderr).toBe(0);
    expect(r.vars.PREPARE_RC).toBe('0');
    expect(r.stderr).not.toContain(WARN_TAG);
    const receipt = join(fx.out, 'testing-core.worker.witness.json');
    expect(r.calls.filter(c => c.startsWith('esbuild '))[0]).toContain(`esbuild receipt=${receipt} args=`);
    expect(r.vars.BINDING).toBe('sha256:fixture-binding');
    expect(r.vars.DEFINE).toBe('--define:__PAPERCUSP_TESTING_CORE_WITNESS__="witnessed"');
    const helperCalls = r.calls.filter(c => c.startsWith('helper '));
    expect(helperCalls).toEqual([
      `helper ${join(fx.repo, HELPER)} define ${receipt} sha256:fixture-binding`,
      `helper ${join(fx.repo, HELPER)} verify ${receipt} sha256:fixture-binding`,
    ]);
    expect(r.vars.VERIFY_RC).toBe('0');
  });

  it('a committed helper that refuses still fails prepare (no silent fallback to unwitnessed)', () => {
    const fx = fixture('committed');
    const r = run(fx, { HELPER_EXIT: '9' });
    expect(r.vars.PREPARE_RC).toBe('1');
    expect(r.stderr).not.toContain(WARN_TAG);
  });
});
