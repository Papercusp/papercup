/**
 * The INSTALLER gate must fail closed — pinned from Vitest, because the gate is Python.
 *
 * `papercusp-desktop/bin/audit-release-bundle.py` is the sibling of gate-release-site.ts:
 * same job, for the bundle that ships to users. It had the same defect (EI-20583328178472869)
 * and a worse blast radius — a leaked site is a page, a leaked installer is on disks.
 *
 * WHY THIS FILE IS TYPESCRIPT. Repo rule P-038: every new test goes in exactly one of the
 * four canonical frameworks, and a new .py/.mjs harness fails CI lint. So the falsifier lives
 * in Vitest and shells out. Precedent for pinning a non-TS invariant this way:
 * packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts.
 *
 * WHAT IT PINS, and why the third case is the one that matters:
 *   2 = CANNOT CHECK   (no owner-name literal resolved — the bug's exact shape)
 *   0 = VERIFIED CLEAN (equipped, and found nothing)
 *   1 = FOUND LEAKS    (equipped, and still able to FAIL)
 * Without that last case, a gate that simply refused everything would satisfy the first two
 * and look more rigorous than the real thing. A guard that cannot pass is as useless as one
 * that cannot fail; both must be proven.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { OWNER_NAME_ENV } from './release-content-scrub';

/** Walk up to the repo root — robust to this file being moved between lib dirs. */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'papercusp-desktop', 'bin'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate repo root from the test file');
}

const AUDIT = path.join(repoRoot(), 'papercusp-desktop', 'bin', 'audit-release-bundle.py');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fixture(name: string, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-`));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, 'utf8');
  }
  return dir;
}

/**
 * A SYNTHETIC build-box home path. identity_literals() resolves build-home-path from
 * os.path.expanduser("~"), i.e. $HOME, so pinning HOME makes the canary deterministic
 * without writing any real box's identity into source (lint:no-identity-literals).
 * Derived under the per-run tmp dir so no home-path literal appears in source.
 */
const SYNTHETIC_HOME = path.join(tmp, 'synthetic-release-canary-home');

/** Run the audit's --scan-dir mode and return only its exit code. */
function scanDir(dir: string, ownerName?: string): number {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: SYNTHETIC_HOME };
  // Deleting rather than blanking: the gate treats a blank as absent, and we want the
  // "genuinely unset" path that a real build box hits.
  delete env[OWNER_NAME_ENV];
  if (ownerName !== undefined) env[OWNER_NAME_ENV] = ownerName;
  const r = spawnSync('python3', [AUDIT, '--scan-dir', dir], { env, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r.status ?? -1;
}

/** Exercise phase B without constructing a multi-gigabyte release tarball. */
function phaseBCredentialFindings(value: string): unknown[] {
  const source = [
    'import json, os, runpy, sys',
    'ns = runpy.run_path(sys.argv[1])',
    'phase = ns["phase_b_content"]',
    'class Result:',
    '    stdout = "1 " + os.environ["PAPERCUSP_TEST_CREDENTIAL_VALUE"] + "\\n"',
    'phase.__globals__["sh"] = lambda _cmd: Result()',
    'print(json.dumps(phase("unused.tar.zst", {})))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', source, AUDIT], {
    env: { ...process.env, PAPERCUSP_TEST_CREDENTIAL_VALUE: value },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown[];
}

// A stand-in owner — NEVER the real one. Putting his name in a source file to test for it
// would be the very leak this gate exists to stop, committed to git forever. Same rule the
// sibling suite states in release-content-scrub.test.ts.
const STANDIN_OWNER = 'Jane';

describe('audit-release-bundle.py --scan-dir — the installer backstop must fail closed', () => {
  it('the gate script actually exists (a guard pointed at nothing passes forever)', () => {
    // Deliberately an assertion, not a skip. A silently-skipped guard is precisely the
    // failure class this whole item is about: absent and clean must not look identical.
    expect(fs.existsSync(AUDIT)).toBe(true);
  });

  it('exits 2 (CANNOT CHECK) when the scan target does not exist', () => {
    // A gate pointed at a missing path reads nothing; it must not report CLEAN.
    expect(scanDir(path.join(tmp, 'does-not-exist'))).toBe(2);
  });

  it('exits 0 (VERIFIED CLEAN) on a clean tree with no owner literal supplied (D-112)', () => {
    // p2p-public-release-endgame-2026-09-01#D-112 [owner 2026-10-01]: the release
    // identity policy is machine-only, so an unset owner name is no longer CANNOT CHECK.
    const clean = fixture('clean', { 'index.html': '<h1>Papercusp releases</h1>' });
    expect(scanDir(clean)).toBe(0);
  });

  it('exits 1 (FOUND LEAKS) on a build-box home-path canary — proving it can still FAIL', () => {
    // THE CALIBRATION CONTROL. An always-pass gate would satisfy the clean case above.
    const canary = fixture('canary', { 'notes.txt': `built in ${SYNTHETIC_HOME}/src/papercusp` });
    expect(scanDir(canary)).toBe(1);
  });

  it('does NOT treat owner authorship as a leak (D-112)', () => {
    // Owner name in shipped content is legitimate under D-112, even when the legacy env
    // var is set by an older producer script.
    const authored = fixture('authored', { 'notes.txt': `authored by ${STANDIN_OWNER}` });
    expect(scanDir(authored, STANDIN_OWNER)).toBe(0);
  });

  it('keeps CANNOT-CHECK and FOUND-LEAKS on distinct exit codes', () => {
    // A caller's `|| fail` cannot tell a blind gate from a leaking one if these collide.
    const canary = fixture('canary', { 'notes.txt': `built in ${SYNTHETIC_HOME}/src/papercusp` });
    expect(scanDir(path.join(tmp, 'does-not-exist'))).not.toBe(scanDir(canary));
  });
});

describe('audit-release-bundle.py release false-positive controls', () => {
  it('prints a tar exclude for verdict-cli per-session runtime state', () => {
    const result = spawnSync('python3', [AUDIT, '--tar-excludes'], { encoding: 'utf8' });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/(?:^|\n)(?:\.\/|\*\/)?\.verdict-data(?:\n|$)/);
  });

  it('accepts only the two exact gh 2.80 string-table values by SHA-256', () => {
    // Keep credential-shaped third-party bytes out of source. These code points
    // reconstruct the two measured public gh binary strings only in test memory;
    // the production allowlist stores their SHA-256 identities exclusively.
    const values = [
      [103, 104, 111, 95, 98, 114, 101, 119, 80, 65, 84, 72, 78, 111, 110, 101, 97, 108, 108, 103, 97, 108, 108, 112, 114, 111, 111, 116, 105, 116, 97, 98, 115, 98, 114, 107, 105, 100, 108, 101, 100, 101, 97, 100, 114, 97, 99, 101, 108, 111, 103, 115],
      [103, 104, 114, 95, 83, 73, 90, 69, 111, 114, 103, 115, 112, 111, 110, 100, 104, 105, 108, 108, 115, 104, 111, 101, 98, 111, 111, 107, 108, 97, 107, 101, 110, 101, 97, 116, 105, 110, 102, 111],
    ].map((codePoints) => String.fromCharCode(...codePoints));

    for (const value of values) {
      expect(phaseBCredentialFindings(value)).toEqual([]);
      const changed = `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
      expect(phaseBCredentialFindings(changed)).toEqual([
        ['github-token', 1, changed],
      ]);
    }
  });

  it('prunes Papercusp state directories from every assembled docs tree', () => {
    const docs = fixture('docs-prune', {
      '.papercusp/private.json': 'workspace state',
      'nested/.papercusp-workspaces/private.json': 'workspace state',
      'nested/guide.html': '<h1>keep me</h1>',
    });
    const result = spawnSync('python3', [AUDIT, '--prune-docs', docs], { encoding: 'utf8' });
    if (result.error) throw result.error;

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(docs, '.papercusp'))).toBe(false);
    expect(fs.existsSync(path.join(docs, 'nested/.papercusp-workspaces'))).toBe(false);
    expect(fs.readFileSync(path.join(docs, 'nested/guide.html'), 'utf8')).toBe('<h1>keep me</h1>');
  });
});

describe('audit-release-bundle.py — the identity policy is machine-only (D-112)', () => {
  // p2p-public-release-endgame-2026-09-01#D-112 [owner 2026-10-01] removed the
  // owner-name/email literals from the release identity gate. Pin that the build-box
  // literal set carries no owner/git-identity key and the legacy preflight stays a no-op,
  // so a later edit cannot silently re-arm the removed policy.
  function probe(): { keys: string[]; preflight: number } {
    const source = [
      'import contextlib, io, json, runpy, sys',
      'ns = runpy.run_path(sys.argv[1])',
      'with contextlib.redirect_stdout(io.StringIO()):',
      '    rc = ns["owner_preflight"]()',
      'print(json.dumps({"keys": sorted(ns["identity_literals"]().keys()), "preflight": rc}))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', source, AUDIT], {
      env: { ...process.env, HOME: SYNTHETIC_HOME },
      encoding: 'utf8',
    });
    if (r.error) throw r.error;
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as { keys: string[]; preflight: number };
  }

  it('resolves only build-box keys — no build-git-name / build-git-email', () => {
    const { keys } = probe();
    expect(keys).toContain('build-home-path'); // calibration: the probe really resolved literals
    expect(keys.filter((k) => k.startsWith('build-git-'))).toEqual([]);
  });

  it('owner_preflight succeeds without any owner literal', () => {
    expect(probe().preflight).toBe(0);
  });
});
