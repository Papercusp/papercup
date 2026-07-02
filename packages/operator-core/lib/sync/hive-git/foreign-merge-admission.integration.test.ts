/**
 * foreign-merge-admission.integration.test.ts — P-110 canonical-merge admission
 * for foreign-marked refs (p2p-work-distribution-2026-07-02; finding X2):
 * commits reachable ONLY via a foreign-marked ref must have BOTH identities
 * (author + committer) resolving within the offer's attested ORIGIN chain,
 * else the merge is REFUSED loudly. Unknown identities REFUSE (the exact
 * `--author=<owner>` free-text spoof surface — inverted posture vs the ingress
 * gate). Errors / empty chain / non-foreign ref / over-long range fail CLOSED.
 * Real git, injected resolution seam (no PG).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/foreign-merge-admission.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRunGit } from './storage';
import {
  admitForeignMergeHead,
  foreignFleetFromRef,
  formatForeignRefusal,
  isForeignMarkedRef,
} from './foreign-merge-admission';

const ORIGIN = '444+origin-user@users.noreply.github.com'; // attested origin (id 444)
const OWNER = '111+host-owner@users.noreply.github.com'; // the spoof target (id 111)
const FOREIGN_REF = 'refs/foreign/fleet-x/results/offer-1';

async function commitAs(
  work: string,
  authorEmail: string,
  path: string,
  content: string,
  msg: string,
  committerEmail: string = authorEmail,
): Promise<string> {
  await writeFile(join(work, path), content);
  expect((await defaultRunGit(['add', '-A'], work)).code).toBe(0);
  const c = await defaultRunGit(
    [
      '-c', 'user.name=committer',
      '-c', `user.email=${committerEmail}`,
      'commit', '-q', '-m', msg,
      `--author=author <${authorEmail}>`,
    ],
    work,
  );
  expect(c.code, c.stderr).toBe(0);
  return (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
}

describe('isForeignMarkedRef / foreignFleetFromRef (the C8/X3 marker, both P-108 shapes)', () => {
  it('matches top-level refs/foreign/<fleet>/... (shape b)', () => {
    expect(isForeignMarkedRef('refs/foreign/fleet-x/results/offer-1')).toBe(true);
    expect(foreignFleetFromRef('refs/foreign/fleet-x/results/offer-1')).toBe('fleet-x');
  });
  it('matches namespace-nested refs/namespaces/<hex>/refs/foreign/... (shape a)', () => {
    const nested = 'refs/namespaces/0aff1e2d3c4b/refs/foreign/fleet-y/results/offer-2';
    expect(isForeignMarkedRef(nested)).toBe(true);
    expect(foreignFleetFromRef(nested)).toBe('fleet-y');
  });
  it('does NOT match ordinary refs (member work, staging, near-miss names)', () => {
    for (const ref of [
      'refs/heads/work',
      'refs/heads/staging',
      'refs/namespaces/0aff1e2d3c4b/refs/heads/work',
      'refs/foreignx/fleet-x/oops',
      'refs/hive/staging',
      'refs/foreign', // no fleet segment
    ]) {
      expect(isForeignMarkedRef(ref), ref).toBe(false);
      expect(foreignFleetFromRef(ref), ref).toBeNull();
    }
  });
});

describe('foreign-merge-admission (P-110/X2: the canonical-merge gate for foreign refs)', () => {
  let root: string;
  let work: string;
  let staging: string; // canonical staging head the merges land on
  let cleanForeignHead: string; // in-chain foreign work on top of staging

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hg-fma-'));
    work = join(root, 'repo');
    expect((await defaultRunGit(['init', '-q', '-b', 'main', work], root)).code).toBe(0);
    // Canonical history authored by the host owner — NOT part of any foreign range.
    await commitAs(work, OWNER, 'a.txt', 'base\n', 'c0');
    staging = await commitAs(work, OWNER, 'a.txt', 'one\n', 'c1');
    // Foreign work: properly attributed to the attested origin (author+committer).
    cleanForeignHead = await commitAs(work, ORIGIN, 'f.txt', 'foreign work\n', 'f1');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('a clean in-chain range ADMITS, echoing the offer id (M21)', async () => {
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: cleanForeignHead,
      stagingHead: staging,
      originGithubUserIds: [444],
      offerId: 'offer-1',
    });
    expect(r).toMatchObject({ admit: true, basis: 'clean', offerId: 'offer-1', foreignRef: FOREIGN_REF });
    expect(r.checkedIdentityIds).toEqual([444]);
    expect(r.rangeSize).toBe(1);
    expect(r.refusals).toEqual([]);
    expect(formatForeignRefusal(r)).toContain('ADMITTED');
  });

  it('the X2 spoof — `--author=<owner>` (owner not in chain) — REFUSES, naming the commit', async () => {
    // Foreign session hand-crafts a commit attributed to the host owner.
    const spoof = await commitAs(work, OWNER, 'g.txt', 'evil\n', 'spoof', ORIGIN);
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: spoof,
      stagingHead: staging,
      originGithubUserIds: [444],
      offerId: 'offer-1',
    });
    expect(r.admit).toBe(false);
    expect(r.basis).toBe('refused');
    const refusal = r.refusals.find((x) => x.sha === spoof && x.role === 'author');
    expect(refusal).toMatchObject({ githubUserId: 111, reason: 'out-of-chain' });
    // The loud line names the offer, the ref, the commit, and the identity.
    const line = formatForeignRefusal(r);
    expect(line).toContain('REFUSED');
    expect(line).toContain('offer-1');
    expect(line).toContain(spoof.slice(0, 8));
    expect(line).toContain('111');
    // reset the branch back for later tests
    expect((await defaultRunGit(['reset', '-q', '--hard', cleanForeignHead], work)).code).toBe(0);
  });

  it('a FREE-TEXT author (unmappable email) REFUSES — inverted posture vs ingress', async () => {
    const spoof = await commitAs(work, 'host owner <owner@gmail.com>'.replace(/.*</, '').replace('>', ''), 'h.txt', 'evil2\n', 'freetext', ORIGIN);
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: spoof,
      stagingHead: staging,
      originGithubUserIds: [444],
    });
    expect(r.admit).toBe(false);
    expect(r.basis).toBe('refused');
    expect(r.refusals.some((x) => x.sha === spoof && x.role === 'author' && x.reason === 'unmappable')).toBe(true);
    expect((await defaultRunGit(['reset', '-q', '--hard', cleanForeignHead], work)).code).toBe(0);
  });

  it('a committer OUTSIDE the chain refuses even when the author is in-chain', async () => {
    const spoof = await commitAs(work, ORIGIN, 'i.txt', 'evil3\n', 'committer-spoof', OWNER);
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: spoof,
      stagingHead: staging,
      originGithubUserIds: [444],
    });
    expect(r.admit).toBe(false);
    expect(r.refusals.some((x) => x.sha === spoof && x.role === 'committer' && x.githubUserId === 111)).toBe(true);
    expect((await defaultRunGit(['reset', '-q', '--hard', cleanForeignHead], work)).code).toBe(0);
  });

  it('commits already reachable from staging are NOT judged (X2: only-foreign range)', async () => {
    // The canonical commits are authored by OWNER (111) — out of chain — yet a
    // foreign head built ON TOP of staging admits because ^staging excludes them.
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: cleanForeignHead,
      stagingHead: staging,
      originGithubUserIds: [444],
    });
    expect(r).toMatchObject({ admit: true, basis: 'clean' });
    expect(r.checkedIdentityIds).toEqual([444]); // 111 never judged
  });

  it('excludeReachableFrom widens the negative set (already-admitted canonical tips)', async () => {
    // Judge staging's own history as if it were foreign, excluding it via the arg:
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: cleanForeignHead,
      stagingHead: null,
      excludeReachableFrom: [staging],
      originGithubUserIds: [444],
    });
    expect(r).toMatchObject({ admit: true, basis: 'clean' });
    expect(r.rangeSize).toBe(1);
  });

  it('NO baseline exemption: null staging judges the FULL history (owner commits refuse)', async () => {
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: cleanForeignHead,
      stagingHead: null,
      originGithubUserIds: [444],
    });
    expect(r.admit).toBe(false);
    expect(r.basis).toBe('refused');
    // the two canonical OWNER commits are now in-range and out-of-chain
    expect(r.refusals.some((x) => x.githubUserId === 111)).toBe(true);
    expect(r.rangeSize).toBe(3);
  });

  it('an EMPTY origin chain fails CLOSED with an explicit contract error', async () => {
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: cleanForeignHead,
      stagingHead: staging,
      originGithubUserIds: [],
    });
    expect(r).toMatchObject({ admit: false, basis: 'error' });
    expect(r.errors[0]).toContain('empty origin chain');
  });

  it('a NON-foreign ref input fails CLOSED (caller bug, refused loudly)', async () => {
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: 'refs/heads/work',
      head: cleanForeignHead,
      stagingHead: staging,
      originGithubUserIds: [444],
    });
    expect(r).toMatchObject({ admit: false, basis: 'error' });
    expect(r.errors[0]).toContain('not in the foreign-marked family');
    expect(formatForeignRefusal(r)).toContain('fail-closed error');
  });

  it('a git failure (unknown sha) fails CLOSED', async () => {
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      stagingHead: staging,
      originGithubUserIds: [444],
    });
    expect(r).toMatchObject({ admit: false, basis: 'error' });
    expect(r.errors[0]).toContain('rev walk failed');
  });

  it('an over-long range fails CLOSED (split the deliverable)', async () => {
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: cleanForeignHead,
      stagingHead: null,
      originGithubUserIds: [444],
      maxRangeCommits: 2, // full history is 3
    });
    expect(r).toMatchObject({ admit: false, basis: 'error' });
    expect(r.errors[0]).toContain('refusing to judge');
  });

  it('resolveGithubUserId widens mapping (attestation-map email → in-chain id admits)', async () => {
    const corp = await commitAs(work, 'origin@corp.example', 'j.txt', 'corp\n', 'corp-email', 'origin@corp.example');
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: corp,
      stagingHead: staging,
      originGithubUserIds: [444],
      resolveGithubUserId: async (email) => (email === 'origin@corp.example' ? 444 : null),
    });
    expect(r).toMatchObject({ admit: true, basis: 'clean' });
    expect((await defaultRunGit(['reset', '-q', '--hard', cleanForeignHead], work)).code).toBe(0);
  });

  it('a resolver THROW leaves the identity unmappable → REFUSED (fail closed)', async () => {
    const corp = await commitAs(work, 'origin@corp.example', 'k.txt', 'corp2\n', 'corp-email-2', 'origin@corp.example');
    const r = await admitForeignMergeHead({
      repoPath: work,
      foreignRef: FOREIGN_REF,
      head: corp,
      stagingHead: staging,
      originGithubUserIds: [444],
      resolveGithubUserId: async () => {
        throw new Error('lookup down');
      },
    });
    expect(r.admit).toBe(false);
    expect(r.basis).toBe('refused');
    expect(r.refusals.every((x) => x.reason === 'unmappable')).toBe(true);
    expect((await defaultRunGit(['reset', '-q', '--hard', cleanForeignHead], work)).code).toBe(0);
  });
});
