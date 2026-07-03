/**
 * foreign-publish.integration.test.ts — P-109 leg (iii) end-to-end over real
 * temp git repos (no PG, no network): foreign clone → quarantine admission →
 * per-scope repo publish (D-018 option b) → executor scope-sigrefs with
 * originClaim (D-017 n2) → canonical import under the refs/foreign tracking
 * ref → P-110 gate at the merge boundary (the X2 invariant, both verdicts).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/foreign-publish.integration.test.ts
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { publishForeignResult, importForeignResultToCanonical } from './foreign-publish';
import { isForeignMarkedRef } from './foreign-merge-admission';
import { readSigrefs, verifySigrefs, acceptFetchedSigrefs, sigrefsCarryOriginClaims } from './sigrefs';
import { scopeForeignRef, scopeRepoPath, type ScopeId } from './scope-repo';
import { defaultRunGit } from './storage';

const execFileP = promisify(execFile);
const ORIGIN_ID = 777;
const ORIGIN_EMAIL = `${ORIGIN_ID}+origindev@users.noreply.github.com`;
const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: 42, slug: 'widgets' };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd });
  return stdout.trim();
}

/** A commit authored+committed as the attested origin (what leg ii stamps). */
async function originCommit(repo: string, file: string, content: string, msg: string): Promise<void> {
  await writeFile(join(repo, file), content);
  await git(repo, 'add', '-A');
  await git(
    repo,
    '-c',
    'user.name=Origin Dev',
    '-c',
    `user.email=${ORIGIN_EMAIL}`,
    'commit',
    '--author',
    `Origin Dev <${ORIGIN_EMAIL}>`,
    '-m',
    msg,
  );
}

let base: string;
let oldRoot: string | undefined;
let canonical: string;
let clone: string;
/** The provision base (mig 470 base_sha) — the publish-admission anchor. */
let baseSha: string;
const kp = generateEd25519KeypairDer();
const sign = (bytes: Buffer): Promise<Buffer> =>
  Promise.resolve(signWithPrivateKeyDer(kp.privateKeyDer, bytes));

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'foreign-publish-it-'));
  oldRoot = process.env.PAPERCUSP_HIVE_GIT_ROOT;
  process.env.PAPERCUSP_HIVE_GIT_ROOT = join(base, 'hive-git-root');

  // The canonical repo with a staging line.
  canonical = join(base, 'canonical');
  await mkdir(canonical);
  await git(canonical, 'init', '-b', 'staging');
  await git(canonical, 'config', 'user.name', 'Host');
  await git(canonical, 'config', 'user.email', 'host@example.com');
  await writeFile(join(canonical, 'base.txt'), 'base\n');
  await git(canonical, 'add', '-A');
  await git(canonical, 'commit', '-m', 'canonical base');

  // The foreign clone (leg-iv output): full clone of canonical.
  clone = join(base, 'foreign', 'offer-1', 'repo');
  await mkdir(join(base, 'foreign', 'offer-1'), { recursive: true });
  await execFileP('git', ['clone', '--no-local', '-q', canonical, clone]);
  baseSha = await git(clone, 'rev-parse', 'HEAD');
}, 30000);

afterAll(async () => {
  if (oldRoot === undefined) delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
  else process.env.PAPERCUSP_HIVE_GIT_ROOT = oldRoot;
  await rm(base, { recursive: true, force: true });
});

describe('publishForeignResult → importForeignResultToCanonical', () => {
  it('admits an origin-authored deliverable end-to-end, with claims + receipt', async () => {
    await originCommit(clone, 'feature.ts', 'export const x = 1;\n', 'foreign feature');

    const pub = await publishForeignResult({
      hiveHomeSlug: 'papercusp',
      scope: SCOPE,
      foreignClonePath: clone,
      sourceBranch: 'staging',
      resultName: 'offer-1',
      originGithubUserIds: [ORIGIN_ID],
      offerId: 'offer-1',
      executionEpoch: 5,
      rangeAnchorShas: [baseSha],
      executorDevicePubkeyBase64: kp.pubkeyBase64,
      sign,
      nowMs: 1_700_000_000_000,
    });

    expect(pub.admitted).toBe(true);
    expect(pub.head).toBeTruthy();
    expect(pub.scopeRepoPath).toBe(scopeRepoPath('papercusp', SCOPE));
    // The ref is in the foreign-marked family (RC-4 / P-110 contract).
    expect(isForeignMarkedRef(pub.foreignRef)).toBe(true);
    // The scope repo really holds it.
    const inScope = await git(pub.scopeRepoPath, 'rev-parse', pub.foreignRef);
    expect(inScope).toBe(pub.head);
    // RC-1 completion receipt points, never carries.
    expect(pub.receipt.kind).toBe('completion');
    expect(pub.receipt.commit_oid).toBe(pub.head);
    expect(pub.receipt.scope_id).toBe('fleet:42/widgets');
    expect(pub.receipt.execution_epoch).toBe(5);
    // C8: executor-signed scope sigrefs carry the origin claim (v2)…
    expect(pub.sigrefs).not.toBeNull();
    expect(pub.sigrefs!.v).toBe(2);
    const entry = pub.sigrefs!.refs.find((r) => r.ref === pub.foreignRef);
    expect(entry?.originClaim).toEqual({
      offer_id: 'offer-1',
      origin_github_user_id: ORIGIN_ID,
      execution_epoch: 5,
    });
    // …stored + verifiable in the scope repo…
    const stored = await readSigrefs(pub.scopeRepoPath, kp.pubkeyBase64);
    expect(stored).not.toBeNull();
    expect(verifySigrefs(stored!, kp.pubkeyBase64)).toBe(true);
    // …and CONFINED: the hive-wide integrator refuses claim-bearing sigrefs
    // (D-017 n2), while a scope integrator opts in.
    expect(sigrefsCarryOriginClaims(stored!)).toBe(true);
    expect(acceptFetchedSigrefs(stored!, kp.pubkeyBase64, null)).toEqual({
      ok: false,
      reason: 'origin-claim-outside-scope',
    });
    expect(acceptFetchedSigrefs(stored!, kp.pubkeyBase64, null, { allowOriginClaims: true })).toEqual({
      ok: true,
    });

    // Canonical import: tracking ref lands, gate ADMITS.
    const imp = await importForeignResultToCanonical({
      canonicalRepoPath: canonical,
      scopeRepoPath: pub.scopeRepoPath,
      scope: SCOPE,
      resultName: 'offer-1',
      originGithubUserIds: [ORIGIN_ID],
      offerId: 'offer-1',
    });
    expect(imp.admitted).toBe(true);
    expect(imp.head).toBe(pub.head);
    expect(imp.trackingRef).toBe(scopeForeignRef(SCOPE, 'offer-1'));
    const inCanonical = await git(canonical, 'rev-parse', imp.trackingRef);
    expect(inCanonical).toBe(pub.head);
    expect(imp.admission?.basis).toBe('clean');
  }, 60000);

  it('REFUSES a spoofed --author=<owner> commit at the canonical boundary and drops the tracking ref (X2)', async () => {
    // The foreign shell hand-crafts a commit attributed to someone outside
    // the origin chain (the exact LIVE-2 spoof leg).
    await writeFile(join(clone, 'evil.ts'), 'export const y = 2;\n');
    await git(clone, 'add', '-A');
    await git(
      clone,
      '-c',
      'user.name=Owner',
      '-c',
      'user.email=999999+owner@users.noreply.github.com',
      'commit',
      '--author',
      'Owner <999999+owner@users.noreply.github.com>',
      '-m',
      'spoofed',
    );

    // The PUBLISH admission already refuses (identity outside the chain)…
    const pub = await publishForeignResult({
      hiveHomeSlug: 'papercusp',
      scope: SCOPE,
      foreignClonePath: clone,
      sourceBranch: 'staging',
      resultName: 'offer-1-spoof',
      originGithubUserIds: [ORIGIN_ID],
      offerId: 'offer-1',
      executionEpoch: 5,
      rangeAnchorShas: [baseSha],
      nowMs: 1_700_000_000_001,
    });
    expect(pub.admitted).toBe(false);
    expect(pub.receipt.kind).toBe('refusal');
    expect(pub.receipt.refusal_code).toBe('identity');
    // Nothing published: the ref does not exist in the scope repo.
    const check = await defaultRunGit(
      ['rev-parse', '--verify', '--quiet', pub.foreignRef],
      pub.scopeRepoPath,
    );
    expect(check.code).not.toBe(0);

    // …and even if a result somehow landed in a scope repo, the IMPORT gate
    // re-judges independently: hand-plant the spoofed head in the scope repo
    // (simulating a compromised executor that skipped its own admission).
    const spoofHead = await git(clone, 'rev-parse', 'HEAD');
    const plantedRef = scopeForeignRef(SCOPE, 'offer-1-spoof');
    await defaultRunGit(
      ['fetch', '-q', '--no-tags', clone, `+refs/heads/staging:${plantedRef}`],
      pub.scopeRepoPath,
    );
    const imp = await importForeignResultToCanonical({
      canonicalRepoPath: canonical,
      scopeRepoPath: pub.scopeRepoPath,
      scope: SCOPE,
      resultName: 'offer-1-spoof',
      originGithubUserIds: [ORIGIN_ID],
      offerId: 'offer-1',
    });
    expect(imp.admitted).toBe(false);
    expect(imp.head).toBe(spoofHead);
    expect(imp.admission?.basis).toBe('refused');
    // The poisoned tracking ref is GONE from the canonical repo.
    const gone = await defaultRunGit(['rev-parse', '--verify', '--quiet', imp.trackingRef], canonical);
    expect(gone.code).not.toBe(0);
  }, 60000);

  it('refuses an oversize blob before the scope repo ever sees the object (X4)', async () => {
    await writeFile(join(clone, 'huge.bin'), Buffer.alloc(256 * 1024, 3));
    await git(clone, 'add', '-A');
    await git(
      clone,
      '-c',
      'user.name=Origin Dev',
      '-c',
      `user.email=${ORIGIN_EMAIL}`,
      'commit',
      '--author',
      `Origin Dev <${ORIGIN_EMAIL}>`,
      '-m',
      'big blob',
    );

    const pub = await publishForeignResult({
      hiveHomeSlug: 'papercusp',
      scope: SCOPE,
      foreignClonePath: clone,
      sourceBranch: 'staging',
      resultName: 'offer-1-big',
      originGithubUserIds: [ORIGIN_ID],
      offerId: 'offer-1',
      executionEpoch: 5,
      rangeAnchorShas: [baseSha],
      caps: { maxBlobBytes: 64 * 1024 },
      nowMs: 1_700_000_000_002,
    });
    expect(pub.admitted).toBe(false);
    expect(pub.receipt.refusal_code).toBe('blob-over-cap');
    expect(pub.receipt.refusal_detail).toContain('huge.bin');
    // The oversize blob is ABSENT from the scope repo's ODB.
    const blobOid = pub.quarantine.oversizeBlobs[0]?.oid;
    expect(blobOid).toBeTruthy();
    const has = await defaultRunGit(['cat-file', '-e', blobOid], pub.scopeRepoPath);
    expect(has.code).not.toBe(0);
  }, 60000);
});
