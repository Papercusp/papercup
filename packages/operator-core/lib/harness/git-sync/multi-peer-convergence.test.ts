/**
 * multi-peer-convergence.test.ts — shared-hive-hardening-2026-06-13 B-02
 * (P-004 + P-005): the multi-pusher EDGES the in-process two-peer suite
 * (two-peer-convergence.integration.test.ts) does NOT cover. Real git, no PG —
 * driven at the `runGitSync` level (the pure pipeline), exactly like
 * run-git-sync.test.ts's submodule suites, plus a scope-aware scripted resolver
 * that plays the merge-resolver's documented contract (redo the merge against
 * origin, resolve every conflicted path, push; bounded non-FF retry).
 *
 * Why runGitSync-level and not the action (PG/invoke) level: the action-level
 * escalation + `last_resolver` dedup + dispatch lifecycle are already exhaustively
 * pinned by two-peer-convergence (C1–C4) and git-sync-action.test.ts. What is
 * UNCOVERED — and what the brief asks — is the structural CONVERGENCE property of
 * the fetch→merge→push pipeline itself under interleavings the two-peer suite
 * never reaches:
 *
 *   P-004 multi-peer: D-007 proved convergence with TWO push-capable peers at the
 *   superproject level. This proves it for THREE+ simultaneous peers (disjoint AND
 *   same-file conflicts), and for a submodule conflict ACROSS peers (two peers
 *   sharing both a super-origin and a sub-origin, conflicting INSIDE the
 *   submodule) — the deepest-first + defer-the-superproject logic exercised across
 *   real peer checkouts, not just within one (run-git-sync.test.ts's single-repo
 *   GAP-1/GAP-4). Convergence is structural: origin serializes pushes and every
 *   accepted push descends from the tip its merge consumed, so even a maximally
 *   adversarial resolver (never agreeing with a peer) terminates — no ping-pong.
 *
 *   P-005 history-rewrite: a peer force-pushes a REWRITTEN origin history (a
 *   non-FF that is NOT a simple append divergence). Confirms run-git-sync's
 *   non-FF retry neither loops nor escalates noisily — it ABSORBS the rewrite by
 *   merging it back (origin is the authority of record; a shared-hive history
 *   rewrite is silently re-merged by the next peer, never honored). The
 *   conflicting variant takes the ordinary conflict path. Documented as the
 *   accepted semantic — see the agent-insight git-sync-history-rewrite-absorbed.
 *
 * Real-hardware leg (plan D-003): N-peer convergence under real network latency /
 * clock skew gates on a two-machine rig (P-003); this is the deterministic
 * single-box equivalent that proves the LOGIC.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGitSync, type RunGit } from './run-git-sync';

// ── real-git helpers (subprocess; mirrors two-peer-convergence) ─────────────────

// Custom runGit that disables fleet pre-push hook for testing
const testRunGit: RunGit = (args, cwd) =>
  new Promise((resolve) => {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
    // Clear any GIT_CONFIG that might install the fleet pre-push hook
    delete env.GIT_CONFIG;
    // Inject -c core.hooksPath=<nonexistent> before any git subcommand to disable hooks
    const hooksDisabled = ['-c', 'core.hooksPath=/nonexistent', ...args];
    const child = spawn('git', hooksDisabled, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

function shx(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
    delete env.GIT_CONFIG;
    const hooksDisabled = ['-c', 'core.hooksPath=/nonexistent', ...args];
    const child = spawn('git', hooksDisabled, { cwd, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', (e) => resolve({ code: -1, out, err: err + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await shx(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.err || r.out}`);
  return r.out.trim();
}

// `file://` submodule add/update is blocked by default (CVE-2022-39253) — allow in setup.
const allowFile = ['-c', 'protocol.file.allow=always'];

async function configRepo(dir: string): Promise<void> {
  await git(['config', 'user.email', 'mpc-it@example.com'], dir);
  await git(['config', 'user.name', 'mpc integration'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
  await git(['config', 'core.hooksPath', '/nonexistent'], dir);
}

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'mpc-'));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

/** One bare origin (seeded `shared.txt`) + N working clones. */
async function makeSharedOrigin(name: string, clones: string[]): Promise<{ bare: string; works: string[] }> {
  const bare = join(tmpRoot, `${name}-origin.git`);
  await mkdir(bare, { recursive: true });
  await git(['init', '--bare', '-b', 'main'], bare);
  const seed = join(tmpRoot, `${name}-seed`);
  await git(['clone', bare, seed], tmpRoot);
  await configRepo(seed);
  await writeFile(join(seed, 'shared.txt'), 'seed\n');
  await git(['add', '-A'], seed);
  await git(['commit', '--no-verify', '-m', 'seed'], seed);
  await git(['push', '--no-verify', '-u', 'origin', 'main'], seed);
  const works: string[] = [];
  for (const c of clones) {
    const dir = join(tmpRoot, c);
    await git(['clone', bare, dir], tmpRoot);
    await configRepo(dir);
    works.push(dir);
  }
  await rm(seed, { recursive: true, force: true });
  return { bare, works };
}

/** A bare super-origin (with a submodule at `libs/sub` whose own bare origin is
 *  shared) + N super clones with the submodule checked out. Models a shared hive
 *  whose tree includes a submodule both peers can push. */
async function makeSharedOriginWithSubmodule(
  name: string,
  clones: string[],
): Promise<{ superBare: string; subBare: string; works: string[] }> {
  const superBare = join(tmpRoot, `${name}-super.git`);
  const subBare = join(tmpRoot, `${name}-sub.git`);
  await git(['init', '--bare', '-b', 'main'], await mkdir(superBare, { recursive: true }).then(() => superBare));
  await git(['init', '--bare', '-b', 'main'], await mkdir(subBare, { recursive: true }).then(() => subBare));

  // seed the submodule origin
  const subSeed = join(tmpRoot, `${name}-subseed`);
  await git(['clone', subBare, subSeed], tmpRoot);
  await configRepo(subSeed);
  await writeFile(join(subSeed, 'mod.txt'), 'mod-v1\n');
  await git(['add', '-A'], subSeed);
  await git(['commit', '--no-verify', '-m', 'sub init'], subSeed);
  await git(['push', '--no-verify', '-u', 'origin', 'main'], subSeed);

  // seed the super origin with the submodule wired in
  const superSeed = join(tmpRoot, `${name}-superseed`);
  await git(['clone', superBare, superSeed], tmpRoot);
  await configRepo(superSeed);
  await git([...allowFile, 'submodule', 'add', subBare, 'libs/sub'], superSeed);
  await configRepo(join(superSeed, 'libs/sub'));
  await git(['add', '-A'], superSeed);
  await git(['commit', '--no-verify', '-m', 'super init + submodule'], superSeed);
  await git(['push', '--no-verify', '-u', 'origin', 'main'], superSeed);

  const works: string[] = [];
  for (const c of clones) {
    const dir = join(tmpRoot, c);
    await git(['clone', superBare, dir], tmpRoot);
    await configRepo(dir);
    await git([...allowFile, 'submodule', 'update', '--init', '--recursive'], dir);
    await configRepo(join(dir, 'libs/sub'));
    works.push(dir);
  }
  await rm(subSeed, { recursive: true, force: true });
  await rm(superSeed, { recursive: true, force: true });
  return { superBare, subBare, works };
}

const headOf = (dir: string): Promise<string> => git(['rev-parse', 'HEAD'], dir);
const originTip = (bare: string): Promise<string> => git(['rev-parse', 'main'], bare);
const filesAt = (bare: string): Promise<string> => git(['ls-tree', '-r', '--name-only', 'main'], bare);

// ── the scope-aware scripted resolver (the merge-resolver's contract) ───────────
//
// On a git-sync conflict, runGitSync aborts to a CLEAN tree and reports the
// conflicted scope(s). The real merge-resolver then redoes the merge in each
// conflicted repo and pushes. This scripts that, maximally ADVERSARIALLY (every
// peer writes peer-distinct content so it never agrees with a rival's resolution —
// the worst case for cross-peer agreement), with a bounded non-FF retry. A text
// conflict is resolved by overwrite; a submodule GITLINK conflict by staging the
// locally-checked-out (already-reconciled) submodule commit. Throws after 8
// passes — that would be the ping-pong the brief hunts for.
async function resolveScope(scopeDir: string, marker: string): Promise<number> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    await git(['fetch', 'origin', 'main'], scopeDir);
    const m = await shx(['merge', '--no-edit', 'origin/main'], scopeDir);
    if (m.code !== 0) {
      const files = (await shx(['diff', '--name-only', '--diff-filter=U'], scopeDir)).out
        .trim()
        .split('\n')
        .filter(Boolean);
      if (files.length === 0) {
        await shx(['merge', '--abort'], scopeDir);
        throw new Error(`resolve(${marker}): merge failed with no conflicted paths: ${m.err || m.out}`);
      }
      for (const f of files) {
        const stage = (await shx(['ls-files', '--stage', '--', f], scopeDir)).out;
        if (/^160000 /.test(stage)) {
          // gitlink: the working-tree submodule is already at this peer's reconciled
          // commit (it was resolved deepest-first in a prior pass) — stage it as-is.
          await git(['add', '--', f], scopeDir);
        } else {
          await writeFile(join(scopeDir, f), `resolved by ${marker} (pass ${attempt})\n`);
          await git(['add', '--', f], scopeDir);
        }
      }
      await git(['commit', '--no-verify', '-m', `resolve(${marker}) pass ${attempt}`], scopeDir);
    }
    const p = await shx(['push', '--no-verify', 'origin', 'HEAD:main'], scopeDir);
    if (p.code === 0) return attempt;
  }
  throw new Error(`resolve(${marker}): no convergence within 8 passes — PING-PONG`);
}

/**
 * Tick a fleet of peers to quiescence against `bare`. Each round runs
 * `runGitSync` for every peer; a peer that conflicts is handed to the scope-aware
 * resolver (which pushes its resolution to origin). CONVERGED = a full round that
 * (a) hit no conflict and (b) left EVERY peer's HEAD at the current origin tip —
 * because mid-sweep pushes leave earlier peers a tick behind, a no-conflict round
 * alone is not convergence; the laggards need one more clean tick to fast-forward.
 * Bounded at `maxRounds` — exceeding it is the ping-pong / divergence the P-004
 * brief looks for. Returns observed counters.
 */
async function convergeFleet(
  peers: Array<{ slug: string; dir: string }>,
  bare: string,
  opts: { maxRounds?: number } = {},
): Promise<{ rounds: number; conflicts: number; resolverPasses: number }> {
  const maxRounds = opts.maxRounds ?? 20;
  let conflicts = 0;
  let resolverPasses = 0;
  for (let round = 1; round <= maxRounds; round++) {
    let anyConflict = false;
    for (const peer of peers) {
      const out = await runGitSync(peer.slug, { runGit: testRunGit, repoPath: peer.dir, config: { branch: 'main' } });
      if (out.status === 'conflict') {
        anyConflict = true;
        conflicts += 1;
        for (const c of out.conflicts) {
          const scopeDir = c.scope === 'superproject' ? peer.dir : join(peer.dir, c.scope);
          resolverPasses += await resolveScope(scopeDir, `${peer.slug}-r${round}`);
        }
      } else if (out.status === 'error') {
        throw new Error(`peer ${peer.slug} errored (not a recoverable conflict): ${JSON.stringify(out.errors)}`);
      }
    }
    if (!anyConflict) {
      const tip = await originTip(bare);
      const heads = await Promise.all(peers.map((p) => headOf(p.dir)));
      if (heads.every((h) => h === tip)) return { rounds: round, conflicts, resolverPasses };
    }
  }
  throw new Error(`fleet did not converge within ${maxRounds} rounds — DIVERGENCE / PING-PONG`);
}

// ════════════════════════════════════════════════════════════════════════════
// P-004 — N-peer convergence beyond the two-peer suite
// ════════════════════════════════════════════════════════════════════════════

describe('P-004: 3+ simultaneous peers converge (superproject)', () => {
  it('THREE peers with DISJOINT edits → union on origin, zero conflicts', async () => {
    const { bare, works } = await makeSharedOrigin('n3disjoint', ['a', 'b', 'c']);
    const [a, b, c] = works;
    await writeFile(join(a, 'from-a.txt'), 'a\n');
    await writeFile(join(b, 'from-b.txt'), 'b\n');
    await writeFile(join(c, 'from-c.txt'), 'c\n');

    const stats = await convergeFleet([
      { slug: 'na', dir: a },
      { slug: 'nb', dir: b },
      { slug: 'nc', dir: c },
    ], bare);

    expect(stats.conflicts).toBe(0); // disjoint files never conflict
    const tip = await originTip(bare);
    for (const w of works) expect(await headOf(w)).toBe(tip);
    const files = await filesAt(bare);
    for (const f of ['from-a.txt', 'from-b.txt', 'from-c.txt']) expect(files).toContain(f);
  }, 60_000);

  it('THREE peers editing the SAME file → conflicts resolve, all converge to one tip (no ping-pong)', async () => {
    const { bare, works } = await makeSharedOrigin('n3conflict', ['a', 'b', 'c']);
    const [a, b, c] = works;
    await writeFile(join(a, 'shared.txt'), 'A version\n');
    await writeFile(join(b, 'shared.txt'), 'B version\n');
    await writeFile(join(c, 'shared.txt'), 'C version\n');

    const stats = await convergeFleet([
      { slug: 'ca', dir: a },
      { slug: 'cb', dir: b },
      { slug: 'cc', dir: c },
    ], bare);

    // two of the three lose the race against the first pusher and must resolve.
    expect(stats.conflicts).toBeGreaterThanOrEqual(2);
    const tip = await originTip(bare);
    for (const w of works) expect(await headOf(w)).toBe(tip);
    // origin holds exactly one resolved value of the shared file — the fleet agreed.
    const content = await git(['show', 'main:shared.txt'], bare);
    expect(content).toMatch(/^resolved by /);
  }, 90_000);
});

// ════════════════════════════════════════════════════════════════════════════
// P-004 — a submodule conflict ACROSS peers
// ════════════════════════════════════════════════════════════════════════════

describe('P-004: cross-peer submodule conflict defers the superproject, then converges', () => {
  it('the losing peer conflicts INSIDE the submodule, does NOT publish a broken gitlink, then the fleet converges', async () => {
    const { superBare, subBare, works } = await makeSharedOriginWithSubmodule('xsub', ['a', 'b']);
    const [a, b] = works;

    // both peers conflictingly edit the SAME file inside the submodule
    await writeFile(join(a, 'libs/sub', 'mod.txt'), 'A mod\n');
    await writeFile(join(b, 'libs/sub', 'mod.txt'), 'B mod\n');

    // peer A wins: its submodule commit + superproject pointer bump land on both origins
    const outA = await runGitSync('xa', { runGit: testRunGit, repoPath: a, config: { branch: 'main' } });
    expect(outA.status).toBe('synced');
    const superTipAfterA = await originTip(superBare);
    const subTipAfterA = await originTip(subBare);

    // peer B loses: its submodule merge CONFLICTS; the superproject is DEFERRED so no
    // gitlink pointing at an unpushed/again submodule state is published.
    const outB = await runGitSync('xb', { runGit: testRunGit, repoPath: b, config: { branch: 'main' } });
    expect(outB.status).toBe('conflict');
    if (outB.status === 'conflict') {
      expect(outB.conflicts.map((c) => c.scope)).toContain('libs/sub');
      expect(outB.pushed).not.toContain('superproject');
    }
    // the superproject origin is UNTOUCHED by B's deferred tick (still exactly A's push).
    expect(await originTip(superBare)).toBe(superTipAfterA);
    // B's tree is clean — the conflicted submodule merge was aborted, no half-merge.
    expect(await git(['status', '--porcelain', '--untracked-files=no'], join(b, 'libs/sub'))).toBe('');

    // now drive the fleet to quiescence (B resolves the submodule, both reconcile the super).
    const stats = await convergeFleet([
      { slug: 'xa', dir: a },
      { slug: 'xb', dir: b },
    ], superBare);

    // the submodule origin advanced past A's commit — B's conflicting edit was reconciled.
    expect(await originTip(subBare)).not.toBe(subTipAfterA);
    const subFiles = await git(['ls-tree', '-r', '--name-only', 'main'], subBare);
    expect(subFiles).toContain('mod.txt');
    // both peers' superprojects converged to the one origin tip, whose gitlink resolves.
    const tip = await originTip(superBare);
    expect(await headOf(a)).toBe(tip);
    expect(await headOf(b)).toBe(tip);
    // the published superproject pointer is reachable on the submodule origin (no broken pin).
    const pointer = await git(['rev-parse', 'main:libs/sub'], superBare);
    await git(['cat-file', '-e', `${pointer}^{commit}`], subBare);
    expect(stats.rounds).toBeLessThan(20); // bounded — no ping-pong
  }, 120_000);
});

// ════════════════════════════════════════════════════════════════════════════
// P-005 — force-push / history-rewrite by one peer
// ════════════════════════════════════════════════════════════════════════════

describe('P-005: a force-pushed history rewrite is ABSORBED or LOUDLY errors — never a loop / phantom resolver', () => {
  /** Advance origin by one commit and bring a clone up to that tip (ff). */
  async function commitAndPush(dir: string, file: string, body: string, msg: string): Promise<void> {
    await writeFile(join(dir, file), body);
    await git(['add', '-A'], dir);
    await git(['commit', '--no-verify', '-m', msg], dir);
    await git(['push', '--no-verify', 'origin', 'HEAD:main'], dir);
  }

  it('a REWIND (force-push dropping a commit) is reverted: a peer still holding the commit re-pushes it ff (synced, dropped content reappears)', async () => {
    const { bare, works } = await makeSharedOrigin('rwind', ['rewriter', 'victim']);
    const [rewriter, victim] = works;

    // origin advances seed→X (X adds x.txt); the victim fast-forwards to X too.
    await commitAndPush(rewriter, 'x.txt', 'x-commit\n', 'commit X');
    await git(['fetch', 'origin', 'main'], victim);
    await git(['merge', '--ff-only', 'origin/main'], victim); // victim now holds X

    // the rewriter REWINDS origin back to the seed (a non-FF rewrite — origin moves
    // from X to its ancestor, dropping X) and force-pushes.
    await git(['reset', '--hard', 'HEAD~1'], rewriter); // back to seed
    await git(['push', '--no-verify', '--force', 'origin', 'HEAD:main'], rewriter);

    // the victim — which still has X — makes a normal edit and git-syncs. Its merge of
    // origin/main (now the seed, an ANCESTOR of victim) is a no-op, and its push
    // fast-forwards origin back up THROUGH X: the dropped commit is re-introduced.
    await writeFile(join(victim, 'v.txt'), 'victim work\n');
    const out = await runGitSync('rwind-victim', { runGit: testRunGit, repoPath: victim, config: { branch: 'main' } });
    expect(out.status).toBe('synced');

    expect(await headOf(victim)).toBe(await originTip(bare));
    const files = await filesAt(bare);
    expect(files).toContain('x.txt'); // the DROPPED commit's content reappeared — rewind reverted
    expect(files).toContain('v.txt'); // the victim's own work landed
  }, 60_000);

  it('a CONFLICTING rewrite takes the ordinary conflict path (aborts clean, reports) — not an error loop', async () => {
    const { works } = await makeSharedOrigin('rwconf', ['rewriter', 'victim']);
    const [rewriter, victim] = works;

    // the rewriter rewinds to seed and force-pushes a CONFLICTING change to shared.txt.
    await git(['reset', '--hard', 'HEAD'], rewriter); // (already at seed)
    await writeFile(join(rewriter, 'shared.txt'), 'rewriter shared\n');
    await git(['add', '-A'], rewriter);
    await git(['commit', '--no-verify', '-m', 'rewritten conflicting'], rewriter);
    await git(['push', '--no-verify', '--force', 'origin', 'HEAD:main'], rewriter);

    // the victim holds its own conflicting edit of the same file.
    await writeFile(join(victim, 'shared.txt'), 'victim shared\n');
    const out = await runGitSync('rwconf-victim', { runGit: testRunGit, repoPath: victim, config: { branch: 'main' } });

    // ordinary conflict path (a merge-resolver takes it from here) — NOT a wedge.
    expect(out.status).toBe('conflict');
    if (out.status === 'conflict') {
      expect(out.conflicts.map((c) => c.scope)).toContain('superproject');
      expect(out.conflicts[0].conflictedFiles).toContain('shared.txt');
    }
    expect(await git(['status', '--porcelain', '--untracked-files=no'], victim)).toBe('');
    await expect(git(['rev-parse', '--verify', 'MERGE_HEAD'], victim)).rejects.toThrow();
  }, 60_000);

  it('an UNRELATED-history rewrite (orphan force-push) is a LOUD error — classified error (no conflicted paths), never a phantom merge-resolver', async () => {
    const { works } = await makeSharedOrigin('rworphan', ['rewriter', 'victim']);
    const [rewriter, victim] = works;

    // the rewriter replaces origin with a brand-new ROOT history (no common ancestor).
    await git(['checkout', '--orphan', 'orphan'], rewriter);
    await git(['rm', '-rf', '.'], rewriter).catch(() => {});
    await writeFile(join(rewriter, 'rewritten.txt'), 'unrelated root\n');
    await git(['add', '-A'], rewriter);
    await git(['commit', '--no-verify', '-m', 'unrelated root'], rewriter);
    await git(['push', '--no-verify', '--force', 'origin', 'HEAD:main'], rewriter);

    await writeFile(join(victim, 'v.txt'), 'victim work\n');
    const out = await runGitSync('rworphan-victim', { runGit: testRunGit, repoPath: victim, config: { branch: 'main' } });

    // git refuses to merge unrelated histories → runGitSync classifies it as ERROR
    // (a merge that failed with NO conflicted paths), which routes to the loud EI-18
    // git-sync-error escalation — crucially NOT 'conflict', so NO merge-resolver is
    // dispatched at an unresolvable history, and NOT a silent loop.
    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors.map((e) => e.scope)).toContain('superproject');
      expect(out.errors[0].message).toMatch(/no conflicted paths|unrelated histories/i);
    }
    expect(await git(['status', '--porcelain', '--untracked-files=no'], victim)).toBe('');
  }, 60_000);
});
