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
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body, 'utf8');
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
