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

/** Run the audit's --scan-dir mode and return only its exit code. */
function scanDir(dir: string, ownerName?: string): number {
  const env = { ...process.env };
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

  it('exits 2 (CANNOT CHECK) when no owner-name literal resolves', () => {
    // The bug's exact shape: git user.name became an automation identity, so the owner's
    // name silently left the query set while the scan still read every byte.
    const clean = fixture('clean', { 'index.html': '<h1>Papercusp releases</h1>' });
    expect(scanDir(clean)).toBe(2);
  });

  it('exits 0 (VERIFIED CLEAN) on a clean tree once an owner name IS supplied', () => {
    const clean = fixture('clean', { 'index.html': '<h1>Papercusp releases</h1>' });
    expect(scanDir(clean, STANDIN_OWNER)).toBe(0);
  });

  it('exits 1 (FOUND LEAKS) on a canary tree — proving it can still FAIL', () => {
    // THE CALIBRATION CONTROL. An always-refuse gate would pass both cases above.
    const canary = fixture('canary', { 'notes.txt': `built by ${STANDIN_OWNER} on the release box` });
    expect(scanDir(canary, STANDIN_OWNER)).toBe(1);
  });

  it('keeps CANNOT-CHECK and FOUND-LEAKS on distinct exit codes', () => {
    // A caller's `|| fail` cannot tell a blind gate from a clean one if these collide —
    // the original bug, one layer up.
    const canary = fixture('canary', { 'notes.txt': `built by ${STANDIN_OWNER} on the release box` });
    expect(scanDir(canary)).not.toBe(scanDir(canary, STANDIN_OWNER));
  });
});

describe('audit-release-bundle.py release false-positive controls', () => {
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

describe('audit-release-bundle.py — the owner-name check does not rest on the denylist', () => {
  // PINS the claim release-content-scrub.ts makes about this file. The TS scrub drops a
  // git-derived name at COLLECTION time; this gate keeps it (so a bot's name is still
  // REDACTED) and refuses one layer later instead. That reads like a disagreement about
  // who the owner is, and a future reader "aligning" them would reintroduce the denylist
  // the TS side deliberately abandoned. What actually makes the divergence safe is that
  // has_owner_name_literal() ignores the literal set entirely and consults only the env.

  /** Both owner-name predicates, without touching this box's real git config. */
  function ownerNamePredicates(
    name: string,
    ownerEnv?: string,
  ): { denylisted: boolean; detectable: boolean } {
    const source = [
      'import json, runpy, sys',
      'ns = runpy.run_path(sys.argv[1])',
      'name = sys.argv[2]',
      'print(json.dumps({',
      '    "denylisted": bool(ns["looks_like_automation_identity"](name)),',
      '    "detectable": bool(ns["has_owner_name_literal"]({"build-git-name": name})),',
      '}))',
    ].join('\n');
    const env = { ...process.env };
    delete env[OWNER_NAME_ENV];
    if (ownerEnv !== undefined) env[OWNER_NAME_ENV] = ownerEnv;
    const r = spawnSync('python3', ['-c', source, AUDIT, name], { env, encoding: 'utf8' });
    if (r.error) throw r.error;
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as { denylisted: boolean; detectable: boolean };
  }

  // An AUTOMATION spelling the denylist does not enumerate (never an owner identity). If
  // someone later adds it to AUTOMATION_NAME_RE, the premise assertion below fails loudly
  // rather than the pin silently testing nothing — pick another unenumerated spelling at
  // that point, do not delete the case.
  const UNENUMERATED_BOT = 'papercusp-buildbox';

  it('a bot name the denylist MISSES still cannot satisfy the owner-name check', () => {
    const { denylisted, detectable } = ownerNamePredicates(UNENUMERATED_BOT);
    expect(denylisted).toBe(false); // premise: this is the fails-open case, not a caught one
    expect(detectable).toBe(false); // and it refuses anyway — the denylist is not load-bearing
  });

  it('only the EXPLICIT owner name satisfies it — the calibration control', () => {
    // Without this, a has_owner_name_literal() hard-wired to False would pass the case
    // above and look like a stronger gate than it is.
    expect(ownerNamePredicates(UNENUMERATED_BOT, STANDIN_OWNER).detectable).toBe(true);
  });
});
