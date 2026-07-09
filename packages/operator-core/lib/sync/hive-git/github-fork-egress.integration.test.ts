/**
 * github-fork-egress.integration.test.ts — P-004 fork egress
 * (github-bridge-hive-egress-2026-07-02; S-5c): a ratified integration-request
 * head egresses fork→PR through the REAL openForkPr orchestration with a real
 * local bare "fork", secrets-gated by the P-001 egress path. GitHub API seams
 * (ensureFork, openPr) are stubbed.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/github-fork-egress.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OpenPrArgs } from '../../pr-host/types';
import { defaultRunGit, ensureHiveGitRepo, namespaceRefPath } from './storage';
import { WORK_REF } from './integrator';
import { egressRatifiedRequestAsForkPr, forkEgressBranch } from './github-fork-egress';

function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

async function commitFile(work: string, path: string, content: string, msg: string): Promise<string> {
  await writeFile(join(work, path), content);
  expect((await defaultRunGit(['add', '-A'], work)).code).toBe(0);
  const c = await defaultRunGit(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], work);
  expect(c.code, c.stderr).toBe(0);
  return (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
}

describe('github-fork-egress (P-004: ratified request → fork branch → PR)', () => {
  let root: string;
  let store: string;
  let fork: string;
  let work: string;
  const device = devicePubkey();
  let headSha: string;
  let secretSha: string;
  const openedPrs: OpenPrArgs[] = [];

  const seams = {
    ensureForkFn: async () => ({ forkOwner: 'contrib', forkFullName: 'contrib/widgets', created: false }),
    openPrFn: async (args: OpenPrArgs) => {
      openedPrs.push(args);
      return {
        ok: true as const,
        data: { url: `https://github.com/acme/widgets/pull/${openedPrs.length}`, ref: { number: openedPrs.length } },
      } as never;
    },
    forkPushUrl: () => fork, // the "fork" is a local bare repo
  };

  const baseInput = () => ({
    repoPath: store,
    potSlug: 'hive-bridge',
    upstreamRemote: 'github.com/acme/widgets',
    upstreamOwner: 'acme',
    upstreamRepo: 'widgets',
    baseBranch: 'main',
    token: 'test-token',
    ...seams,
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hg-forkeg-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = join(root, 'store');
    store = await ensureHiveGitRepo('hive-bridge', 'repo-3');
    fork = join(root, 'fork.git');
    expect((await defaultRunGit(['init', '--bare', '-q', fork], root)).code).toBe(0);
    work = join(root, 'work');
    expect((await defaultRunGit(['init', '-q', '-b', 'main', work], root)).code).toBe(0);

    headSha = await commitFile(work, 'f.txt', 'feature\n', 'c1');
    const pub = await defaultRunGit(['fetch', work, `+refs/heads/main:${namespaceRefPath(device, WORK_REF)}`], store);
    expect(pub.code, pub.stderr).toBe(0);
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('a ratified head lands on the fork and opens a cross-fork PR', async () => {
    const r = await egressRatifiedRequestAsForkPr({
      ...baseInput(),
      request: { devicePubkey: device, headSha, state: 'ratified', authorGithubUserId: 42 },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const branch = forkEgressBranch('hive-bridge', device, headSha);
    expect(r.branch).toBe(branch);
    expect(r.prNumber).toBe(1);
    // The branch really exists on the fork at the ratified sha.
    const onFork = await defaultRunGit(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{object}`], fork);
    expect(onFork.stdout.trim()).toBe(headSha);
    // The PR targeted upstream base with the cross-fork head owner.
    expect(openedPrs).toHaveLength(1);
    expect(openedPrs[0]).toMatchObject({
      remote: 'github.com/acme/widgets',
      head_ref: branch,
      base_ref: 'main',
      head_owner: 'contrib',
    });
  });

  it('re-running the same ratified request is idempotent at the push (upToDate) and re-attempts only the PR', async () => {
    const r = await egressRatifiedRequestAsForkPr({
      ...baseInput(),
      request: { devicePubkey: device, headSha, state: 'ratified' },
    });
    expect(r.ok).toBe(true);
    expect(openedPrs).toHaveLength(2); // PR step ran again; push was upToDate
  });

  it('a PENDING request is refused before any outward action', async () => {
    const prCountBefore = openedPrs.length;
    const r = await egressRatifiedRequestAsForkPr({
      ...baseInput(),
      request: { devicePubkey: device, headSha, state: 'pending' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refused).toBe('not_ratified');
    expect(openedPrs).toHaveLength(prCountBefore);
  });

  it('a sha absent from the store is refused (sha_missing)', async () => {
    const r = await egressRatifiedRequestAsForkPr({
      ...baseInput(),
      request: { devicePubkey: device, headSha: 'f'.repeat(40), state: 'ratified' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refused).toBe('sha_missing');
  });

  it('a secret in the ratified head BLOCKS the fork push — nothing leaves, no PR', async () => {
    const fakeToken = `ghp_${'b'.repeat(40)}`; // constructed, never a literal
    secretSha = await commitFile(work, 'leak.env', `key=${fakeToken}\n`, 'c2-secret');
    const pub = await defaultRunGit(['fetch', work, `+refs/heads/main:${namespaceRefPath(device, WORK_REF)}`], store);
    expect(pub.code, pub.stderr).toBe(0);

    const prCountBefore = openedPrs.length;
    const r = await egressRatifiedRequestAsForkPr({
      ...baseInput(),
      request: { devicePubkey: device, headSha: secretSha, state: 'ratified' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/secrets gate/i);
    expect(openedPrs).toHaveLength(prCountBefore);
    const branch = forkEgressBranch('hive-bridge', device, secretSha);
    const onFork = await defaultRunGit(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{object}`], fork);
    expect(onFork.code).not.toBe(0); // branch never reached the fork
  });
});
