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
import {
  harnessCitationRepoRoot,
  resolveCitation,
  repoCitationDeps,
  type AuditCitation,
} from './plan-audits';

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

describe('harnessCitationRepoRoot — canonical registry precedence (WI-38854)', () => {
  it('uses the registered hive checkout instead of a stale same-slug workspace sibling', () => {
    const canonical = path.join(workspaceRoot, '.papercusp', 'hives', 'sidestage');
    fs.mkdirSync(path.join(canonical, 'apps', 'web', 'src'), { recursive: true });
    fs.mkdirSync(path.join(canonical, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(canonical, 'apps', 'web', 'src', 'EventReadinessPanel.tsx'),
      'export function EventReadinessPanel() { return null; }\n',
    );

    const root = harnessCitationRepoRoot(
      { projects: [{ slug: 'sidestage', path: canonical }] },
      'sidestage',
    );
    expect(root).toBe(canonical);
    expect(
      resolveCitation(
        { kind: 'code', path: 'apps/web/src/EventReadinessPanel.tsx', symbol: 'EventReadinessPanel' },
        repoCitationDeps(root!),
      ),
    ).toEqual({ ok: true });
    expect(resolveCitation(code('apps/web/src/EventReadinessPanel.tsx'), repoCitationDeps(repoRoot)).ok).toBe(false);
  });

  it('fails closed for an unregistered explicit harness', () => {
    expect(harnessCitationRepoRoot({ projects: [] }, 'missing')).toBeNull();
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

/**
 * `file_not_found` names the ROOT it searched (EI-20449557927956357).
 *
 * The class this guards: the refusal for "your path shape is wrong" and the refusal for
 * "you are resolving against a root you did not expect" were BYTE-IDENTICAL — both just
 * echoed the path back. Those two have opposite fixes, so the reader cannot act on the
 * message; measured cost was ~20min of bisecting a shipping plan's ship gate, and a
 * second agent hit the same wall the same day from the other direction.
 *
 * Asserting on the ROOT rather than on prose keeps this a behavioural guard: reword the
 * message freely, but a detail that stops naming where it looked fails here.
 */
describe('resolveCitation — a miss says WHERE it looked (EI-20449557927956357)', () => {
  it('names the repo root when nothing matched', () => {
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('apps/operator/does-not-exist.ts'), deps);
    expect(res).toMatchObject({ ok: false, reason: 'file_not_found' });
    const detail = (res as { detail: string }).detail;
    expect(detail).toContain('apps/operator/does-not-exist.ts');
    expect(detail).toContain(repoRoot);
  });

  it('names the HARNESS root when resolution is scoped to a harness tree', () => {
    // The exact shape that cost the 20 minutes: a plan whose harness is a sibling hive.
    // A citation written workspace-relative (`sidestage/...`) misses, and the old detail
    // could not reveal that the search was rooted INSIDE the hive already.
    const canonical = path.join(workspaceRoot, '.papercusp', 'hives', 'sidestage');
    fs.mkdirSync(path.join(canonical, '.git'), { recursive: true });
    const deps = repoCitationDeps(canonical);
    const res = resolveCitation(code('sidestage/apps/web/src/SellerDock.tsx'), deps);
    expect(res).toMatchObject({ ok: false, reason: 'file_not_found' });
    expect((res as { detail: string }).detail).toContain(canonical);
  });

  it('names BOTH roots when the first segment is an admitted sibling', () => {
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('sidestage/apps/web/src/NoSuchFile.tsx'), deps);
    expect(res).toMatchObject({ ok: false, reason: 'file_not_found' });
    const detail = (res as { detail: string }).detail;
    expect(detail).toContain(repoRoot);
    expect(detail).toContain(path.join(workspaceRoot, 'sidestage'));
  });

  it('does not name a sibling root that was never consulted', () => {
    // Control: without this, "names both roots" would also pass an implementation that
    // blindly appends every admitted sibling to every miss — which buries the one root
    // that matters and is the failure mode this whole change exists to remove.
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('apps/operator/does-not-exist.ts'), deps);
    expect((res as { detail: string }).detail).not.toContain(path.join(workspaceRoot, 'sidestage'));
  });

  it('stays pure: injected deps without describeRoots return the bare path', () => {
    const res = resolveCitation(code('apps/operator/nope.ts'), {
      statFile: () => null,
      readFile: () => null,
    });
    expect(res).toEqual({ ok: false, reason: 'file_not_found', detail: 'apps/operator/nope.ts' });
  });
});
