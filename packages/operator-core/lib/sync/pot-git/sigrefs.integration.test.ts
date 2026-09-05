/**
 * sigrefs.integration.test.ts — G-4/G-4b device-signed ref snapshots against a
 * REAL temp bare repo (git on PATH, no network), with an injected Ed25519 signer.
 * Proves: build/read round-trip, the sigrefs ref self-excludes, signature verify
 * (valid / tampered / wrong-device), monotonic version, the rollback guard, and
 * the fetched-head reconciliation that closes the transitive-relay tamper hole.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/sigrefs.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensurePotGitRepo, writeNamespaceRef } from './storage';
import {
  SIGREFS_REF,
  buildSigrefs,
  readSigrefs,
  verifySigrefs,
  acceptFetchedSigrefs,
  reconcileFetchedHeads,
  sigrefsSigningBytes,
} from './sigrefs';
import { makeSignedProtocolContext } from './signed-context';

async function mintCommit(repoPath: string, msg: string): Promise<string> {
  const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], repoPath);
  const c = await defaultRunGit(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree.stdout.trim(), '-m', msg],
    repoPath,
  );
  expect(c.code, c.stderr).toBe(0);
  return c.stdout.trim();
}

describe('pot-git sigrefs (real bare repo, injected signer)', () => {
  let root: string;
  let repo: string;
  const kp = generateEd25519KeypairDer();
  const devA = kp.pubkeyBase64;
  const sign = (bytes: Buffer): Promise<Buffer> => Promise.resolve(signWithPrivateKeyDer(kp.privateKeyDer, bytes));
  let workSha = '';
  let sig2Sha = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sigrefs-it-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensurePotGitRepo('hive-s', 'repo-1');
    workSha = await mintCommit(repo, 'work 1');
    sig2Sha = await mintCommit(repo, 'sig 2');
    await writeNamespaceRef(repo, devA, 'refs/heads/work', workSha);
    await writeNamespaceRef(repo, devA, 'refs/heads/topic', sig2Sha);
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('builds + reads a signed snapshot; captures heads; self-excludes the sigrefs ref', async () => {
    const signed = await buildSigrefs(repo, devA, sign, { nowMs: 1000 });
    expect(signed.version).toBe(1);
    expect(signed.device_pubkey).toBe(devA);
    const byRef = new Map(signed.refs.map((r) => [r.ref, r.sha]));
    expect(byRef.get('refs/heads/work')).toBe(workSha);
    expect(byRef.get('refs/heads/topic')).toBe(sig2Sha);
    expect(byRef.has(SIGREFS_REF)).toBe(false); // never signs itself
    const read = await readSigrefs(repo, devA);
    expect(read).toEqual(signed);
  });

  it('verifySigrefs: valid → true; tampered sha → false; wrong device → false', async () => {
    const signed = await readSigrefs(repo, devA);
    expect(signed).not.toBeNull();
    expect(verifySigrefs(signed!, devA)).toBe(true);
    const tampered = { ...signed!, refs: signed!.refs.map((r) => ({ ...r, sha: sig2Sha })) };
    expect(verifySigrefs(tampered, devA)).toBe(false);
    const otherKp = generateEd25519KeypairDer();
    expect(verifySigrefs(signed!, otherKp.pubkeyBase64)).toBe(false);
  });

  it('canonical signing bytes are order-independent (sorted by ref)', () => {
    const base = { v: 1, device_pubkey: devA, version: 1, ts: 5 };
    const a = sigrefsSigningBytes({ ...base, refs: [{ ref: 'refs/heads/b', sha: 'x' }, { ref: 'refs/heads/a', sha: 'y' }] });
    const b = sigrefsSigningBytes({ ...base, refs: [{ ref: 'refs/heads/a', sha: 'y' }, { ref: 'refs/heads/b', sha: 'x' }] });
    expect(a.equals(b)).toBe(true);
  });

  it('version auto-increments monotonically on rebuild', async () => {
    const again = await buildSigrefs(repo, devA, sign, { nowMs: 2000 });
    expect(again.version).toBe(2);
    expect((await readSigrefs(repo, devA))!.version).toBe(2);
  });

  it('acceptFetchedSigrefs: newer → ok; same/older → rollback; bad sig → bad-signature', async () => {
    const v2 = await readSigrefs(repo, devA);
    // A receiver at prior version 1 accepts v2.
    expect(acceptFetchedSigrefs(v2!, devA, 1)).toEqual({ ok: true });
    // No prior (first ever) accepts.
    expect(acceptFetchedSigrefs(v2!, devA, null)).toEqual({ ok: true });
    // A replayed/rolled-back v2 against a receiver already at v2 is rejected.
    expect(acceptFetchedSigrefs(v2!, devA, 2)).toEqual({ ok: false, reason: 'rollback' });
    expect(acceptFetchedSigrefs(v2!, devA, 3)).toEqual({ ok: false, reason: 'rollback' });
    // Wrong device / tampered signature.
    const otherKp = generateEd25519KeypairDer();
    expect(acceptFetchedSigrefs(v2!, otherKp.pubkeyBase64, 1)).toEqual({ ok: false, reason: 'wrong-device' });
    const tampered = { ...v2!, sig: Buffer.from('00'.repeat(64), 'hex').toString('base64') };
    expect(acceptFetchedSigrefs(tampered, devA, 1)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('binds v3 snapshots to the signed context and rejects drift or legacy when required', async () => {
    const context = makeSignedProtocolContext('hive-s', 'repo-1');
    const signed = await buildSigrefs(repo, devA, sign, { nowMs: 3_000, version: 9, context });
    expect(signed.v).toBe(3);
    expect(verifySigrefs(signed, devA)).toBe(true);
    expect(acceptFetchedSigrefs(signed, devA, 8, { expectedContext: context, allowLegacy: false })).toEqual({ ok: true });
    expect(
      acceptFetchedSigrefs(signed, devA, 8, { expectedContext: { ...context, repo_key: 'other' } }),
    ).toEqual({ ok: false, reason: 'context-mismatch' });
    const legacy = await buildSigrefs(repo, devA, sign, { nowMs: 4_000, version: 10 });
    expect(acceptFetchedSigrefs(legacy, devA, 8, { expectedContext: context, allowLegacy: false })).toEqual({
      ok: false,
      reason: 'legacy-version',
    });
  });

  it('reconcileFetchedHeads: matching heads → none; a relay-tampered head → mismatch', async () => {
    const signed = await readSigrefs(repo, devA);
    // Fresh mirror with the SAME heads the signature covers → no mismatches.
    const mirror = await ensurePotGitRepo('hive-s', 'mirror-clean');
    // (objects need to exist for readNamespaceRef's ^{object}; reuse same ODB via
    //  writing the same shas — mint them here so cat-file resolves.)
    const m1 = await mintCommit(mirror, 'work 1');
    const m2 = await mintCommit(mirror, 'sig 2');
    // Rebuild a signature over the mirror's shas so "matching" is meaningful.
    const kp2 = generateEd25519KeypairDer();
    const sign2 = (b: Buffer): Promise<Buffer> => Promise.resolve(signWithPrivateKeyDer(kp2.privateKeyDer, b));
    await writeNamespaceRef(mirror, kp2.pubkeyBase64, 'refs/heads/work', m1);
    await writeNamespaceRef(mirror, kp2.pubkeyBase64, 'refs/heads/topic', m2);
    const mSigned = await buildSigrefs(mirror, kp2.pubkeyBase64, sign2, { nowMs: 1 });
    expect(await reconcileFetchedHeads(mirror, kp2.pubkeyBase64, mSigned)).toEqual([]);
    // Now tamper: advance a head locally to a sha the signature does NOT cover.
    await writeNamespaceRef(mirror, kp2.pubkeyBase64, 'refs/heads/work', m2, defaultRunGit, m1);
    const mism = await reconcileFetchedHeads(mirror, kp2.pubkeyBase64, mSigned);
    expect(mism.some((x) => x.ref === 'refs/heads/work' && x.actual === m2 && x.expected === m1)).toBe(true);
    // A relay-injected EXTRA ref the signature doesn't cover is also caught.
    await writeNamespaceRef(mirror, kp2.pubkeyBase64, 'refs/heads/injected', m2);
    const mism2 = await reconcileFetchedHeads(mirror, kp2.pubkeyBase64, mSigned);
    expect(mism2.some((x) => x.ref === 'refs/heads/injected' && x.expected === '(unsigned)')).toBe(true);
    void signed;
  });
});
