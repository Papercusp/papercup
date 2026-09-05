import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import { defaultRunGit, defaultRunGitStdin, readNamespaceRef, deviceNamespaceKey } from './storage';
import { integrateMemberHeads, STAGING_REF } from './integrator';
import { promoteRelease, signGreenAttestation } from './release-promotion';
import { egressRatifiedRequestAsForkPr } from './github-fork-egress';
import { hiveEffectFixture } from './hive-effect-authority.fixture';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function repo() {
  const path = await mkdtemp(join(tmpdir(), 'f6-recipient-')); dirs.push(path);
  const run = async (args: string[]) => {
    const r = await defaultRunGit(args, path);
    expect(r.code, r.stderr).toBe(0); return r.stdout.trim();
  };
  await run(['init', '--bare']);
  const treeResult = await defaultRunGitStdin(['hash-object', '-t', 'tree', '-w', '--stdin'], path, '');
  expect(treeResult.code, treeResult.stderr.toString()).toBe(0);
  const tree = treeResult.stdout.toString('utf8').trim();
  const sha = await run(['-c', 'user.name=F6', '-c', 'user.email=f6@example.invalid', 'commit-tree', tree, '-m', 'F6']);
  return { path, sha, run };
}

describe('F6 protected Git recipients', () => {
  it('two isolated OS-process writers cannot both publish to the same Git remote', async () => {
    const source = await repo(); const remote = await repo();
    const owner = generateEd25519KeypairDer(); const peer = generateEd25519KeypairDer();
    const scope = { hive_id: owner.pubkeyBase64, repo_key: 'repo' };
    const script = `
      import { readFileSync } from 'node:fs';
      import { egressCanonicalRefs } from ${JSON.stringify(new URL('./github-egress.ts', import.meta.url).href)};
      import { signWithPrivateKeyDer } from ${JSON.stringify(new URL('../../identity/ed25519.ts', import.meta.url).href)};
      import { electFleetLeader } from ${JSON.stringify(new URL('../../p2p/fleet-leader-election.ts', import.meta.url).href)};
      const p = JSON.parse(readFileSync(0, 'utf8'));
      const election = electFleetLeader({scope:{kind:'fleet',ownerGithubUserId:1,slug:'fleet'},rosterMemberUids:new Set([1]),
        rosterEpoch:7,presence:[],self:{devicePubkey:p.device,githubUserId:1},incumbent:null,nowMs:1000,staleMs:90000,leaseMs:30000});
      const authority = { ...p.scope, sign: async bytes => signWithPrivateKeyDer(Buffer.from(p.key, 'base64'), bytes) };
      const r = await egressCanonicalRefs({repoPath:p.repo,remoteUrl:p.remote,refs:[{sha:p.sha,remoteRef:p.ref}],
        scope:p.scope,authority,scanSecrets:false});
      process.stdout.write(JSON.stringify({isSelf:election.isSelf,rosterEpoch:election.rosterEpoch,ok:r.ok,pushed:r.pushed,errors:r.errors}));
    `;
    const runWriter = (key: Buffer, device: string, ref: string) => {
      const p = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        input: JSON.stringify({ scope, device, key: key.toString('base64'), repo: source.path, remote: remote.path, sha: source.sha, ref }),
        encoding: 'utf8', timeout: 25_000,
      });
      expect(p.status, p.stderr).toBe(0);
      return JSON.parse(p.stdout);
    };
    const stale = runWriter(peer.privateKeyDer, peer.pubkeyBase64, 'refs/heads/peer');
    const valid = runWriter(owner.privateKeyDer, owner.pubkeyBase64, 'refs/heads/owner');
    expect(stale).toMatchObject({ isSelf: true, rosterEpoch: 7 });
    expect(valid).toMatchObject({ isSelf: true, rosterEpoch: 7 });
    expect(stale.ok).toBe(false); expect(stale.pushed).toEqual([]);
    expect(valid.ok, JSON.stringify(valid)).toBe(true); expect(valid.pushed).toHaveLength(1);
    expect((await defaultRunGit(['show-ref', '--verify', 'refs/heads/peer'], remote.path)).code).not.toBe(0);
    expect(await remote.run(['rev-parse', 'refs/heads/owner'])).toBe(source.sha);
  });

  it('integration and green release require the owner at the actual update-ref boundary', async () => {
    const r = await repo(); const owner = hiveEffectFixture(); const peer = generateEd25519KeypairDer().pubkeyBase64;
    const heads = [{ deviceHex: deviceNamespaceKey(peer), sha: r.sha }];
    await expect(integrateMemberHeads(r.path, peer, heads)).rejects.toThrow('owning hive key');
    expect(await readNamespaceRef(r.path, peer, STAGING_REF)).toBeNull();
    expect((await integrateMemberHeads(r.path, peer, heads, owner)).advanced).toBe(true);
    const proof = await signGreenAttestation({ repoKey: 'repo', stagingSha: r.sha, signerPubkeyBase64: owner.hiveId, nowMs: 1 }, owner.authority.sign);
    const rule = { allow: [owner.hiveId], threshold: 1 };
    expect(await promoteRelease(r.path, peer, 'repo', r.sha, [proof], rule)).toMatchObject({ promoted: false, reason: 'missing-hive-authority' });
    expect((await promoteRelease(r.path, peer, 'repo', r.sha, [proof], rule, owner)).promoted).toBe(true);
  });

  it('a ratified fork request without owner authority creates no fork or PR', async () => {
    const r = await repo(); const ensureForkFn = vi.fn(); const openPrFn = vi.fn();
    const result = await egressRatifiedRequestAsForkPr({ repoPath: r.path, potSlug: 'hive',
      request: { devicePubkey: hiveEffectFixture().hiveId, headSha: r.sha, state: 'ratified' },
      upstreamRemote: 'github.com/acme/repo', upstreamOwner: 'acme', upstreamRepo: 'repo', baseBranch: 'main',
      token: 'test-token', ensureForkFn, openPrFn });
    expect(result.ok).toBe(false); expect(ensureForkFn).not.toHaveBeenCalled(); expect(openPrFn).not.toHaveBeenCalled();
  });

  it('rechecks authority after a successful fork push before opening the PR', async () => {
    const source = await repo(); const fork = await repo(); const owner = hiveEffectFixture();
    let available = true;
    const openPrFn = vi.fn();
    const runGit: typeof defaultRunGit = async (...args) => {
      const r = await defaultRunGit(...args);
      if (args[0][0] === 'push' && args[0][1] !== '--dry-run' && r.code === 0) available = false;
      return r;
    };
    const result = await egressRatifiedRequestAsForkPr({ ...owner, repoPath: source.path, potSlug: 'hive',
      authority: { ...owner.authority, sign: async bytes => {
        if (!available) throw new Error('owner key unavailable');
        return owner.authority.sign(bytes);
      } },
      request: { devicePubkey: owner.hiveId, headSha: source.sha, state: 'ratified' },
      upstreamRemote: 'github.com/acme/repo', upstreamOwner: 'acme', upstreamRepo: 'repo', baseBranch: 'main',
      token: 'test-token', runGit, forkPushUrl: () => fork.path,
      ensureForkFn: async () => ({ forkOwner: 'contrib', forkFullName: 'contrib/repo', created: false }), openPrFn,
    });
    expect(available).toBe(false);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('open PR authorization failed') });
    expect(openPrFn).not.toHaveBeenCalled();
  });
});
