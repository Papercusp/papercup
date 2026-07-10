/**
 * foreign-mirror-quarantine.integration.test.ts — P-109 legs (iii)+(iv)
 * (p2p-work-distribution-2026-07-02, leader-ratified Q4/Q5 2026-07-03):
 * provision a foreign clone (--no-local, PRIVATE ODB — X4), do foreign work in
 * it, then host-side quarantine-fetch + judge: clean work ADMITS; oversize
 * blobs, secrets, identity spoofs, and object floods REFUSE — and refused
 * objects never touch the target repo's ODB. Real git, injected registry
 * seams (no PG).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/foreign-mirror-quarantine.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRunGit } from './storage';
import { quarantineFetchAndJudge } from './foreign-mirror-quarantine';
import {
  privateOdbViolation,
  provisionForeignClone,
} from '../../p2p/foreign-clone';
import type { ForeignWorkspace, RegisterResult } from '../../p2p/foreign-workspaces';

const ORIGIN = '444+origin-user@users.noreply.github.com'; // attested (id 444)
const OWNER = '111+host-owner@users.noreply.github.com'; // spoof target
const FOREIGN_REF = 'refs/foreign/fleet-x/results/offer-q1';

/** Registry seam: in-memory register/park (the PG store is mig-467-backed prod wiring). */
function memRegistry() {
  const parked: { offerId: string; reason: string }[] = [];
  const register = async (
    i: Parameters<typeof provisionForeignClone>[0] extends { register?: (x: infer A) => Promise<RegisterResult> } ? A : never,
  ): Promise<RegisterResult> => ({
    ok: true,
    workspace: {
      workspaceId: i.workspaceId,
      offerId: i.offerId,
      fleetSlug: i.fleetSlug,
      originGithubUserId: i.originGithubUserId,
      executorDevice: i.executorDevice,
      rootPath: i.rootPath,
      clonePath: i.clonePath,
      sessionId: null,
      executionEpoch: i.executionEpoch ?? 0,
      state: 'provisioning',
      parkReason: null,
      baseSha: null,
    } satisfies ForeignWorkspace,
  });
  const park = async (offerId: string, reason: string) => {
    parked.push({ offerId, reason });
  };
  return { register, park, parked };
}

async function commitAs(
  work: string,
  authorEmail: string,
  path: string,
  content: string,
  msg: string,
  committerEmail: string = authorEmail,
): Promise<string> {
  await mkdir(join(work, path, '..'), { recursive: true }).catch(() => {});
  await writeFile(join(work, path), content);
  expect((await defaultRunGit(['add', '-A'], work)).code).toBe(0);
  const c = await defaultRunGit(
    ['-c', 'user.name=t', '-c', `user.email=${committerEmail}`, 'commit', '-q', '-m', msg, `--author=t <${authorEmail}>`],
    work,
  );
  expect(c.code, c.stderr).toBe(0);
  return (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
}

async function targetHasObject(repo: string, oid: string): Promise<boolean> {
  return (await defaultRunGit(['cat-file', '-e', oid], repo)).code === 0;
}

describe('P-109 legs iv+iii: foreign clone provision → quarantine fetch + judge', () => {
  let root: string;
  let hostRepo: string; // the host source/target repo
  let hostTip: string;
  let foreignRoot: string; // Q1-valid foreign root (outside "workspace root")
  let clonePath: string;
  const workspaceRoot = '/nonexistent-workspace-root-for-q1'; // nothing is inside it

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'p109-'));
    hostRepo = join(root, 'host-repo');
    expect((await defaultRunGit(['init', '-q', '-b', 'staging', hostRepo], root)).code).toBe(0);
    await commitAs(hostRepo, OWNER, 'host.txt', 'host base\n', 'h0');
    hostTip = await commitAs(hostRepo, OWNER, 'host.txt', 'host one\n', 'h1');
    foreignRoot = join(root, 'foreign-work', 'fleet-x', 'offer-q1');
    await mkdir(foreignRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('leg iv: provisions a --no-local clone with a PRIVATE ODB (X4)', async () => {
    const reg = memRegistry();
    const r = await provisionForeignClone({
      sourceRepoPath: hostRepo,
      workspaceId: 'ws-1',
      offerId: 'offer-q1',
      fleetSlug: 'fleet-x',
      originGithubUserId: 444,
      executorDevice: 'dev-exec',
      rootPath: foreignRoot,
      branch: 'staging',
      workspaceRoot,
      register: reg.register,
      park: reg.park,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    clonePath = r.clonePath;
    expect(await privateOdbViolation(clonePath)).toBeNull();
    expect(reg.parked).toEqual([]);
    // The clone genuinely holds the history (own ODB, not alternates).
    expect(await targetHasObject(clonePath, hostTip)).toBe(true);
  });

  it('leg iv: the Q1 invariant refuses a root inside the workspace root', async () => {
    const reg = memRegistry();
    const r = await provisionForeignClone({
      sourceRepoPath: hostRepo,
      workspaceId: 'ws-1',
      offerId: 'offer-bad-root',
      fleetSlug: 'fleet-x',
      originGithubUserId: 444,
      executorDevice: 'dev-exec',
      rootPath: join(root, 'inside', 'offer-bad'), // inside workspaceRoot below
      workspaceRoot: root,
      register: undefined, // must not be reached — invariant refuses first…
      park: reg.park,
    });
    // …but register IS the invariant carrier; with the real store it refuses.
    // Here we assert the pure predicate path via the store-level helper:
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(['invariant', 'conflict']).toContain(r.refusal.code);
  });

  it('leg iii: clean in-chain foreign work ADMITS; identity result threads the offer id', async () => {
    // Foreign session does honest work in its clone.
    await commitAs(clonePath, ORIGIN, 'deliverable.txt', 'result v1\n', 'f1');
    const head = await commitAs(clonePath, ORIGIN, 'deliverable.txt', 'result v2\n', 'f2');
    const r = await quarantineFetchAndJudge({
      targetRepoPath: hostRepo,
      foreignClonePath: clonePath,
      sourceBranch: 'staging',
      foreignRef: FOREIGN_REF,
      targetTip: hostTip,
      originGithubUserIds: [444],
      offerId: 'offer-q1',
      keepOnRefusal: false,
    });
    expect(r.admit, JSON.stringify({ code: r.refusalCode, errors: r.errors })).toBe(true);
    expect(r.head).toBe(head);
    expect(r.refusalCode).toBeNull();
    expect(r.identity?.admit).toBe(true);
    expect(r.identity?.offerId).toBe('offer-q1');
    expect(r.newObjectCount).toBeGreaterThan(0);
    expect(r.quarantinePath).toBeTruthy();
    // Admitted objects are IN QUARANTINE, not yet in the target ODB.
    expect(await targetHasObject(hostRepo, head)).toBe(false);
    await rm(r.quarantinePath as string, { recursive: true, force: true });
  });

  it('leg iii: an oversize blob REFUSES and never touches the target ODB (X4)', async () => {
    const big = 'x'.repeat(2048);
    const sha = await commitAs(clonePath, ORIGIN, 'huge.bin', big, 'big blob');
    const r = await quarantineFetchAndJudge({
      targetRepoPath: hostRepo,
      foreignClonePath: clonePath,
      sourceBranch: 'staging',
      foreignRef: FOREIGN_REF,
      targetTip: hostTip,
      originGithubUserIds: [444],
      offerId: 'offer-q1',
      caps: { maxBlobBytes: 1024 },
    });
    expect(r.admit).toBe(false);
    expect(r.refusalCode).toBe('blob-over-cap');
    expect(r.oversizeBlobs.some((b) => b.path === 'huge.bin' && b.bytes === 2048)).toBe(true);
    expect(await targetHasObject(hostRepo, sha)).toBe(false);
    expect(r.quarantinePath).toBeNull(); // removed on refusal
    await defaultRunGit(['reset', '-q', '--hard', 'HEAD~1'], clonePath);
  });

  it('leg iii: a secret in new content REFUSES (G-10 sibling)', async () => {
    await commitAs(
      clonePath,
      ORIGIN,
      'config.ts',
      'export const AWS_KEY = "AKIA' + 'IOSFODNN7EXAMPLE";\n',
      'oops secret',
    );
    const r = await quarantineFetchAndJudge({
      targetRepoPath: hostRepo,
      foreignClonePath: clonePath,
      sourceBranch: 'staging',
      foreignRef: FOREIGN_REF,
      targetTip: hostTip,
      originGithubUserIds: [444],
      offerId: 'offer-q1',
    });
    expect(r.admit).toBe(false);
    expect(r.refusalCode).toBe('secrets');
    expect(r.secretFindings.length).toBeGreaterThan(0);
    await defaultRunGit(['reset', '-q', '--hard', 'HEAD~1'], clonePath);
  });

  it('leg iii: the X2 author spoof REFUSES at the quarantine (early-loud P-110)', async () => {
    await commitAs(clonePath, OWNER, 'spoof.txt', 'evil\n', 'spoofed', ORIGIN);
    const r = await quarantineFetchAndJudge({
      targetRepoPath: hostRepo,
      foreignClonePath: clonePath,
      sourceBranch: 'staging',
      foreignRef: FOREIGN_REF,
      targetTip: hostTip,
      originGithubUserIds: [444],
      offerId: 'offer-q1',
    });
    expect(r.admit).toBe(false);
    expect(r.refusalCode).toBe('identity');
    expect(r.identity?.basis).toBe('refused');
    expect(r.identity?.refusals.some((x) => x.githubUserId === 111)).toBe(true);
    await defaultRunGit(['reset', '-q', '--hard', 'HEAD~1'], clonePath);
  });

  it('leg iii: object flood REFUSES (D-014 posture)', async () => {
    await commitAs(clonePath, ORIGIN, 'flood.txt', 'many\n', 'flood');
    const r = await quarantineFetchAndJudge({
      targetRepoPath: hostRepo,
      foreignClonePath: clonePath,
      sourceBranch: 'staging',
      foreignRef: FOREIGN_REF,
      targetTip: hostTip,
      originGithubUserIds: [444],
      offerId: 'offer-q1',
      caps: { maxNewObjects: 1 },
    });
    expect(r.admit).toBe(false);
    expect(r.refusalCode).toBe('object-flood');
    await defaultRunGit(['reset', '-q', '--hard', 'HEAD~1'], clonePath);
  });
});
