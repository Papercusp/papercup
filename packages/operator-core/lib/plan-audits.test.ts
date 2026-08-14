/**
 * Citation resolution across repository roots.
 *
 * The class this guards (EI-20430092702151575): a plan filed under one harness whose
 * code lives in a SIBLING repo of the same workspace was structurally unauditable.
 * Rooting resolution at the monorepo alone meant the repo-relative path did not
 * exist, the workspace-prefixed shape did not exist either, `..` was refused by both
 * traversal guards and an absolute path is schema-refused — so NO expressible
 * citation resolved and the ship gate could never be satisfied honestly.
 *
 * Every fixture below is built in a temp directory rather than asserted against this
 * machine's real workspace: the guard has to keep holding on a box where `sidestage`
 * does not exist.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCitation, repoCitationDeps, type AuditCitation } from './plan-audits';

let workspaceRoot: string;
let repoRoot: string;

const code = (p: string): AuditCitation => ({ kind: 'code', path: p });

beforeAll(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-roots-'));

  // The monorepo itself.
  repoRoot = path.join(workspaceRoot, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'apps', 'operator'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'apps', 'operator', 'in-repo.ts'), 'export const inRepo = 1;\n');
  fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });

  // An INDEPENDENT sibling repository (`.git` is a directory) — the sidestage shape.
  const sibling = path.join(workspaceRoot, 'sidestage');
  fs.mkdirSync(path.join(sibling, 'apps', 'web', 'src'), { recursive: true });
  fs.mkdirSync(path.join(sibling, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(sibling, 'apps', 'web', 'src', 'SellerDock.tsx'),
    'export function SellerDock() { return null; }\n',
  );

  // A WORKTREE of the monorepo (`.git` is a pointer FILE) — a deploy artifact that
  // must never stand as evidence, even though the file it holds really exists.
  const worktree = path.join(workspaceRoot, 'repo-release');
  fs.mkdirSync(path.join(worktree, 'apps', 'operator'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(repoRoot, '.git', 'worktrees', 'release')}\n`);
  fs.writeFileSync(path.join(worktree, 'apps', 'operator', 'deployed.ts'), 'export const deployed = 1;\n');

  // A plain directory with no `.git` at all.
  fs.mkdirSync(path.join(workspaceRoot, 'scratch', 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'scratch', 'src', 'notes.ts'), 'export const notes = 1;\n');
});

afterAll(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('repoCitationDeps — in-repo citations (unchanged behaviour)', () => {
  it('resolves a repo-relative path to a real file', () => {
    const deps = repoCitationDeps(repoRoot);
    expect(resolveCitation(code('apps/operator/in-repo.ts'), deps)).toEqual({ ok: true });
  });

  it('still refuses a path that names nothing', () => {
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('apps/operator/does-not-exist.ts'), deps);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'file_not_found' });
  });
});

describe('repoCitationDeps — sibling repositories (EI-20430092702151575)', () => {
  it('resolves a workspace-relative citation into an INDEPENDENT sibling repo', () => {
    const deps = repoCitationDeps(repoRoot);
    expect(resolveCitation(code('sidestage/apps/web/src/SellerDock.tsx'), deps)).toEqual({ ok: true });
  });

  it('verifies line and symbol inside a sibling file, not merely its existence', () => {
    const deps = repoCitationDeps(repoRoot);
    expect(
      resolveCitation({ kind: 'code', path: 'sidestage/apps/web/src/SellerDock.tsx', symbol: 'SellerDock' }, deps),
    ).toEqual({ ok: true });

    const missing = resolveCitation(
      { kind: 'code', path: 'sidestage/apps/web/src/SellerDock.tsx', symbol: 'NotInThisFile' },
      deps,
    );
    expect(missing.ok).toBe(false);
    expect(missing).toMatchObject({ reason: 'symbol_not_found' });

    const past = resolveCitation({ kind: 'code', path: 'sidestage/apps/web/src/SellerDock.tsx', line: 9999 }, deps);
    expect(past.ok).toBe(false);
    expect(past).toMatchObject({ reason: 'line_out_of_range' });
  });

  it('REFUSES a worktree of this repo — a deploy artifact is never evidence', () => {
    const deps = repoCitationDeps(repoRoot);
    // The file genuinely exists on disk; admission is decided by `.git` being a
    // pointer FILE, so this must fail despite the path being real.
    expect(fs.existsSync(path.join(workspaceRoot, 'repo-release', 'apps', 'operator', 'deployed.ts'))).toBe(true);
    const res = resolveCitation(code('repo-release/apps/operator/deployed.ts'), deps);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'file_not_found' });
  });

  it('REFUSES a sibling directory that is not a repository at all', () => {
    const deps = repoCitationDeps(repoRoot);
    expect(fs.existsSync(path.join(workspaceRoot, 'scratch', 'src', 'notes.ts'))).toBe(true);
    const res = resolveCitation(code('scratch/src/notes.ts'), deps);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'file_not_found' });
  });

  it('prefers the in-repo file when a sibling shares its first path segment', () => {
    // A monorepo directory named like a sibling must win, so a sibling can never
    // shadow real monorepo evidence.
    fs.mkdirSync(path.join(repoRoot, 'sidestage'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'sidestage', 'marker.ts'), 'export const fromRepo = true;\n');
    const deps = repoCitationDeps(repoRoot);
    expect(
      resolveCitation({ kind: 'code', path: 'sidestage/marker.ts', symbol: 'fromRepo' }, deps),
    ).toEqual({ ok: true });
  });
});

describe('repoCitationDeps — containment is unchanged', () => {
  it('refuses traversal out of the repo even though the sibling is now reachable', () => {
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('../sidestage/apps/web/src/SellerDock.tsx'), deps);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'path_escapes_repo' });
  });

  it('refuses an absolute path to a file that really exists', () => {
    const deps = repoCitationDeps(repoRoot);
    const abs = path.join(workspaceRoot, 'sidestage', 'apps', 'web', 'src', 'SellerDock.tsx');
    expect(fs.existsSync(abs)).toBe(true);
    const res = resolveCitation(code(abs), deps);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'path_absolute' });
  });
});
