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
const GATE_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const MATRIX_PATH = join(
  ROOT,
  'papercusp-desktop',
  'bin',
  'two-instance-content-matrix-smoke.sh',
);
const gate = readFileSync(GATE_PATH, 'utf8');
const matrix = readFileSync(MATRIX_PATH, 'utf8');

function extractFn(name: string): string {
  const match = gate.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}$`, 'm'));
  expect(match?.[0], `could not extract ${name}() from the shipping gate`).toBeTruthy();
  return match![0];
}

function runPreflight(opts: {
  a?: string;
  b?: string;
  failUser?: string;
  mismatchUser?: string;
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
