/**
 * Recurrence guard for EI-21974634479405756.
 *
 * Assertion commands run only after the verifier has built and booted a Tauri
 * instance. A malformed tauri-agent-tools invocation must be rejected before
 * that expensive boundary, with no tool or cargo process started.
 */
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(ROOT, 'scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

function runAssertion(assertionSource: string, useBashC = false) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-assertion-preflight.'));
  const assertion = join(dir, 'assertion.sh');
  const tool = join(dir, 'tauri-agent-tools');
  const cargo = join(dir, 'cargo');
  const invocations = join(dir, 'invocations');
  writeFileSync(assertion, assertionSource);
  writeFileSync(invocations, '');
  writeFileSync(
    tool,
    '#!/usr/bin/env bash\nprintf "tool invoked\\n" >> "$VERIFY_TEST_INVOCATIONS"\nexit 0\n',
  );
  writeFileSync(
    cargo,
    '#!/usr/bin/env bash\nprintf "cargo invoked\\n" >> "$VERIFY_TEST_INVOCATIONS"\nexit 0\n',
  );
  chmodSync(tool, 0o755);
  chmodSync(cargo, 0o755);

  const args = useBashC ? ['bash', '-c', assertionSource] : [assertion];
  const result = spawnSync('bash', [SCRIPT, '--', ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      PAPERCUSP_REPO_DIR: ROOT,
      PAPERCUSP_SID: 'test-assertion-preflight',
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: '',
      TMPDIR: dir,
      VERIFY_TEST_INVOCATIONS: invocations,
      VERIFY_TAURI_AGENT_TOOLS_BIN: tool,
      VERIFY_TAURI_CARGO_BIN: cargo,
    },
    encoding: 'utf8',
  });

  return { dir, invocations, result };
}

function runAssertionPreflightOnly(assertionSource: string) {
  const start = src.indexOf('validate_assertion_command_preflight() {');
  const end = src.indexOf('\n\nvalidate_assertion_command_preflight || exit $?', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  return spawnSync('bash', ['-c', [
    src.slice(start, end),
    'ASSERTION_MODE=1',
    'ASSERTION_ARGS=(bash -c "$VERIFY_TEST_ASSERTION_SOURCE")',
    'validate_assertion_command_preflight',
  ].join('\n')], {
    env: { ...process.env, VERIFY_TEST_ASSERTION_SOURCE: assertionSource },
    encoding: 'utf8',
  });
}

function runManifestPreflight(actual: string, claimed: string, claimedRoot?: string, heredocLines: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-env-manifest.'));
  const assertion = join(dir, 'assertion.sh');
  const manifest = join(dir, 'manifest.json');
  const source = [
    '#!/usr/bin/env bash',
    `# VERIFY_TAURI_ASSERTION_ENV_MANIFEST=${manifest}`,
    `D=${dir}`,
    'export GST_DEBUG_FILE="$D/' + actual + '"',
    ...heredocLines,
    '',
  ].join('\n');
  writeFileSync(assertion, source);
  writeFileSync(manifest, JSON.stringify({
    assertionSha256: createHash('sha256').update(source).digest('hex'),
    diagnosticEnv: { GST_DEBUG_FILE: join(dir, claimed) },
    diagnosticLogRoot: claimedRoot ?? join(dir, 'current'),
  }));
  const start = src.indexOf('validate_assertion_command_preflight() {');
  const end = src.indexOf('\n\nvalidate_assertion_command_preflight || exit $?', start);
  const result = spawnSync('bash', ['-c', [
    src.slice(start, end),
    'ASSERTION_MODE=1',
    'ASSERTION_ARGS=(bash "$VERIFY_TEST_ASSERTION_PATH")',
    'validate_assertion_command_preflight',
  ].join('\n')], {
    env: {
      ...process.env,
      REPO_DIR: ROOT,
      VERIFY_TEST_ASSERTION_PATH: assertion,
    },
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe('EI-21974634479405756 — assertion command preflight', () => {
  it('runs before workdir/resource allocation and checks shell syntax', () => {
    const preflight = src.indexOf('validate_assertion_command_preflight || exit $?');
    const work = src.indexOf('WORK="$(mktemp -d');

    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(work);
    expect(src).toContain('bash -n -- "$source_path"');
    expect(src).toContain('tauri-agent-tools --pid/--port must follow its subcommand');
  });

  it('rejects a malformed file-backed CLI invocation without starting cargo or the tool', () => {
    const { dir, invocations, result } = runAssertion(
      '#!/usr/bin/env bash\nset -e\ntauri-agent-tools --port "$P" eval true\n',
    );

    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('VERIFY_TAURI_ASSERTION_INVALID');
      expect(result.stderr).toContain(
        'tauri-agent-tools --pid/--port must follow its subcommand',
      );
      expect(result.stderr).toContain('offending command');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(
        readdirSync(dir).filter((entry) => entry.startsWith('verify-tauri-headless.')),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects the same option-order mistake in an inline bash -c assertion', () => {
    const { dir, invocations, result } = runAssertion(
      'tauri-agent-tools --pid "$P" check --selector body',
      true,
    );

    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('VERIFY_TAURI_ASSERTION_INVALID');
      expect(result.stderr).toContain('must follow its subcommand');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(
        readdirSync(dir).filter((entry) => entry.startsWith('verify-tauri-headless.')),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unqualified bridge probe before starting the verifier', () => {
    const { dir, invocations, result } = runAssertion('tauri-agent-tools probe', true);

    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('must pin --pid to "$VERIFY_TAURI_PID"');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(
        readdirSync(dir).filter((entry) => entry.startsWith('verify-tauri-headless.')),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not accept a caller-supplied PID that could select a different bridge', () => {
    const result = runAssertionPreflightOnly('tauri-agent-tools probe --pid "$OTHER_PID"');
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('must pin --pid to "$VERIFY_TAURI_PID"');
  });

  it('accepts the verifier-owned PID as a negative control', () => {
    const result = runAssertionPreflightOnly(
      'tauri-agent-tools probe --pid "$VERIFY_TAURI_PID"',
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts executable and PID aliases derived from verifier-owned values', () => {
    const result = runAssertionPreflightOnly([
      'TOOL="$VERIFY_TAURI_AGENT_TOOLS_BIN"',
      'PID="$VERIFY_TAURI_PID"',
      '"$TOOL" probe --pid "$PID"',
    ].join('\n'));
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects invalid shell syntax before any verifier dependency is executed', () => {
    const { dir, invocations, result } = runAssertion(
      '#!/usr/bin/env bash\nif then\n  echo never\nfi\n',
    );

    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('VERIFY_TAURI_ASSERTION_INVALID');
      expect(result.stderr).toContain('invalid shell syntax');
      expect(readFileSync(invocations, 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WI-10002829 — assertion environment manifest preflight', () => {
  it('rejects an assertion copied from an older diagnostic before verifier preparation', () => {
    const result = runManifestPreflight('old/gst.%p.log', 'current/gst.%p.log');
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('GST_DEBUG_FILE differs from manifest diagnosticEnv');
    expect(src.indexOf('validate_assertion_command_preflight || exit $?'))
      .toBeLessThan(src.indexOf('shared_schema_readiness_preflight || exit $?'));
    expect(src.indexOf('validate_assertion_command_preflight || exit $?'))
      .toBeLessThan(src.indexOf('WORK="$(mktemp -d'));
    expect(src).toContain('sha256sum -- "$ASSERTION_ENV_MANIFEST_PATH" >> "$ASSERTION_INPUT_MANIFEST"');
  });

  it('rejects an internally inconsistent manifest even when the export agrees', () => {
    const result = runManifestPreflight('current/gst.%p.log', 'current/gst.%p.log', '/dev/shm/other');
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('GST_DEBUG_FILE parent differs from manifest diagnosticLogRoot');
  });

  it('accepts a matching immutable assertion and manifest', () => {
    const result = runManifestPreflight('current/gst.%p.log', 'current/gst.%p.log');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('VERIFY_TAURI_ASSERTION_ENV_OK 1 binding(s)');
  });

  it('ignores Python assignments inside a quoted heredoc', () => {
    const result = runManifestPreflight(
      'current/gst.%p.log',
      'current/gst.%p.log',
      undefined,
      ["python3 - <<'PY'", "D=Path('not a shell assignment')", 'PY'],
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('VERIFY_TAURI_ASSERTION_ENV_OK 1 binding(s)');
  });

  it('does not let a heredoc spoof a manifest export', () => {
    const result = runManifestPreflight(
      'old/gst.%p.log',
      'current/gst.%p.log',
      undefined,
      ["python3 - <<'PY'", 'export GST_DEBUG_FILE="$D/current/gst.%p.log"', 'PY'],
    );
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('GST_DEBUG_FILE differs from manifest diagnosticEnv');
  });
});
