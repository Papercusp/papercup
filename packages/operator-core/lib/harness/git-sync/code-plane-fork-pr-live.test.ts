/**
 * code-plane-fork-pr-live.test.ts — Brief AH G1: the LIVE witness of the
 * NON-collaborator contribution path against real GitHub. Closes the one YELLOW
 * caveat the hermetic suite leaves open: ensureFork + openForkPr are unit-tested
 * with mocked Octokit, but the literal "a non-collaborator's code becomes a
 * cross-fork PR on the owner's repo, and the owner's branch is NEVER directly
 * pushed" had never run against GitHub.
 *
 * GATED: skips unless `PAPERCUSP_LIVE_FORK_PR=1` — normal CI never runs it (no
 * network, no GitHub side effects). When enabled it uses TWO real gh identities
 * already on the box, resolved per-call WITHOUT switching the active gh account
 * (so the live operator / git-sync stay on their identity):
 *   - upstream owner  = `papercupai`  (owns the fixture repo papercupai/shared-hive-test)
 *   - joiner (no write) = `aviynw`     (forks it + opens the cross-fork PR)
 *
 * Side effects (cleaned up in afterAll where the token scope allows): a fork
 * under the joiner account (persists — reused idempotently by ensureFork), a
 * feature branch on that fork (deleted), and one PR (closed). The fixture
 * upstream + fork are intentional persistent test fixtures (the brief's "B9
 * shared-hive-test repo"); the box's gh tokens lack `delete_repo` scope so the
 * repos themselves are left in place for reuse.
 *
 * Run: PAPERCUSP_LIVE_FORK_PR=1 npx vitest run lib/harness/git-sync/code-plane-fork-pr-live.test.ts
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Octokit } from '@octokit/rest';

import { ensureFork } from '../ensure-fork';
import { openForkPr } from '../open-fork-pr';
import type { OpenPrArgs, Pr, PrHostResult } from '../../pr-host/types';

const LIVE = process.env.PAPERCUSP_LIVE_FORK_PR === '1';
const UPSTREAM_OWNER = 'papercupai';
const UPSTREAM_REPO = 'shared-hive-test';

/** Resolve a specific gh account's token WITHOUT switching the active account. */
function ghToken(user: string): string {
  return execFileSync('gh', ['auth', 'token', '--user', user], { encoding: 'utf8' }).trim();
}

async function git(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let err = '';
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} (${code}): ${err}`))));
  });
}

describe.skipIf(!LIVE)('AH G1 live: a non-collaborator contributes via fork→PR, never direct-pushing the owner main', () => {
  let tmpRoot: string;
  let aviynwToken: string;
  let aviynw: Octokit;
  let joinerLogin: string;
  let clone: string;
  let featureBranch: string;
  let upstreamMainBefore: string;
  let prNumber: number | undefined;

  beforeAll(async () => {
    aviynwToken = ghToken('aviynw');
    aviynw = new Octokit({ auth: aviynwToken });
    joinerLogin = (await aviynw.rest.users.getAuthenticated()).data.login;

    // Record the owner's main tip BEFORE — the S0 invariant compares against it.
    const before = await aviynw.rest.repos.getBranch({ owner: UPSTREAM_OWNER, repo: UPSTREAM_REPO, branch: 'main' });
    upstreamMainBefore = before.data.commit.sha;

    // The joiner's local work: clone the public upstream, branch, commit code.
    tmpRoot = await mkdtemp(join(tmpdir(), 'ah-forkpr-'));
    clone = join(tmpRoot, 'clone');
    await git(['clone', `https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}.git`, clone], tmpRoot);
    await git(['config', 'user.email', 'ah-live@example.com'], clone);
    await git(['config', 'user.name', 'AH live witness'], clone);
    await git(['config', 'commit.gpgsign', 'false'], clone);
    featureBranch = `harness/ah-witness-${Date.now()}`;
    await git(['checkout', '-b', featureBranch], clone);
    await writeFile(join(clone, 'joiner-contribution.ts'), `export const fromJoiner = ${Date.now()};\n`);
    await git(['add', '-A'], clone);
    await git(['commit', '--no-verify', '-m', 'joiner code contribution (AH fork→PR live witness)'], clone);
  }, 120_000);

  afterAll(async () => {
    // Best-effort cleanup (repo scope suffices for these; delete_repo is not held).
    try {
      if (prNumber != null) {
        await aviynw.rest.pulls.update({ owner: UPSTREAM_OWNER, repo: UPSTREAM_REPO, pull_number: prNumber, state: 'closed' });
      }
    } catch {
      /* best-effort */
    }
    try {
      await aviynw.rest.git.deleteRef({ owner: joinerLogin, repo: UPSTREAM_REPO, ref: `heads/${featureBranch}` });
    } catch {
      /* best-effort */
    }
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  it('ensureFork forks under the JOINER account; openForkPr opens a cross-fork PR; the owner main is NEVER directly pushed (S0)', async () => {
    // 1. ensureFork as the joiner → a fork under the joiner's OWN account, never the upstream owner.
    const fork = await ensureFork({ upstreamOwner: UPSTREAM_OWNER, upstreamRepo: UPSTREAM_REPO, octokit: aviynw });
    expect(fork.forkOwner).toBe(joinerLogin);
    expect(fork.forkOwner).not.toBe(UPSTREAM_OWNER); // D-007: the user's OWN fork, not a Papercusp-owned one
    expect(fork.forkFullName).toBe(`${joinerLogin}/${UPSTREAM_REPO}`);

    // 2. openForkPr: push the feature branch to the joiner's fork + open the cross-fork PR (joiner-authored).
    const res = await openForkPr({
      upstreamRemote: `github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}`,
      upstreamOwner: UPSTREAM_OWNER,
      upstreamRepo: UPSTREAM_REPO,
      baseBranch: 'main',
      featureBranch,
      localRepoPath: clone,
      title: `AH fork→PR live witness ${featureBranch}`,
      body: 'Automated Brief AH live witness — a non-collaborator contribution as a cross-fork PR (closed automatically).',
      token: aviynwToken,
      // Drive ensureFork + the PR open as the JOINER (the box's active account is papercupai).
      ensureForkFn: (o) => ensureFork({ ...o, octokit: aviynw }),
      openPrFn: async (args: OpenPrArgs): Promise<PrHostResult<Pr>> => {
        const { data } = await aviynw.rest.pulls.create({
          owner: UPSTREAM_OWNER,
          repo: UPSTREAM_REPO,
          title: args.title,
          body: args.body ?? '',
          head: args.head_owner ? `${args.head_owner}:${args.head_ref}` : args.head_ref,
          base: args.base_ref,
        });
        return { ok: true, data: { ref: { number: data.number }, url: data.html_url } } as unknown as PrHostResult<Pr>;
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    prNumber = res.prNumber;
    expect(res.forkOwner).toBe(joinerLogin);

    // 3. The PR is a genuine CROSS-FORK PR: head lives in the joiner's fork, base is the owner's upstream main.
    const pr = (await aviynw.rest.pulls.get({ owner: UPSTREAM_OWNER, repo: UPSTREAM_REPO, pull_number: res.prNumber })).data;
    expect(pr.head.repo?.owner.login).toBe(joinerLogin);
    expect(pr.base.repo.owner.login).toBe(UPSTREAM_OWNER);
    expect(pr.base.ref).toBe('main');
    expect(pr.state).toBe('open');

    // 4. THE S0 INVARIANT: the owner's main is byte-identical to before — the joiner's code arrived
    //    ONLY as a PR, never as a direct push to the owner's branch.
    const after = (await aviynw.rest.repos.getBranch({ owner: UPSTREAM_OWNER, repo: UPSTREAM_REPO, branch: 'main' })).data;
    expect(after.commit.sha).toBe(upstreamMainBefore);

    console.log(`[AH G1 live] cross-fork PR opened: ${pr.html_url} (head ${joinerLogin}:${featureBranch} → ${UPSTREAM_OWNER}:main); owner main unchanged @ ${upstreamMainBefore.slice(0, 8)}`);
  }, 180_000);
});
