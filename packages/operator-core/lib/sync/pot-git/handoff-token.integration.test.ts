/**
 * handoff-token.integration.test.ts — G-0 sha-token authority handoff + G-0b
 * park tokens against a REAL temp bare repo (P-033 / P-037), plus the G-5d
 * fast-forward acceptance leg (P-038) cross-checked over a real ancestry.
 *
 * ACCEPTANCE pinned here:
 *  - P-033: after a simulated handoff, the new authority's first staging is a
 *    DESCENDANT of the old authority's last published staging (no rewind).
 *  - P-037: a head parked by the old authority SURVIVES the handoff — the new
 *    authority classifies grants into it as `parked` (loud), never a stall.
 *  - P-038 (ff leg): a signed advance within a valid higher epoch is still
 *    rejected unless it fast-forwards the last accepted staging.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/handoff-token.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, deviceNamespaceKey, ensurePotGitRepo, writeNamespaceRef } from './storage';
import { WORK_REF, integrateMemberHeads, readStaging } from './integrator';
import { acceptStagingAdvanceFF, signStagingAdvance } from './staging-advance';
import {
  adoptHandoffToken,
  classifyRequiredSha,
  gradeShaTokenGrant,
  publishHandoffToken,
  readHandoffToken,
  resolveMaxObservedStaging,
  verifyHandoffToken,
} from './handoff-token';

function device() {
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

async function isAncestor(repo: string, anc: string, desc: string): Promise<boolean> {
  return (await defaultRunGit(['merge-base', '--is-ancestor', anc, desc], repo)).code === 0;
}

describe('hive-git handoff token + park tokens (G-0/G-0b, real bare repo)', () => {
  let root: string;
  let repo: string;
  const oldAuth = device(); // outgoing integrator authority
  const newAuth = device(); // incoming integrator authority
  const memberA = device();
  const memberB = device();
  const conflicter = device();
  let base: string;
  let aHead: string;
  let conflictHead: string;
  let oldStaging: string; // old authority's last published staging

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'handoff-it-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensurePotGitRepo('hive-h', 'repo-1');

    // Member A publishes work; the conflicter publishes an unmergeable head.
    base = await commit(repo, { 'a.txt': 'a1' });
    aHead = await commit(repo, { 'a.txt': 'a1', 'a2.txt': 'a2' }, base);
    conflictHead = await commit(repo, { 'a.txt': 'CONFLICT' }); // rootless + colliding content
    await writeNamespaceRef(repo, memberA.pubkeyBase64, WORK_REF, aHead);
    await writeNamespaceRef(repo, conflicter.pubkeyBase64, WORK_REF, conflictHead);

    // OLD authority integrates. Seed staging from A FIRST (device-hex order is
    // random — integrating both at once could otherwise seed staging with the
    // rootless conflict head instead of parking it), then the conflicter PARKS.
    const r1 = await integrateMemberHeads(repo, oldAuth.pubkeyBase64, [
      { deviceHex: deviceNamespaceKey(memberA.pubkeyBase64), sha: aHead },
    ]);
    expect(r1.advanced).toBe(true);
    const r2 = await integrateMemberHeads(repo, oldAuth.pubkeyBase64, [
      { deviceHex: deviceNamespaceKey(memberA.pubkeyBase64), sha: aHead },
      { deviceHex: deviceNamespaceKey(conflicter.pubkeyBase64), sha: conflictHead },
    ]);
    expect(r2.skippedConflicts).toEqual([
      { deviceHex: deviceNamespaceKey(conflicter.pubkeyBase64), sha: conflictHead },
    ]);
    oldStaging = (r2.staging ?? r1.staging)!;
    expect(oldStaging).toBe(r1.staging);
  });
  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('publish → read → verify round-trips the signed token (parked heads included)', async () => {
    const parked = [{ deviceHex: deviceNamespaceKey(conflicter.pubkeyBase64), sha: conflictHead }];
    const published = await publishHandoffToken(
      repo,
      oldAuth.pubkeyBase64,
      { epoch: 1, seq: 4, stagingSha: oldStaging, parked, nowMs: 5_000 },
      oldAuth.sign,
    );
    const read = await readHandoffToken(repo, oldAuth.pubkeyBase64);
    expect(read).toEqual(published);
    expect(verifyHandoffToken(read!)).toBe(true);
    expect(verifyHandoffToken(read!, oldAuth.pubkeyBase64)).toBe(true);
    expect(verifyHandoffToken(read!, newAuth.pubkeyBase64)).toBe(false); // wrong expected device
    expect(verifyHandoffToken({ ...read!, staging_sha: base })).toBe(false); // tamper
  });

  it('P-033 ACCEPTANCE: the new authority adopts the token and its first staging descends from the old staging', async () => {
    const token = (await readHandoffToken(repo, oldAuth.pubkeyBase64))!;
    const adopt = await adoptHandoffToken(repo, newAuth.pubkeyBase64, token);
    expect(adopt).toMatchObject({ ok: true, adopted: true, staging: oldStaging, nextEpoch: 2 });

    // New authority's FIRST integration: member B publishes fresh work forked
    // from base (diverged from staging → a real merge).
    const bHead = await commit(repo, { 'a.txt': 'a1', 'b2.txt': 'b2' }, base);
    await writeNamespaceRef(repo, memberB.pubkeyBase64, WORK_REF, bHead);
    const r = await integrateMemberHeads(repo, newAuth.pubkeyBase64, [
      { deviceHex: deviceNamespaceKey(memberB.pubkeyBase64), sha: bHead },
    ]);
    expect(r.advanced).toBe(true);
    // THE invariant: no rewind — the old authority's last publish is an
    // ancestor of the new authority's first publish.
    expect(await isAncestor(repo, oldStaging, r.staging!)).toBe(true);
    expect(await readStaging(repo, newAuth.pubkeyBase64)).toBe(r.staging);
  });

  it('P-037 ACCEPTANCE: a parked head survives the handoff — grants into it downgrade LOUDLY to parked', async () => {
    const token = (await readHandoffToken(repo, oldAuth.pubkeyBase64))!;
    const adopt = await adoptHandoffToken(repo, newAuth.pubkeyBase64, token);
    expect(adopt.ok).toBe(true);
    const parked = adopt.ok ? adopt.parked : [];
    expect(parked).toHaveLength(1);

    const staging = await readStaging(repo, newAuth.pubkeyBase64);
    // A lock grant whose requiredSha is the parked head: parked, not a stall.
    const cls = await classifyRequiredSha(repo, conflictHead, staging, parked);
    expect(cls).toMatchObject({ status: 'parked', parkedHead: parked[0] });
    const grade = gradeShaTokenGrant(cls, conflictHead);
    expect(grade.mode).toBe('parked');
    expect(grade.unsyncedRisk).toBe(false);
    expect(grade.label).toContain('PARKED');
    expect(grade.label).toContain('STAGING');

    // A requiredSha already integrated → clean; an unknown sha → unsynced-risk.
    const inStaging = await classifyRequiredSha(repo, aHead, staging, parked);
    expect(inStaging).toEqual({ status: 'in-staging' });
    expect(gradeShaTokenGrant(inStaging, aHead).mode).toBe('clean');
    const orphan = await commit(repo, { 'zz.txt': 'never-published' });
    const unknown = await classifyRequiredSha(repo, orphan, staging, parked);
    expect(unknown).toEqual({ status: 'unknown' });
    const g = gradeShaTokenGrant(unknown, orphan);
    expect(g.mode).toBe('unsynced-risk');
    expect(g.unsyncedRisk).toBe(true);
  });

  it('adopt is rewind-proof: a stale token never moves an ahead/current staging back', async () => {
    const own = await readStaging(repo, newAuth.pubkeyBase64);
    // Old token points at oldStaging (an ancestor of own by the P-033 test).
    const token = (await readHandoffToken(repo, oldAuth.pubkeyBase64))!;
    const again = await adoptHandoffToken(repo, newAuth.pubkeyBase64, token);
    expect(again).toMatchObject({ ok: true, adopted: false, staging: own });
    expect(await readStaging(repo, newAuth.pubkeyBase64)).toBe(own);
  });

  it('adopt refuses a tampered token, a missing-object sha, and a diverged staging', async () => {
    const token = (await readHandoffToken(repo, oldAuth.pubkeyBase64))!;
    expect(await adoptHandoffToken(repo, newAuth.pubkeyBase64, { ...token, epoch: 9 })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    const ghostToken = await publishHandoffToken(
      repo,
      oldAuth.pubkeyBase64,
      { epoch: 2, seq: 0, stagingSha: 'e'.repeat(40), nowMs: 6_000 },
      oldAuth.sign,
    );
    expect(await adoptHandoffToken(repo, newAuth.pubkeyBase64, ghostToken)).toEqual({
      ok: false,
      reason: 'missing-objects',
    });
    // Diverged: a third authority whose own staging forked away from the token sha.
    const forkAuth = device();
    const forkStaging = await commit(repo, { 'fork.txt': 'f' }, base);
    await writeNamespaceRef(repo, forkAuth.pubkeyBase64, 'refs/heads/staging', forkStaging);
    const realToken = await publishHandoffToken(
      repo,
      oldAuth.pubkeyBase64,
      { epoch: 3, seq: 0, stagingSha: oldStaging, nowMs: 7_000 },
      oldAuth.sign,
    );
    expect(await adoptHandoffToken(repo, forkAuth.pubkeyBase64, realToken)).toEqual({
      ok: false,
      reason: 'diverged',
    });
  });

  it('resolveMaxObservedStaging picks the ancestry-maximal head (crash path, no token)', async () => {
    // oldAuth's staging (older) vs newAuth's staging (its descendant).
    const max = await resolveMaxObservedStaging(repo, [oldAuth.pubkeyBase64, newAuth.pubkeyBase64]);
    const newStaging = await readStaging(repo, newAuth.pubkeyBase64);
    expect(max).toMatchObject({ sha: newStaging, diverged: false });
    // Add a diverged staging → diverged:true, deterministic pick, both maximal.
    const forkAuth2 = device();
    const fork2 = await commit(repo, { 'fork2.txt': 'f2' }, base);
    await writeNamespaceRef(repo, forkAuth2.pubkeyBase64, 'refs/heads/staging', fork2);
    const max2 = await resolveMaxObservedStaging(repo, [
      oldAuth.pubkeyBase64,
      newAuth.pubkeyBase64,
      forkAuth2.pubkeyBase64,
    ]);
    expect(max2!.diverged).toBe(true);
    expect(max2!.maximal.map((m) => m.sha).sort()).toEqual([newStaging, fork2].sort());
    expect(await resolveMaxObservedStaging(repo, [device().pubkeyBase64])).toBeNull();
  });

  it('P-038 ff leg: a signed advance in a valid higher epoch is rejected unless it fast-forwards', async () => {
    const newStaging = (await readStaging(repo, newAuth.pubkeyBase64))!;
    const prior = { epoch: 2, seq: 0 };
    // Sideways sha (diverged from staging) under a higher (epoch, seq) → non-ff.
    const sideways = await commit(repo, { 'side.txt': 's' }, base);
    const sidewaysAdv = await signStagingAdvance(
      { devicePubkeyBase64: newAuth.pubkeyBase64, epoch: 2, seq: 1, stagingSha: sideways, nowMs: 8_000 },
      newAuth.sign,
    );
    expect(await acceptStagingAdvanceFF(repo, sidewaysAdv, prior, newStaging)).toEqual({
      ok: false,
      reason: 'non-fast-forward',
    });
    // A genuine descendant under the same (epoch, seq) → accepted.
    const forward = await commit(repo, { 'fwd.txt': 'f' }, newStaging);
    const forwardAdv = await signStagingAdvance(
      { devicePubkeyBase64: newAuth.pubkeyBase64, epoch: 2, seq: 1, stagingSha: forward, nowMs: 8_001 },
      newAuth.sign,
    );
    expect(await acceptStagingAdvanceFF(repo, forwardAdv, prior, newStaging)).toEqual({ ok: true });
    // A sha we do not have → unknown-sha (fetch first).
    const ghostAdv = await signStagingAdvance(
      { devicePubkeyBase64: newAuth.pubkeyBase64, epoch: 2, seq: 2, stagingSha: 'd'.repeat(40), nowMs: 8_002 },
      newAuth.sign,
    );
    expect(await acceptStagingAdvanceFF(repo, ghostAdv, prior, newStaging)).toEqual({
      ok: false,
      reason: 'unknown-sha',
    });
    // The fenced ex-authority: valid signature, valid ff, but a STALE epoch.
    const staleAdv = await signStagingAdvance(
      { devicePubkeyBase64: oldAuth.pubkeyBase64, epoch: 1, seq: 99, stagingSha: forward, nowMs: 8_003 },
      oldAuth.sign,
    );
    expect(await acceptStagingAdvanceFF(repo, staleAdv, prior, newStaging)).toEqual({
      ok: false,
      reason: 'stale-epoch-seq',
    });
  });
});
