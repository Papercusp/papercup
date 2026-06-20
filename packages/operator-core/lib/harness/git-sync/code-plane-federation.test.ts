/**
 * code-plane-federation.test.ts — Brief AH (shared-hive-release-testing): the
 * CODE plane's end-to-end federation, with real `git` + a local bare repo as the
 * shared-hive origin (no GitHub network, no PG). The content plane (plans /
 * members / locks over the hyperbee substrate) is exhaustively covered by
 * Waves 1–5; this file closes the code-plane gaps that the existing git-sync
 * suite leaves open:
 *
 *   AH-1  Headline E2E — a collaborator member's CODE FILE reaches origin/main
 *         byte-for-byte and a peer member's git-sync pulls it; both trees + the
 *         origin converge. (S4 of seed-any-hive asserts head-sha only; C1 of
 *         two-peer asserts filenames only — neither asserts the file CONTENT
 *         round-trips, which is what "code makes it to main" actually means.)
 *
 *   AH-2  The S0 SAFETY invariant — a JOINER (decideGitSyncPush joiner-side →
 *         push:false) can NEVER direct-push the owner's main, WITH a real
 *         upstream remote present. seed-any-hive S4 only proves push:false for
 *         the NO-upstream case and carries no teeth. Here the joiner decision
 *         drives runGitSync (origin UNCHANGED), and the teeth flip the decision
 *         to creator-side (push:true) on an identical write → origin DOES
 *         advance, proving the no-direct-push assertion is load-bearing.
 *
 *   AH-3  Plane orthogonality — (a) the code-plane module imports NOTHING from
 *         the content-plane substrate (structural decoupling guard), and (b) a
 *         git-push failure is contained to the code plane (status:'error', never
 *         a throw), so a code-plane fault cannot cascade into content federation.
 *         AH-1 itself runs git-sync with NO substrate booted — the code plane
 *         reaching origin is direct proof it does not depend on the content plane.
 *
 *   AH-4  Non-`main` default branch — git-sync federates to the repo's ACTUAL
 *         default branch (origin/HEAD = `trunk`), not a hardcoded `main`. Every
 *         existing rig hardcodes `main`; the brief calls this edge out explicitly.
 *
 * Teeth-verify discipline: AH-2 carries its teeth inline (creator-push variant);
 * AH-1's content assertion goes RED if the bytes don't round-trip; AH-4's goes
 * RED if git-sync pushed `main` instead of `trunk`; AH-3b's goes RED if a push
 * failure were silently swallowed instead of surfaced as 'error'.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runGitSync } from './run-git-sync';
import { decideGitSyncPush } from './decide-git-sync-push';

// ── real-git helpers (mirror two-peer-convergence.integration.test.ts) ─────────

function shx(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', (e) => resolve({ code: -1, out, err: err + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

/** git that throws on non-zero, returning TRIMMED stdout (ids, names). */
async function git(args: string[], cwd: string): Promise<string> {
  const r = await shx('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.err || r.out}`);
  return r.out.trim();
}

/** Raw stdout of `git show <ref>:<path>` on the bare origin — NO trim, so the
 *  file's exact bytes (trailing newline included) are asserted to round-trip. */
async function showRaw(bare: string, ref: string, path: string): Promise<string> {
  const r = await shx('git', ['show', `${ref}:${path}`], bare);
  if (r.code !== 0) throw new Error(`git show ${ref}:${path} failed: ${r.err || r.out}`);
  return r.out;
}

async function configRepo(dir: string): Promise<void> {
  await git(['config', 'user.email', 'ah-it@example.com'], dir);
  await git(['config', 'user.name', 'AH integration'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
  await git(['config', 'core.hooksPath', '/nonexistent'], dir);
}

// `file://` submodule add/update is blocked by default (CVE-2022-39253) — allow in setup.
const allowFile = ['-c', 'protocol.file.allow=always'];

let tmpRoot: string;

/** One bare "shared hive origin" on `branch` + N working clones (seed pushed). */
async function makeSharedOrigin(
  name: string,
  branch: string,
  clones: string[],
): Promise<{ bare: string; works: string[] }> {
  const bare = join(tmpRoot, `${name}-origin.git`);
  await mkdir(bare, { recursive: true });
  await git(['init', '--bare', '-b', branch], bare);
  const seedDir = join(tmpRoot, `${name}-seedclone`);
  await git(['clone', bare, seedDir], tmpRoot);
  await configRepo(seedDir);
  await writeFile(join(seedDir, 'shared.txt'), 'seed\n');
  await git(['add', '-A'], seedDir);
  await git(['commit', '--no-verify', '-m', 'seed'], seedDir);
  await git(['push', '-u', 'origin', branch], seedDir);
  const works: string[] = [];
  for (const c of clones) {
    const dir = join(tmpRoot, c);
    await git(['clone', bare, dir], tmpRoot);
    await configRepo(dir);
    works.push(dir);
  }
  await rm(seedDir, { recursive: true, force: true });
  return { bare, works };
}

/** A super origin (with a submodule at `libs/sub` whose own bare origin is shared)
 *  + N super clones with the submodule checked out — models a shared-hive tree that
 *  includes a submodule. Used to prove the S0 no-direct-push invariant holds for the
 *  WHOLE tree, submodules included. */
async function makeSuperWithSub(
  name: string,
  clones: string[],
): Promise<{ superBare: string; subBare: string; works: string[] }> {
  const superBare = join(tmpRoot, `${name}-super.git`);
  const subBare = join(tmpRoot, `${name}-sub.git`);
  await mkdir(superBare, { recursive: true });
  await mkdir(subBare, { recursive: true });
  await git(['init', '--bare', '-b', 'main'], superBare);
  await git(['init', '--bare', '-b', 'main'], subBare);

  const subSeed = join(tmpRoot, `${name}-subseed`);
  await git(['clone', subBare, subSeed], tmpRoot);
  await configRepo(subSeed);
  await writeFile(join(subSeed, 'sub.txt'), 'sub init\n');
  await git(['add', '-A'], subSeed);
  await git(['commit', '--no-verify', '-m', 'sub init'], subSeed);
  await git(['push', '-u', 'origin', 'main'], subSeed);

  const superSeed = join(tmpRoot, `${name}-superseed`);
  await git(['clone', superBare, superSeed], tmpRoot);
  await configRepo(superSeed);
  await git([...allowFile, 'submodule', 'add', subBare, 'libs/sub'], superSeed);
  await git(['add', '-A'], superSeed);
  await git(['commit', '--no-verify', '-m', 'super init + submodule'], superSeed);
  await git(['push', '-u', 'origin', 'main'], superSeed);

  const works: string[] = [];
  for (const c of clones) {
    const dir = join(tmpRoot, c);
    await git(['clone', superBare, dir], tmpRoot);
    await configRepo(dir);
    await git([...allowFile, 'submodule', 'update', '--init', '--recursive'], dir);
    works.push(dir);
  }
  await rm(subSeed, { recursive: true, force: true });
  await rm(superSeed, { recursive: true, force: true });
  return { superBare, subBare, works };
}

const headOf = (dir: string): Promise<string> => git(['rev-parse', 'HEAD'], dir);
const tipOf = (bare: string, ref: string): Promise<string> => git(['rev-parse', ref], bare);

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'ah-codeplane-'));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

// ════════════════════════════════════════════════════════════════════════════
// AH-1 — Headline: a collaborator's code reaches origin/main byte-for-byte and a
// peer converges. The whole point of the code plane: CODE (not just a sha) lands.
// ════════════════════════════════════════════════════════════════════════════

describe('AH-1: collaborator code reaches origin/main end-to-end; a peer converges', () => {
  it('member-A writes a file → git-sync push lands its CONTENT on main → member-B pulls it; trees + origin converge', async () => {
    const { bare, works } = await makeSharedOrigin('ah1', 'main', ['ah1-a', 'ah1-b']);
    const [workA, workB] = works;

    // A "Bee" writes a real source file in member-A's running tree.
    const CODE = 'export const answer = 42;\n// landed via the code plane\n';
    await mkdir(join(workA, 'src'), { recursive: true });
    await writeFile(join(workA, 'src/feature.ts'), CODE);

    // git-sync tick (push:true): commit + push to the shared origin.
    const a = await runGitSync('ah1-member-a', { repoPath: workA, config: { branch: 'main', push: true } });
    expect(a.status).toBe('synced');
    if (a.status !== 'synced') throw new Error('expected synced');
    expect(a.pushed).toEqual(['superproject']);

    // The CONTENT — not merely the path — is on origin/main, byte-for-byte.
    expect(await showRaw(bare, 'main', 'src/feature.ts')).toBe(CODE);
    expect(await tipOf(bare, 'main')).toBe(await headOf(workA));

    // Member-B's git-sync (clean tree) fetch-merges A's commit — the pull leg.
    const b = await runGitSync('ah1-member-b', { repoPath: workB, config: { branch: 'main', push: true } });
    expect(b.status).toBe('synced'); // merged A's commit (nothing local to commit)

    // The code arrived in B's working tree intact; all three converged.
    expect(await readFile(join(workB, 'src/feature.ts'), 'utf8')).toBe(CODE);
    const tip = await tipOf(bare, 'main');
    expect(await headOf(workA)).toBe(tip);
    expect(await headOf(workB)).toBe(tip);
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// AH-2 — S0: a joiner can NEVER direct-push the owner's main (teeth inline).
// ════════════════════════════════════════════════════════════════════════════

describe('AH-2: the S0 no-direct-push invariant — a joiner never touches the owner main', () => {
  it('joiner-side decision is push:false → git-sync commits LOCALLY but origin/main is UNCHANGED', async () => {
    // The decision the seed makes for a non-collaborator joiner WITH a real
    // upstream remote present + even WITH a (forged) positive push permission:
    // joiner-side wins outright (rule 2 of decideGitSyncPush, before the GitHub
    // permission rules) — read-only by design; fork-PR is the contribution path.
    const joiner = decideGitSyncPush({ joinerSide: true, hasUpstreamRemote: true, permissionsPush: true });
    expect(joiner.push).toBe(false);
    expect(joiner.reason).toMatch(/^joiner_side/);

    const { bare, works } = await makeSharedOrigin('ah2j', 'main', ['ah2-joiner']);
    const [jw] = works;
    const originBefore = await tipOf(bare, 'main');

    await writeFile(join(jw, 'joiner-contribution.ts'), 'export const fromJoiner = true;\n');
    const o = await runGitSync('ah2-joiner', { repoPath: jw, config: { branch: 'main', push: joiner.push } });

    // A local mirror commit happened (the joiner's tree advances)…
    expect(o.status).toBe('synced');
    expect(await headOf(jw)).not.toBe(originBefore);
    // …but the owner's main is BYTE-IDENTICAL to before — the joiner never pushed.
    expect(await tipOf(bare, 'main')).toBe(originBefore);
    // And the joiner-only file is NOT on origin/main.
    const onOrigin = await shx('git', ['show', 'main:joiner-contribution.ts'], bare);
    expect(onOrigin.code).not.toBe(0); // path absent on origin → never federated upstream
  }, 30_000);

  it('TEETH: the SAME write under the creator-side decision (push:true) DOES advance origin/main', async () => {
    // Flip ONLY the joinerSide axis: a collaborator-with-write gets push:true and
    // the identical commit reaches origin. This proves the assertion above
    // ("origin unchanged") is load-bearing — it would be RED if a joiner pushed.
    const creator = decideGitSyncPush({ joinerSide: false, hasUpstreamRemote: true, permissionsPush: true });
    expect(creator.push).toBe(true);

    const { bare, works } = await makeSharedOrigin('ah2c', 'main', ['ah2-creator']);
    const [cw] = works;
    const originBefore = await tipOf(bare, 'main');

    await writeFile(join(cw, 'creator-contribution.ts'), 'export const fromCreator = true;\n');
    const o = await runGitSync('ah2-creator', { repoPath: cw, config: { branch: 'main', push: creator.push } });

    expect(o.status).toBe('synced');
    if (o.status !== 'synced') throw new Error('expected synced');
    expect(o.pushed).toEqual(['superproject']);
    expect(await tipOf(bare, 'main')).not.toBe(originBefore); // creator DID push — the teeth
    expect(await tipOf(bare, 'main')).toBe(await headOf(cw));
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// AH-3 — plane orthogonality: the code plane is decoupled from + cannot cascade
// into the content-plane substrate.
// ════════════════════════════════════════════════════════════════════════════

describe('AH-3: code plane ⟂ content plane', () => {
  it('(a) the git-sync pipeline module imports NOTHING from the content-plane substrate', async () => {
    // Structural decoupling guard: run-git-sync.ts is pure git + fs. If a future
    // edit reached into the hyperbee substrate (corestore / wire-outbox / boot),
    // a substrate stall (the EI-681 class) could then wedge code reaching main.
    const src = await readFile(fileURLToPath(new URL('./run-git-sync.ts', import.meta.url)), 'utf8');
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+['"]/.test(l));
    const substrate = importLines.filter((l) =>
      /(sync\/hyperbee|corestore|wire-outbox|wire-presence|\bboot-all\b|\bboot\.ts|substrate)/.test(l),
    );
    expect(substrate).toEqual([]);
  });

  it('(b) a git-push FAILURE is contained to the code plane: status:error, never a throw', async () => {
    const { works } = await makeSharedOrigin('ah3', 'main', ['ah3-w']);
    const [w] = works;
    // Point origin at a non-existent bare repo — the fetch/push will fail.
    await git(['remote', 'set-url', 'origin', join(tmpRoot, 'does-not-exist.git')], w);
    await writeFile(join(w, 'work.ts'), 'export const x = 1;\n');

    // runGitSync NEVER throws — a broken remote surfaces as a structured error
    // (fails CLOSED), not an exception that could unwind a caller's content path.
    const o = await runGitSync('ah3-w', { repoPath: w, config: { branch: 'main', push: true } });
    expect(o.status).toBe('error');
    if (o.status !== 'error') throw new Error('expected error');
    expect(o.errors.length).toBeGreaterThan(0);
    expect(o.errors[0].scope).toBe('superproject');
    // The work is committed locally (not lost) — only the PUSH failed.
    expect(await shx('git', ['status', '--porcelain'], w).then((r) => r.out.trim())).toBe('');
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// AH-4 — non-`main` default branch: git-sync federates to origin/HEAD, not a
// hardcoded `main`.
// ════════════════════════════════════════════════════════════════════════════

describe('AH-4: git-sync federates to the repo default branch (trunk), not a hardcoded main', () => {
  it('a repo whose default branch is `trunk` pushes to trunk; `main` is never created', async () => {
    const { bare, works } = await makeSharedOrigin('ah4', 'trunk', ['ah4-w']);
    const [w] = works;
    // Sanity: the clone checked out trunk (origin/HEAD), there is no main.
    expect(await git(['symbolic-ref', '--short', 'HEAD'], w)).toBe('trunk');

    await writeFile(join(w, 'on-trunk.ts'), 'export const branch = "trunk";\n');
    // No branch in config (defaults to 'main' as the last-resort only): the
    // pipeline resolves HEAD's branch (trunk) first, so it MUST push trunk.
    const o = await runGitSync('ah4-w', { repoPath: w });
    expect(o.status).toBe('synced');
    if (o.status !== 'synced') throw new Error('expected synced');
    expect(o.pushed).toEqual(['superproject']);

    // origin/trunk advanced to our HEAD…
    expect(await tipOf(bare, 'trunk')).toBe(await headOf(w));
    // …and git-sync did NOT invent a `main` ref on origin (no hardcoded branch).
    const mainRef = await shx('git', ['rev-parse', '--verify', 'main'], bare);
    expect(mainRef.code).not.toBe(0);
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// AH-6 — the S0 no-direct-push invariant holds for the WHOLE TREE: a joiner must
// not leak commits to a SUBMODULE's origin either (every joiner/push:false test
// is single-repo; every submodule test is push:true — this closes the gap).
// ════════════════════════════════════════════════════════════════════════════

describe('AH-6: S0 no-direct-push covers submodules — a joiner pushes NOTHING, anywhere', () => {
  it('joiner (push:false) commits in BOTH the submodule and the super LOCALLY; neither origin advances', async () => {
    const joiner = decideGitSyncPush({ joinerSide: true, hasUpstreamRemote: true, permissionsPush: true });
    expect(joiner.push).toBe(false);

    const { superBare, subBare, works } = await makeSuperWithSub('ah6j', ['ah6-joiner']);
    const [jw] = works;
    const superBefore = await tipOf(superBare, 'main');
    const subBefore = await tipOf(subBare, 'main');
    const superHeadBefore = await headOf(jw);
    const subHeadBefore = await headOf(join(jw, 'libs/sub'));

    // The joiner writes code in BOTH repos of the tree.
    await writeFile(join(jw, 'libs/sub', 'sub-change.ts'), 'export const fromJoinerSub = true;\n');
    await writeFile(join(jw, 'super-change.ts'), 'export const fromJoinerSuper = true;\n');

    const o = await runGitSync('ah6-joiner', {
      repoPath: jw,
      config: { branch: 'main', push: joiner.push },
    });

    // A local mirror across the whole tree — but pushed NOTHING.
    expect(o.status).toBe('synced');
    if (o.status !== 'synced') throw new Error('expected synced');
    expect(o.pushed).toEqual([]); // nothing pushed in ANY scope

    // S0: NEITHER origin advanced — the joiner direct-pushed nothing, super OR submodule.
    expect(await tipOf(superBare, 'main')).toBe(superBefore);
    expect(await tipOf(subBare, 'main')).toBe(subBefore);
    // …yet the work IS committed locally in both repos (not lost).
    expect(await headOf(jw)).not.toBe(superHeadBefore);
    expect(await headOf(join(jw, 'libs/sub'))).not.toBe(subHeadBefore);
  }, 45_000);

  it('TEETH: the SAME tree-wide write under the creator decision (push:true) advances BOTH origins', async () => {
    const creator = decideGitSyncPush({ joinerSide: false, hasUpstreamRemote: true, permissionsPush: true });
    expect(creator.push).toBe(true);

    const { superBare, subBare, works } = await makeSuperWithSub('ah6c', ['ah6-creator']);
    const [cw] = works;
    const superBefore = await tipOf(superBare, 'main');
    const subBefore = await tipOf(subBare, 'main');

    await writeFile(join(cw, 'libs/sub', 'sub-change.ts'), 'export const fromCreatorSub = true;\n');
    await writeFile(join(cw, 'super-change.ts'), 'export const fromCreatorSuper = true;\n');

    const o = await runGitSync('ah6-creator', {
      repoPath: cw,
      config: { branch: 'main', push: creator.push },
    });

    expect(o.status).toBe('synced');
    if (o.status !== 'synced') throw new Error('expected synced');
    // Submodule-push-FIRST then the superproject pointer (deepest-first) — both pushed.
    expect(o.pushed).toContain('libs/sub');
    expect(o.pushed).toContain('superproject');
    expect(await tipOf(superBare, 'main')).not.toBe(superBefore); // the teeth
    expect(await tipOf(subBare, 'main')).not.toBe(subBefore);
  }, 45_000);
});
