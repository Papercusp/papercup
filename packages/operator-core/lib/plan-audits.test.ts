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
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __repoCitationTrackingCacheStatsForTests,
  __resetRepoCitationTrackingCacheForTests,
  citationBlobSha,
  foldEffectiveItemAudits,
  gitBlobSha,
  harnessCitationRepoRoot,
  independentSiblingRepos,
  registeredCitationRepoRoots,
  selectHarnessCitationRepoRoot,
  planItemTextHash,
  prepareAuditPassEntries,
  recordPlanAudit,
  resolveCitation,
  repoCitationDeps,
  validatePersistedAuditEntries,
  type AuditCitation,
  type CitationDeps,
  type CitationFailureReason,
  type CitationResolution,
} from './plan-audits';

let workspaceRoot: string;
let repoRoot: string;
let registeredAppRoot: string;
let registeredPointerRoot: string;

const code = (p: string): AuditCitation => ({ kind: 'code', path: p });

type CitationResolver = (citation: AuditCitation, deps: CitationDeps) => CitationResolution;

const deliberatelyWrongCitationResolver: CitationResolver = () => ({ ok: true });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
}

function citationResolverContractFailures(resolve: CitationResolver, deps: CitationDeps): string[] {
  const cases: Array<{
    name: string;
    citation: AuditCitation;
    expected: { ok: true } | { ok: false; reason: CitationFailureReason };
  }> = [
    {
      name: 'existing code path',
      citation: code('apps/operator/in-repo.ts'),
      expected: { ok: true },
    },
    {
      name: 'missing code path',
      citation: code('apps/operator/does-not-exist.ts'),
      expected: { ok: false, reason: 'file_not_found' },
    },
    {
      name: 'line beyond the cited file',
      citation: { ...code('apps/operator/in-repo.ts'), line: 9999 },
      expected: { ok: false, reason: 'line_out_of_range' },
    },
    {
      name: 'symbol absent from the cited file',
      citation: { ...code('apps/operator/in-repo.ts'), symbol: 'notInThisFile' },
      expected: { ok: false, reason: 'symbol_not_found' },
    },
    {
      name: 'none citation without a reason',
      citation: { kind: 'none' },
      expected: { ok: false, reason: 'reason_missing' },
    },
  ];

  return cases.flatMap(({ name, citation, expected }) => {
    const actual = resolve(citation, deps);
    if (actual.ok !== expected.ok) return [name];
    if (!actual.ok && !expected.ok && actual.reason !== expected.reason) return [name];
    return [];
  });
}

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

  // A registered app checkout nested below the workspace state directory. This is
  // intentionally not a direct sibling, so filesystem adjacency cannot admit it.
  registeredAppRoot = path.join(workspaceRoot, '.papercusp', 'apps', 'email');
  fs.mkdirSync(path.join(registeredAppRoot, '.git'), { recursive: true });
  fs.mkdirSync(path.join(registeredAppRoot, 'apps', 'desktop'), { recursive: true });
  fs.writeFileSync(
    path.join(registeredAppRoot, 'apps', 'desktop', 'main.ts'),
    'export const emailDesktop = true;\n',
  );

  // A registered pointer-file worktree must not become evidence merely because the
  // registry names its path.
  registeredPointerRoot = path.join(workspaceRoot, '.papercusp', 'apps', 'email-checkpoint');
  fs.mkdirSync(path.join(registeredPointerRoot, 'apps', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(registeredPointerRoot, '.git'), 'gitdir: /tmp/email-checkpoint\n');
  fs.writeFileSync(
    path.join(registeredPointerRoot, 'apps', 'desktop', 'pointer-only.ts'),
    'export const checkpoint = true;\n',
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

describe('resolveCitation — falsifiability control (plan P-011)', () => {
  it('satisfies the resolver contract against temp-tree evidence', () => {
    expect(citationResolverContractFailures(resolveCitation, repoCitationDeps(repoRoot))).toEqual([]);
  });

  it('catches a permanently wrong resolver without mutating production code', () => {
    expect(citationResolverContractFailures(deliberatelyWrongCitationResolver, repoCitationDeps(repoRoot))).toEqual([
      'missing code path',
      'line beyond the cited file',
      'symbol absent from the cited file',
      'none citation without a reason',
    ]);
  });
});

describe('resolveCitation — trackedness of verifying citations (EI-21729074760905025)', () => {
  const resolvingDeps = (tracked: boolean | null): CitationDeps => ({
    statFile: () => ({ isFile: true }),
    readFile: () => 'export const cited = true;\n',
    isTracked: () => tracked,
  });

  it.each(['code', 'test'] as const)('rejects a %s citation when Git definitely reports it as untracked', (kind) => {
    const result = resolveCitation({ kind, path: 'src/untracked.ts' }, resolvingDeps(false));
    expect(result).toMatchObject({
      ok: false,
      reason: 'file_untracked',
    });
    expect((result as { detail: string }).detail).toContain('git-sync');
    expect((result as { detail: string }).detail).toContain('ignored');
  });

  it('preserves an otherwise-valid citation when trackedness is indeterminate', () => {
    expect(resolveCitation(code('src/unknown.ts'), resolvingDeps(null))).toEqual({ ok: true });
  });

  it('gates only verifying citation kinds', () => {
    const deps = resolvingDeps(false);
    expect(resolveCitation({ kind: 'doc', path: 'docs/design.md' }, deps)).toEqual({ ok: true });
    expect(resolveCitation({ kind: 'none', reason: 'operational-only item' }, deps)).toEqual({ ok: true });
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

  it('selects the sole real Hive checkout when the registry member path is stale', () => {
    const stale = path.join(workspaceRoot, 'missing-devboard');
    const fallback = path.join(workspaceRoot, 'sidestage-fallback');
    fs.mkdirSync(path.join(fallback, '.git'), { recursive: true });
    fs.mkdirSync(path.join(fallback, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(fallback, 'apps', 'web', 'src', 'BuyerProductRail.css'),
      '.rail { display: grid; }\n',
    );

    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'sb-devboard-hive', path: stale, harness_kind: 'hive' }] },
        'sb-devboard-hive',
        [code('apps/web/src/BuyerProductRail.css')],
        [fallback],
      ),
    ).toEqual({ root: fallback, source: 'hive-checkout' });
  });

  it('refuses an ambiguous tie between two real Hive checkouts', () => {
    const stale = path.join(workspaceRoot, 'missing-devboard-ambiguous');
    const first = path.join(workspaceRoot, 'hive-first');
    const second = path.join(workspaceRoot, 'hive-second');
    for (const root of [first, second]) {
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      fs.mkdirSync(path.join(root, 'apps', 'web', 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'apps', 'web', 'src', 'BuyerProductRail.css'), '.rail {}\n');
    }

    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'sb-devboard-hive', path: stale, harness_kind: 'hive' }] },
        'sb-devboard-hive',
        [code('apps/web/src/BuyerProductRail.css')],
        [first, second],
      ),
    ).toBeNull();
  });

  it('excludes pointer-file worktrees from Hive fallback candidates', () => {
    const stale = path.join(workspaceRoot, 'missing-devboard-worktree');
    const real = path.join(workspaceRoot, 'hive-real');
    const worktree = path.join(workspaceRoot, 'hive-checkpoint');
    fs.mkdirSync(path.join(real, '.git'), { recursive: true });
    fs.mkdirSync(path.join(real, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(path.join(real, 'apps', 'web', 'src', 'BuyerProductRail.css'), '.rail {}\n');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /tmp/other-worktree\n');
    fs.mkdirSync(path.join(worktree, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'apps', 'web', 'src', 'BuyerProductRail.css'), '.checkpoint {}\n');

    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'sb-devboard-hive', path: stale, harness_kind: 'hive' }] },
        'sb-devboard-hive',
        [code('apps/web/src/BuyerProductRail.css')],
        [real, worktree],
      ),
    ).toEqual({ root: real, source: 'hive-checkout' });
  });

  it('keeps a resolving registry root labeled as the registry source', () => {
    const canonical = path.join(workspaceRoot, 'registry-live');
    fs.mkdirSync(path.join(canonical, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(path.join(canonical, 'apps', 'web', 'src', 'BuyerProductRail.css'), '.rail {}\n');

    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'sb-devboard-hive', path: canonical, harness_kind: 'hive' }] },
        'sb-devboard-hive',
        [code('apps/web/src/BuyerProductRail.css')],
        [],
      ),
    ).toEqual({ root: canonical, source: 'registry' });
  });

  it('falls back to the canonical repo when no hive checkout resolves the citations (WI-41365)', () => {
    const stale = path.join(workspaceRoot, 'missing-devboard-canonical');
    const nonResolving = path.join(workspaceRoot, 'hive-unrelated');
    fs.mkdirSync(path.join(nonResolving, '.git'), { recursive: true });
    const canonicalRepo = path.join(workspaceRoot, 'canonical-papercusp');
    fs.mkdirSync(path.join(canonicalRepo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(canonicalRepo, 'packages', 'operator-core', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(canonicalRepo, 'packages', 'operator-core', 'lib', 'orient-task-schema-pack.ts'),
      'export const packed = 1;\n',
    );

    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'sb-devboard-hive', path: stale, harness_kind: 'hive' }] },
        'sb-devboard-hive',
        [code('packages/operator-core/lib/orient-task-schema-pack.ts')],
        [nonResolving],
        canonicalRepo,
      ),
    ).toEqual({ root: canonicalRepo, source: 'canonical-repo' });
  });

  it('prefers a sole resolving hive checkout over the canonical repo, and never tie-breaks with it', () => {
    const stale = path.join(workspaceRoot, 'missing-devboard-precedence');
    const canonicalRepo = path.join(workspaceRoot, 'canonical-papercusp-precedence');
    const hiveA = path.join(workspaceRoot, 'hive-a');
    const hiveB = path.join(workspaceRoot, 'hive-b');
    for (const root of [canonicalRepo, hiveA, hiveB]) {
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'shared.ts'), 'export const shared = 1;\n');
    }
    const reg = { projects: [{ slug: 'sb-devboard-hive', path: stale, harness_kind: 'hive' as const }] };

    // One resolving hive checkout wins even though the canonical repo also resolves.
    expect(
      selectHarnessCitationRepoRoot(reg, 'sb-devboard-hive', [code('src/shared.ts')], [hiveA], canonicalRepo),
    ).toEqual({ root: hiveA, source: 'hive-checkout' });
    // Two resolving hive checkouts stay an ambiguous refusal — the canonical repo must not tie-break.
    expect(
      selectHarnessCitationRepoRoot(reg, 'sb-devboard-hive', [code('src/shared.ts')], [hiveA, hiveB], canonicalRepo),
    ).toBeNull();
    // And a citation resolving NOWHERE still fails closed.
    expect(
      selectHarnessCitationRepoRoot(reg, 'sb-devboard-hive', [code('src/nowhere.ts')], [hiveA], canonicalRepo),
    ).toBeNull();
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

describe('repoCitationDeps — registered project roots (EI-21830530720187606)', () => {
  it('admits a nested registered checkout without requiring workspace relocation', () => {
    const deps = repoCitationDeps(repoRoot, [registeredAppRoot]);
    expect(
      resolveCitation(
        { kind: 'code', path: 'apps/desktop/main.ts', symbol: 'emailDesktop' },
        deps,
      ),
    ).toEqual({ ok: true });
  });

  it('keeps the selected root ahead of a registered root with the same relative path', () => {
    fs.mkdirSync(path.join(repoRoot, 'apps', 'desktop'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'apps', 'desktop', 'main.ts'),
      'export const canonicalDesktop = true;\n',
    );
    const deps = repoCitationDeps(repoRoot, [registeredAppRoot]);
    expect(
      resolveCitation(
        { kind: 'code', path: 'apps/desktop/main.ts', symbol: 'canonicalDesktop' },
        deps,
      ),
    ).toEqual({ ok: true });
    expect(
      resolveCitation(
        { kind: 'code', path: 'apps/desktop/main.ts', symbol: 'emailDesktop' },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'symbol_not_found' });
  });

  it('excludes registered pointer-file worktrees', () => {
    const deps = repoCitationDeps(repoRoot, [registeredPointerRoot]);
    const result = resolveCitation(code('apps/desktop/pointer-only.ts'), deps);
    expect(result).toMatchObject({ ok: false, reason: 'file_not_found' });
    expect((result as { detail: string }).detail).not.toContain(registeredPointerRoot);
  });

  it('reports registered roots in a miss after trying them', () => {
    const deps = repoCitationDeps(repoRoot, [registeredAppRoot]);
    const result = resolveCitation(code('apps/desktop/missing.ts'), deps);
    expect(result).toMatchObject({ ok: false, reason: 'file_not_found' });
    expect((result as { detail: string }).detail).toContain(repoRoot);
    expect((result as { detail: string }).detail).toContain(registeredAppRoot);
  });

  it('derives only real registered checkout roots from ProjectEntry.path', () => {
    expect(
      registeredCitationRepoRoots({
        projects: [
          { slug: 'email', path: registeredAppRoot },
          { slug: 'email-checkpoint', path: registeredPointerRoot },
          { slug: 'state-only', path: path.join(workspaceRoot, '.papercusp', 'hives', 'email') },
        ],
      }),
    ).toEqual([registeredAppRoot]);
  });

  it('lets root selection resolve a mixed citation set through registered roots', () => {
    const registryRoot = path.join(workspaceRoot, 'registered-primary');
    fs.mkdirSync(path.join(registryRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(registryRoot, 'apps', 'operator'), { recursive: true });
    fs.writeFileSync(
      path.join(registryRoot, 'apps', 'operator', 'primary.ts'),
      'export const primary = true;\n',
    );
    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'email-harness', path: registryRoot }] },
        'email-harness',
        [
          code('apps/operator/primary.ts'),
          code('apps/desktop/main.ts'),
        ],
        [],
        repoRoot,
        [registeredAppRoot],
      ),
    ).toEqual({ root: registryRoot, source: 'registry' });
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

describe('repoCitationDeps — Git trackedness (EI-21729074760905025)', () => {
  it('distinguishes tracked and untracked files in the selected repository', () => {
    const trackedRoot = path.join(workspaceRoot, 'tracked-repo');
    fs.mkdirSync(trackedRoot, { recursive: true });
    fs.writeFileSync(path.join(trackedRoot, 'tracked.ts'), 'export const tracked = true;\n');
    git(trackedRoot, 'init', '-q');
    git(trackedRoot, 'add', '--', 'tracked.ts');
    fs.writeFileSync(path.join(trackedRoot, 'untracked.ts'), 'export const untracked = true;\n');

    const deps = repoCitationDeps(trackedRoot);
    expect(deps.isTracked?.('tracked.ts')).toBe(true);
    expect(deps.isTracked?.('untracked.ts')).toBe(false);
    expect(resolveCitation(code('tracked.ts'), deps)).toEqual({ ok: true });
    expect(resolveCitation(code('untracked.ts'), deps)).toMatchObject({
      ok: false,
      reason: 'file_untracked',
    });
  });

  it('reuses one tracked-file snapshot across resolver contexts and reloads it when the Git index changes', () => {
    const trackedRoot = path.join(workspaceRoot, 'tracked-cache-repo');
    fs.mkdirSync(trackedRoot, { recursive: true });
    fs.writeFileSync(path.join(trackedRoot, 'tracked.ts'), 'export const tracked = true;\n');
    fs.writeFileSync(path.join(trackedRoot, 'newly-tracked.ts'), 'export const later = true;\n');
    git(trackedRoot, 'init', '-q');
    git(trackedRoot, 'add', '--', 'tracked.ts');

    __resetRepoCitationTrackingCacheForTests();
    try {
      expect(repoCitationDeps(trackedRoot).isTracked?.('tracked.ts')).toBe(true);
      // A NEW deps object shares the index snapshot instead of spawning Git once
      // per citation/root-selection/gate-evaluation context.
      expect(repoCitationDeps(trackedRoot).isTracked?.('newly-tracked.ts')).toBe(false);
      expect(__repoCitationTrackingCacheStatsForTests()).toEqual({ roots: 1, loads: 1 });

      git(trackedRoot, 'add', '--', 'newly-tracked.ts');
      expect(repoCitationDeps(trackedRoot).isTracked?.('newly-tracked.ts')).toBe(true);
      expect(__repoCitationTrackingCacheStatsForTests()).toEqual({ roots: 1, loads: 2 });
    } finally {
      __resetRepoCitationTrackingCacheForTests();
    }
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

/**
 * EI-22129491468808913: a bare repo-relative citation for genuinely cross-repo work
 * (no sibling-name prefix at all) misses `within()`'s existing sibling branch entirely
 * — that branch only fires when the FIRST SEGMENT already names a sibling — so the
 * miss reads identically to a wholly nonexistent path. An auditor who tries the
 * natural bare shape, watches it fail, and has no signal that a sibling repo holds the
 * same relative path reasonably (but wrongly) concludes cross-repo citation is unsafe
 * and downgrades real code to `not-code`.
 */
describe('resolveCitation — sibling repair suggestion on a miss (EI-22129491468808913)', () => {
  it('suggests the sibling-prefixed path when the bare citation matches one', () => {
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('apps/web/src/SellerDock.tsx'), deps);
    expect(res).toMatchObject({ ok: false, reason: 'file_not_found' });
    expect((res as { detail: string }).detail).toContain('did you mean "sidestage/apps/web/src/SellerDock.tsx"?');
  });

  it('names no suggestion when nothing under any sibling matches', () => {
    const res = resolveCitation(code('apps/operator/does-not-exist.ts'), repoCitationDeps(repoRoot));
    expect((res as { detail: string }).detail).not.toContain('did you mean');
  });

  it('does not re-suggest the same sibling prefix a citation already carries', () => {
    // `within()` already tried `sidestage/apps/web/src/NoSuchFile.tsx` under the
    // sibling directly; a suggestion re-adding the same "sidestage/" prefix would be
    // noise ("did you mean sidestage/sidestage/..."), not a repair.
    const res = resolveCitation(code('sidestage/apps/web/src/NoSuchFile.tsx'), repoCitationDeps(repoRoot));
    expect((res as { detail: string }).detail).not.toContain('did you mean');
  });

  it('stays pure: injected deps without siblingSuggestion return the bare miss detail unchanged', () => {
    const res = resolveCitation(code('apps/operator/nope.ts'), {
      statFile: () => null,
      readFile: () => null,
      describeRoots: () => repoRoot,
    });
    expect(res).toEqual({
      ok: false,
      reason: 'file_not_found',
      detail: `apps/operator/nope.ts (searched ${repoRoot})`,
    });
  });
});

describe('per-item audit provenance (plan D-006/D-007)', () => {
  it('stores a Git-compatible blob sha for code evidence only', () => {
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    const deps = repoCitationDeps(repoRoot);
    const citation = code('apps/operator/in-repo.ts');
    expect(citationBlobSha(citation, deps)).toBe(gitBlobSha('export const inRepo = 1;\n'));
    expect(citationBlobSha({ kind: 'doc', path: 'apps/operator/in-repo.ts' }, deps)).toBeNull();
  });

  it('folds newest entries per item across partial passes', () => {
    const older = { itemId: 'P-001', verdict: 'implemented' as const, citations: [] };
    const newer = { itemId: 'P-001', verdict: 'partial' as const, citations: [] };
    const second = { itemId: 'P-002', verdict: 'implemented' as const, citations: [] };
    expect(
      foldEffectiveItemAudits([
        { auditSeq: 3, items: [newer] },
        { auditSeq: 2, items: [older, second] },
      ]),
    ).toEqual([
      { entry: newer, auditSeq: 3 },
      { entry: second, auditSeq: 2 },
    ]);
  });

  it('carries an unlisted item without re-stamping its original provenance', () => {
    const original = {
      itemId: 'P-001',
      verdict: 'implemented' as const,
      citations: [{ kind: 'code' as const, path: 'old.ts', blobSha: 'ce013625030ba8dba906f756967f9e9ca394464a' }],
      auditedSha: 'old-head',
      auditedAt: '2026-08-13T10:00:00.000Z',
      itemTextHash: planItemTextHash('old requirement'),
    };
    const fresh = {
      itemId: 'P-002',
      verdict: 'implemented' as const,
      citations: [{ kind: 'test' as const, path: 'new.test.ts', blobSha: 'da39a3ee5e6b4b0d3255bfef95601890afd80709' }],
    };
    const result = prepareAuditPassEntries({
      planItems: [
        { itemId: 'P-001', status: 'done', itemText: 'old requirement' },
        { itemId: 'P-002', status: 'done', itemText: 'fresh requirement' },
        { itemId: 'P-003', status: 'todo', itemText: 'never audited' },
      ],
      submitted: [fresh],
      previous: [{ entry: original, auditSeq: 4 }],
      auditedSha: 'new-head',
      auditedAt: '2026-08-20T12:00:00.000Z',
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ ...original, carriedFrom: 4 });
    expect(result[1]).toEqual({
      ...fresh,
      auditedSha: 'new-head',
      auditedAt: '2026-08-20T12:00:00.000Z',
      itemTextHash: planItemTextHash('fresh requirement'),
    });
    expect(validatePersistedAuditEntries(result)).toEqual([]);
    expect(result.some((entry) => entry.itemId === 'P-003')).toBe(false);
  });

  it('rejects a newly-created legacy-shaped entry at the write boundary', async () => {
    const item = { itemId: 'P-001', verdict: 'implemented' as const, citations: [] };
    expect(validatePersistedAuditEntries([item])).toEqual([
      expect.objectContaining({ itemId: 'P-001', code: 'missing_audited_sha' }),
      expect.objectContaining({ itemId: 'P-001', code: 'missing_audited_at' }),
      expect.objectContaining({ itemId: 'P-001', code: 'missing_item_text_hash' }),
    ]);
    await expect(
      recordPlanAudit({
        planSlug: 'test-plan',
        harnessSlug: 'papercusp',
        createdBy: 'test-agent',
        items: [item],
      }),
    ).rejects.toThrow(/plan audit provenance invalid/);
  });

  it('rejects a fresh code citation without its blob hash', () => {
    expect(
      validatePersistedAuditEntries([
        {
          itemId: 'P-001',
          verdict: 'implemented',
          citations: [{ kind: 'code', path: 'src/a.ts' }],
          auditedSha: 'abcdef1234567',
          auditedAt: '2026-08-20T12:00:00.000Z',
          itemTextHash: planItemTextHash('requirement'),
        },
      ]),
    ).toEqual([expect.objectContaining({ itemId: 'P-001', code: 'missing_blob_sha' })]);
  });

  it('allows a legacy entry only when it is explicitly carried forward', () => {
    expect(
      validatePersistedAuditEntries([
        {
          itemId: 'P-001',
          verdict: 'implemented',
          citations: [{ kind: 'code', path: 'old.ts' }],
          carriedFrom: 4,
        },
      ]),
    ).toEqual([]);
  });
});

describe('independentSiblingRepos — a checkout directly under $HOME (EI-22188958812917965)', () => {
  // Fully isolated from the real machine's home directory (opts.homeRoot), matching this
  // file's own stated discipline: the guard must hold on a box where the reported shape
  // does not happen to exist for real. The reported bug: a sibling checkout that sits
  // directly under $HOME — one tier further out than the conventional
  // `~/papercupai-workspace/`-style workspace directory — was invisible to this resolver
  // no matter how the caller repo-qualified the path, because the scan never looked past
  // `dirname(repoRoot)`.
  let homeRoot: string;
  let workspaceRoot: string;
  let repoRoot: string;

  beforeAll(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-home-'));
    workspaceRoot = path.join(homeRoot, 'papercupai-workspace');
    repoRoot = path.join(workspaceRoot, 'papercusp');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });

    // The conventional tier: a sibling INSIDE workspaceRoot, beside repoRoot.
    fs.mkdirSync(path.join(workspaceRoot, 'sidestage', '.git'), { recursive: true });

    // The reported tier: a sibling directly under $HOME, one level further out —
    // `~/Restart`, not `~/papercupai-workspace/Restart`.
    fs.mkdirSync(path.join(homeRoot, 'Restart', '.git'), { recursive: true });

    // A non-repo directory directly under $HOME must NOT be admitted (no `.git` dir).
    fs.mkdirSync(path.join(homeRoot, 'Downloads'));

    // A worktree pointer FILE (not a directory) under $HOME must be excluded too, matching
    // the existing workspace-tier worktree exclusion.
    fs.mkdirSync(path.join(homeRoot, 'papercusp-release'));
    fs.writeFileSync(path.join(homeRoot, 'papercusp-release', '.git'), 'gitdir: ../elsewhere\n');
  });

  afterAll(() => {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it('finds a sibling directly under $HOME, not just inside the conventional workspace directory', () => {
    const siblings = independentSiblingRepos(repoRoot, { homeRoot });
    expect(siblings.has('Restart')).toBe(true);
    expect(siblings.get('Restart')).toBe(homeRoot);
  });

  it('still finds the conventional workspace-tier sibling, resolved against workspaceRoot', () => {
    const siblings = independentSiblingRepos(repoRoot, { homeRoot });
    expect(siblings.has('sidestage')).toBe(true);
    expect(siblings.get('sidestage')).toBe(workspaceRoot);
  });

  it('does not admit a non-repo directory or a worktree pointer file under $HOME', () => {
    const siblings = independentSiblingRepos(repoRoot, { homeRoot });
    expect(siblings.has('Downloads')).toBe(false);
    expect(siblings.has('papercusp-release')).toBe(false);
  });

  it('the returned parent resolves the exact reported repro path to a real, readable file', () => {
    // The bug's repro: filesChanged: ["apps/web/lib/sheets.ts"] (bare) and
    // ["Restart/apps/web/lib/sheets.ts"] (repo-qualified) both reported "absent-from-both".
    // A consumer (repoCitationDeps's `within()`, or completionRepoRootsFromRegistry) resolves
    // a sibling name against `siblings.get(name)` — never a hardcoded workspaceRoot — which is
    // exactly what makes the repo-qualified form work now.
    fs.mkdirSync(path.join(homeRoot, 'Restart', 'apps', 'web', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(homeRoot, 'Restart', 'apps', 'web', 'lib', 'sheets.ts'),
      'export const sheets = 1;\n',
    );
    const siblings = independentSiblingRepos(repoRoot, { homeRoot });
    const parent = siblings.get('Restart');
    expect(parent).toBe(homeRoot);
    const abs = path.resolve(parent!, 'Restart', 'apps/web/lib/sheets.ts');
    expect(fs.readFileSync(abs, 'utf8')).toContain('sheets');
  });
});
