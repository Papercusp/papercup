import { hiveEffectFixture } from './hive-effect-authority.fixture';
/**
 * release-promotion.integration.test.ts — G-5b two-speed gate against a REAL
 * temp bare repo (P-034). Acceptance pinned: release advances ONLY with a
 * proof satisfying the crefs rule (threshold DISTINCT allow-listed signers over
 * exactly that sha), and only fast-forward.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/release-promotion.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensurePotGitRepo } from './storage';
import {
  type GreenAttestation,
  type ReleaseRule,
  promoteRelease as promoteReleaseUnderTest,
  readRelease,
  satisfiesCrefsRule,
  signGreenAttestation,
} from './release-promotion';

function identity() {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkeyBase64, sign: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) };
}

/** Files → tree → commit in the bare repo (isolated index). */
async function commit(repo: string, files: Record<string, string>, parent?: string): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'mk-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    for (const [name, content] of Object.entries(files)) {
      const f = join(dir, 'blob');
      await writeFile(f, content, 'utf8');
      const sha = execFileSync('git', ['hash-object', '-w', f], { cwd: repo, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${sha},${name}`], { cwd: repo, env });
    }
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim();
    const args = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'c'];
    if (parent) args.push('-p', parent);
    const c = await defaultRunGit(args, repo);
    expect(c.code, c.stderr).toBe(0);
    return c.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('pot-git release promotion (G-5b, real bare repo)', () => {
  let root: string;
  let repo: string;
  const integ = identity(); // integrator device
  const greenBot = identity(); // DG-5 aggregator identity
  const owner = identity(); // hive owner identity
  const stranger = identity(); // NOT in allow
  let rule: ReleaseRule;
  let shaA: string;
  let shaB: string;

  const REPO_KEY = 'repo-1';

  async function proof(sha: string, signers: ReturnType<typeof identity>[], repoKey = REPO_KEY): Promise<GreenAttestation[]> {
    return Promise.all(
      signers.map((s) =>
        signGreenAttestation({ repoKey, stagingSha: sha, signerPubkeyBase64: s.pubkeyBase64, nowMs: 1_000 }, s.sign),
      ),
    );
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'release-it-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensurePotGitRepo('hive-r', REPO_KEY);
    shaA = await commit(repo, { 'a.txt': 'a1' });
    shaB = await commit(repo, { 'a.txt': 'a1', 'b.txt': 'b1' }, shaA);
    rule = { allow: [greenBot.pubkeyBase64, owner.pubkeyBase64], threshold: 2 };
  });
  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('refuses promotion below the threshold (1 of 2) and leaves release unset', async () => {
    const r = await promoteRelease(repo, integ.pubkeyBase64, REPO_KEY, shaA, await proof(shaA, [greenBot]), rule);
    expect(r).toMatchObject({ promoted: false, reason: 'threshold-not-met' });
    expect(await readRelease(repo, integ.pubkeyBase64)).toBeNull();
  });

  it('ignores attestations that are duplicates, off-sha, off-list, or forged', async () => {
    const [dupe] = await proof(shaA, [greenBot]);
    const offSha = (await proof(shaB, [owner]))[0]; // right signer, WRONG sha
    const offList = (await proof(shaA, [stranger]))[0]; // not in allow
    const forged: GreenAttestation = {
      ...(await proof(shaA, [owner]))[0],
      sig: Buffer.alloc(64).toString('base64'),
    };
    const verdict = satisfiesCrefsRule(shaA, REPO_KEY, [dupe, dupe, offSha, offList, forged], rule);
    expect(verdict.ok).toBe(false);
    expect(verdict.validSigners).toEqual([greenBot.pubkeyBase64].sort());
    const r = await promoteRelease(repo, integ.pubkeyBase64, REPO_KEY, shaA, [dupe, dupe, offSha, offList, forged], rule);
    expect(r).toMatchObject({ promoted: false, reason: 'threshold-not-met' });
  });

  it('promotes with a satisfying proof (2 distinct allow-listed signers)', async () => {
    const r = await promoteRelease(repo, integ.pubkeyBase64, REPO_KEY, shaA, await proof(shaA, [greenBot, owner]), rule);
    expect(r).toMatchObject({ promoted: true, release: shaA });
    expect((r as { validSigners: string[] }).validSigners).toHaveLength(2);
    expect(await readRelease(repo, integ.pubkeyBase64)).toBe(shaA);
  });

  it('fast-forwards to a proven descendant', async () => {
    const r = await promoteRelease(repo, integ.pubkeyBase64, REPO_KEY, shaB, await proof(shaB, [greenBot, owner]), rule);
    expect(r).toMatchObject({ promoted: true, release: shaB });
    expect(await readRelease(repo, integ.pubkeyBase64)).toBe(shaB);
  });

  it('NEVER rewinds: a valid proof for an ancestor sha is refused (ff-only)', async () => {
    const r = await promoteRelease(repo, integ.pubkeyBase64, REPO_KEY, shaA, await proof(shaA, [greenBot, owner]), rule);
    expect(r).toMatchObject({ promoted: false, reason: 'non-fast-forward', release: shaB });
    expect(await readRelease(repo, integ.pubkeyBase64)).toBe(shaB);
  });

  it('re-promoting the current sha is a reported no-op', async () => {
    const r = await promoteRelease(repo, integ.pubkeyBase64, REPO_KEY, shaB, await proof(shaB, [greenBot, owner]), rule);
    expect(r).toMatchObject({ promoted: false, reason: 'already-current', release: shaB });
  });

  it('fails CLOSED on a malformed rule and on an unknown sha', async () => {
    const p = await proof(shaB, [greenBot, owner]);
    expect(await promoteRelease(repo, integ.pubkeyBase64, REPO_KEY, shaB, p, { allow: [], threshold: 1 })).toMatchObject({
      promoted: false,
      reason: 'malformed-rule',
    });
    expect(
      await promoteRelease(repo, integ.pubkeyBase64, REPO_KEY, shaB, p, { allow: rule.allow, threshold: 0 }),
    ).toMatchObject({ promoted: false, reason: 'malformed-rule' });
    const ghost = 'f'.repeat(40);
    expect(
      await promoteRelease(repo, integ.pubkeyBase64, REPO_KEY, ghost, await proof(ghost, [greenBot, owner]), rule),
    ).toMatchObject({ promoted: false, reason: 'unknown-sha' });
  });

  // WI-1554: with fork/mirror topologies sharing commit history and one
  // green-bot key allow-listed in multiple repos' crefs rules, a green(S)
  // attestation minted for repo A must NEVER satisfy repo B's rule at the
  // same sha — B's own gate (a DG-6 repo-relative suite) never ran. Uses a
  // SECOND real bare repo sharing shaC's exact commit content/history (a real
  // fork scenario, not a synthetic same-sha stand-in) to prove the replay is
  // refused end-to-end through promoteRelease, not just the pure predicate.
  describe('cross-repo replay guard (WI-1554)', () => {
    let repoB: string;
    let shaC: string;

    beforeAll(async () => {
      repoB = await ensurePotGitRepo('hive-r', 'repo-2');
      shaC = await commit(repoB, { 'a.txt': 'a1' }); // same tree as shaA, different repo
    });

    it('satisfiesCrefsRule refuses an attestation proof minted for a DIFFERENT repo_key at the same sha', async () => {
      const proofForRepoA = await proof(shaC, [greenBot, owner], REPO_KEY); // repo-1, not repo-2
      const verdict = satisfiesCrefsRule(shaC, 'repo-2', proofForRepoA, rule);
      expect(verdict).toMatchObject({ ok: false, reason: 'threshold-not-met', validSigners: [] });
    });

    it('promoteRelease refuses to promote repo B using a green proof minted for repo A (same sha)', async () => {
      const proofForRepoA = await proof(shaC, [greenBot, owner], REPO_KEY);
      const r = await promoteRelease(repoB, integ.pubkeyBase64, 'repo-2', shaC, proofForRepoA, rule);
      expect(r).toMatchObject({ promoted: false, reason: 'threshold-not-met' });
      expect(await readRelease(repoB, integ.pubkeyBase64)).toBeNull();
    });

    it('the SAME attestation correctly promotes when the repo_key matches (sanity: not just always-refuse)', async () => {
      const proofForRepoB = await proof(shaC, [greenBot, owner], 'repo-2');
      const r = await promoteRelease(repoB, integ.pubkeyBase64, 'repo-2', shaC, proofForRepoB, rule);
      expect(r).toMatchObject({ promoted: true, release: shaC });
    });
  });
});

function promoteRelease(...args: Parameters<typeof promoteReleaseUnderTest>) {
  const [repo, device, repoKey, sha, proof, rule, opts] = args;
  return promoteReleaseUnderTest(repo, device, repoKey, sha, proof, rule, { ...hiveEffectFixture(repoKey), ...opts });
}
