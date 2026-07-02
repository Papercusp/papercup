/**
 * release-promotion.integration.test.ts — G-5b two-speed gate against a REAL
 * temp bare repo (P-034). Acceptance pinned: release advances ONLY with a
 * proof satisfying the crefs rule (threshold DISTINCT allow-listed signers over
 * exactly that sha), and only fast-forward.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/release-promotion.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensureHiveGitRepo } from './storage';
import {
  type GreenAttestation,
  type ReleaseRule,
  promoteRelease,
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

describe('hive-git release promotion (G-5b, real bare repo)', () => {
  let root: string;
  let repo: string;
  const integ = identity(); // integrator device
  const greenBot = identity(); // DG-5 aggregator identity
  const owner = identity(); // hive owner identity
  const stranger = identity(); // NOT in allow
  let rule: ReleaseRule;
  let shaA: string;
  let shaB: string;

  async function proof(sha: string, signers: ReturnType<typeof identity>[]): Promise<GreenAttestation[]> {
    return Promise.all(
      signers.map((s) => signGreenAttestation({ stagingSha: sha, signerPubkeyBase64: s.pubkeyBase64, nowMs: 1_000 }, s.sign)),
    );
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'release-it-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensureHiveGitRepo('hive-r', 'repo-1');
    shaA = await commit(repo, { 'a.txt': 'a1' });
    shaB = await commit(repo, { 'a.txt': 'a1', 'b.txt': 'b1' }, shaA);
    rule = { allow: [greenBot.pubkeyBase64, owner.pubkeyBase64], threshold: 2 };
  });
  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('refuses promotion below the threshold (1 of 2) and leaves release unset', async () => {
    const r = await promoteRelease(repo, integ.pubkeyBase64, shaA, await proof(shaA, [greenBot]), rule);
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
    const verdict = satisfiesCrefsRule(shaA, [dupe, dupe, offSha, offList, forged], rule);
    expect(verdict.ok).toBe(false);
    expect(verdict.validSigners).toEqual([greenBot.pubkeyBase64].sort());
    const r = await promoteRelease(repo, integ.pubkeyBase64, shaA, [dupe, dupe, offSha, offList, forged], rule);
    expect(r).toMatchObject({ promoted: false, reason: 'threshold-not-met' });
  });

  it('promotes with a satisfying proof (2 distinct allow-listed signers)', async () => {
    const r = await promoteRelease(repo, integ.pubkeyBase64, shaA, await proof(shaA, [greenBot, owner]), rule);
    expect(r).toMatchObject({ promoted: true, release: shaA });
    expect((r as { validSigners: string[] }).validSigners).toHaveLength(2);
    expect(await readRelease(repo, integ.pubkeyBase64)).toBe(shaA);
  });

  it('fast-forwards to a proven descendant', async () => {
    const r = await promoteRelease(repo, integ.pubkeyBase64, shaB, await proof(shaB, [greenBot, owner]), rule);
    expect(r).toMatchObject({ promoted: true, release: shaB });
    expect(await readRelease(repo, integ.pubkeyBase64)).toBe(shaB);
  });

  it('NEVER rewinds: a valid proof for an ancestor sha is refused (ff-only)', async () => {
    const r = await promoteRelease(repo, integ.pubkeyBase64, shaA, await proof(shaA, [greenBot, owner]), rule);
    expect(r).toMatchObject({ promoted: false, reason: 'non-fast-forward', release: shaB });
    expect(await readRelease(repo, integ.pubkeyBase64)).toBe(shaB);
  });

  it('re-promoting the current sha is a reported no-op', async () => {
    const r = await promoteRelease(repo, integ.pubkeyBase64, shaB, await proof(shaB, [greenBot, owner]), rule);
    expect(r).toMatchObject({ promoted: false, reason: 'already-current', release: shaB });
  });

  it('fails CLOSED on a malformed rule and on an unknown sha', async () => {
    const p = await proof(shaB, [greenBot, owner]);
    expect(await promoteRelease(repo, integ.pubkeyBase64, shaB, p, { allow: [], threshold: 1 })).toMatchObject({
      promoted: false,
      reason: 'malformed-rule',
    });
    expect(
      await promoteRelease(repo, integ.pubkeyBase64, shaB, p, { allow: rule.allow, threshold: 0 }),
    ).toMatchObject({ promoted: false, reason: 'malformed-rule' });
    const ghost = 'f'.repeat(40);
    expect(
      await promoteRelease(repo, integ.pubkeyBase64, ghost, await proof(ghost, [greenBot, owner]), rule),
    ).toMatchObject({ promoted: false, reason: 'unknown-sha' });
  });
});
