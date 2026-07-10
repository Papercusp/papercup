/**
 * github-bridge-roundtrip.integration.test.ts — P-007
 * (github-bridge-hive-egress-2026-07-02): the WHOLE bridge, end to end, against
 * real local repos — a legacy member pushing GitHub origin and a P2P member
 * publishing a namespace CONVERGE through ingress → admission → integrator →
 * egress, both directions, plus the fork-PR contribution leg. Testcontainers-
 * free: temp bare repos, GitHub API seams stubbed (pr-host shapes).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/github-bridge-roundtrip.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OpenPrArgs } from '../../pr-host/types';
import { defaultRunGit, deviceNamespaceKey, ensurePotGitRepo, namespaceRefPath, readNamespaceRef } from './storage';
import { STAGING_REF, WORK_REF, integrateMemberHeads } from './integrator';
import { egressCanonicalRefs } from './github-egress';
import { githubOriginDevicePubkey, githubOriginNamespaceKey, ingressOriginBranches } from './github-ingress';
import { admitGithubOriginHead } from './github-ingress-admission';
import { egressRatifiedRequestAsForkPr } from './github-fork-egress';

const LEGACY_EMAIL = '777+legacy@users.noreply.github.com';

function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await defaultRunGit(args, cwd);
  expect(r.code, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

async function commitAs(work: string, email: string, path: string, content: string, msg: string): Promise<string> {
  await writeFile(join(work, path), content);
  await git(work, 'add', '-A');
  await git(work, '-c', 'user.name=t', '-c', `user.email=${email}`, 'commit', '-q', '-m', msg);
  return git(work, 'rev-parse', 'HEAD');
}

describe('github-bridge round trip (P-007: legacy ⇄ P2P convergence + fork-PR leg)', () => {
  let root: string;
  let store: string;
  let origin: string;      // the bare "GitHub" repo
  let legacyWork: string;  // the legacy member's ordinary clone
  let memberWork: string;  // the P2P member's worktree
  const integrator = devicePubkey();
  const member = devicePubkey();
  const scope = { workspaceId: 'ws-rt', potHomeSlug: 'hive-rt' };

  let l1: string;          // legacy base commit
  let l2: string;          // legacy commit racing the P2P work
  let w1: string;          // P2P member's work head
  let ghHead: string;      // admitted github-origin head
  let staging: string;     // integrator-computed staging

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hg-rt-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = join(root, 'store');
    store = await ensurePotGitRepo('hive-rt', 'repo-1');
    origin = join(root, 'origin.git');
    await git(root, 'init', '--bare', '-q', '-b', 'main', origin);

    // The legacy member: an ordinary clone of origin, git-sync style.
    legacyWork = join(root, 'legacy');
    await git(root, 'init', '-q', '-b', 'main', legacyWork);
    l1 = await commitAs(legacyWork, LEGACY_EMAIL, 'legacy.txt', 'v1\n', 'L1');
    await git(legacyWork, 'push', '-q', origin, 'refs/heads/main:refs/heads/main');
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('leg 1 — legacy push INGRESSES into the synthetic namespace (baseline-admitted)', async () => {
    const ing = await ingressOriginBranches({ repoPath: store, remoteUrl: origin, branches: ['main'] });
    expect(ing.errors).toEqual([]);
    expect(ing.updated).toEqual([{ branch: 'main', from: null, to: l1, forced: false }]);

    const adm = await admitGithubOriginHead({ repoPath: store, lastAdmitted: null, head: l1, ...scope });
    expect(adm).toMatchObject({ admit: true, basis: 'baseline' });
    ghHead = l1;
  });

  it('leg 2 — P2P member works FROM the ingressed head; legacy races ahead on origin', async () => {
    // P2P member clones the current origin state and builds on it.
    memberWork = join(root, 'member');
    await git(root, 'clone', '-q', '-b', 'main', origin, memberWork);
    w1 = await commitAs(memberWork, 'member@hive', 'member.txt', 'p2p work\n', 'W1');
    await git(store, 'fetch', memberWork, `+refs/heads/main:${namespaceRefPath(member, WORK_REF)}`);

    // Meanwhile the legacy member lands L2 straight on origin (the race).
    l2 = await commitAs(legacyWork, LEGACY_EMAIL, 'legacy.txt', 'v2\n', 'L2');
    await git(legacyWork, 'push', '-q', origin, 'refs/heads/main:refs/heads/main');

    const ing = await ingressOriginBranches({ repoPath: store, remoteUrl: origin, branches: ['main'] });
    expect(ing.updated).toEqual([{ branch: 'main', from: l1, to: l2, forced: false }]);

    // Second ingress is JUDGED (not baseline): the legacy author id is checked.
    const adm = await admitGithubOriginHead({
      repoPath: store,
      lastAdmitted: ghHead,
      head: l2,
      ...scope,
      isRevoked: async () => false,
    });
    expect(adm).toMatchObject({ admit: true, basis: 'clean' });
    expect(adm.checkedAuthorIds).toEqual([777]);
    ghHead = l2;
  });

  it('leg 3 — the integrator MERGES the github-origin head with the P2P head', async () => {
    const res = await integrateMemberHeads(store, integrator, [
      { deviceHex: githubOriginNamespaceKey(origin), sha: ghHead },
      { deviceHex: deviceNamespaceKey(member), sha: w1 },
    ]);
    expect(res.skippedConflicts).toEqual([]);
    expect(res.advanced).toBe(true);
    staging = res.staging as string;
    expect(staging).toBeTruthy();
    // Staging contains BOTH lines of work.
    expect(await git(store, 'merge-base', '--is-ancestor', l2, staging).then(() => true)).toBe(true);
    expect(await git(store, 'merge-base', '--is-ancestor', w1, staging).then(() => true)).toBe(true);
    expect(await readNamespaceRef(store, integrator, STAGING_REF)).toBe(staging);
  });

  it('leg 4 — staging EGRESSES back to origin/main as a fast-forward (never forced)', async () => {
    const eg = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: staging, remoteRef: 'refs/heads/main' }],
    });
    expect(eg.errors).toEqual([]);
    expect(eg.rejectedNonFF).toEqual([]);
    expect(eg.blockedSecrets).toEqual([]);
    expect(eg.pushed).toEqual([{ remoteRef: 'refs/heads/main', from: l2, to: staging }]);
  });

  it('leg 5 — the legacy member PULLS and sees the P2P member\'s work (converged)', async () => {
    await git(legacyWork, 'pull', '-q', origin, 'main');
    expect(await git(legacyWork, 'rev-parse', 'HEAD')).toBe(staging);
    expect(await readFile(join(legacyWork, 'member.txt'), 'utf8')).toBe('p2p work\n');
    expect(await readFile(join(legacyWork, 'legacy.txt'), 'utf8')).toBe('v2\n');
  });

  it('leg 6 — cycle 2: the next legacy push rides the SAME rails (FF ingress, clean admission)', async () => {
    const l3 = await commitAs(legacyWork, LEGACY_EMAIL, 'legacy.txt', 'v3\n', 'L3');
    await git(legacyWork, 'push', '-q', origin, 'refs/heads/main:refs/heads/main');

    // The namespace advances from its LAST INGRESSED head (l2) — egress moved
    // origin, not the synthetic namespace; l2 → staging → l3 is one FF line.
    const ing = await ingressOriginBranches({ repoPath: store, remoteUrl: origin, branches: ['main'] });
    expect(ing.updated).toEqual([{ branch: 'main', from: ghHead, to: l3, forced: false }]);
    const adm = await admitGithubOriginHead({
      repoPath: store,
      lastAdmitted: ghHead,
      head: l3,
      ...scope,
      isRevoked: async () => false,
    });
    expect(adm).toMatchObject({ admit: true, basis: 'clean' });

    const res = await integrateMemberHeads(store, integrator, [
      { deviceHex: githubOriginNamespaceKey(origin), sha: l3 },
      { deviceHex: deviceNamespaceKey(member), sha: w1 },
    ]);
    // l3 descends from staging (legacy pulled it) → pure fast-forward, no merge.
    expect(res.advanced).toBe(true);
    staging = res.staging as string;
    expect(staging).toBe(l3);

    const eg = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: staging, remoteRef: 'refs/heads/main' }],
    });
    expect(eg.upToDate).toEqual(['refs/heads/main']); // origin already there — no-op tick
  });

  it('leg 7 — the fork-PR contribution leg rides the same store (pr-host seams stubbed)', async () => {
    // A below-steer-tier joiner publishes work on top of staging…
    const joiner = devicePubkey();
    const joinerWork = join(root, 'joiner');
    await git(root, 'clone', '-q', '-b', 'main', origin, joinerWork);
    const j1 = await commitAs(joinerWork, '888+joiner@users.noreply.github.com', 'joiner.txt', 'contribution\n', 'J1');
    await git(store, 'fetch', joinerWork, `+refs/heads/main:${namespaceRefPath(joiner, WORK_REF)}`);

    // …the owner ratifies it, and it egresses as fork→PR (never upstream-direct).
    const fork = join(root, 'fork.git');
    await git(root, 'init', '--bare', '-q', fork);
    const openedPrs: OpenPrArgs[] = [];
    const r = await egressRatifiedRequestAsForkPr({
      repoPath: store,
      potSlug: 'hive-rt',
      request: { devicePubkey: joiner, headSha: j1, state: 'ratified', authorGithubUserId: 888 },
      upstreamRemote: 'github.com/acme/repo-1',
      upstreamOwner: 'acme',
      upstreamRepo: 'repo-1',
      baseBranch: 'main',
      token: 'tkn',
      ensureForkFn: async () => ({ forkOwner: 'joiner', forkFullName: 'joiner/repo-1', created: true }),
      openPrFn: async (args) => {
        openedPrs.push(args);
        return { ok: true as const, data: { url: 'https://github.com/acme/repo-1/pull/7', ref: { number: 7 } } } as never;
      },
      forkPushUrl: () => fork,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    // The joiner's head reached the FORK…
    expect(await git(fork, 'rev-parse', `refs/heads/${r.branch}`)).toBe(j1);
    // …and the PR targets upstream main from the fork owner.
    expect(openedPrs[0]).toMatchObject({ base_ref: 'main', head_owner: 'joiner' });
    // Origin (the "upstream") was NEVER pushed by the fork leg.
    expect(await git(origin, 'rev-parse', 'refs/heads/main')).toBe(staging);
  });
});
