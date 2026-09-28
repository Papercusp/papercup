/**
 * integrator-tick.integration.test.ts — P-203 runtime driver against a REAL
 * temp bare repo (git on PATH, no network, no PG — `resolveTier`/`sql` are
 * faked so the trust-gate leg never touches Postgres).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/integrator-tick.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign, createPrivateKey, type KeyObject } from 'node:crypto';
import { defaultRunGit, ensurePotGitRepo, writeNamespaceRef, readNamespaceRef } from './storage';
import { buildSigrefs, SIGREFS_REF } from './sigrefs';
import { makeSignedProtocolContext, type SignedSnapshotFloor } from './signed-context';
import { WORK_REF, readStaging } from './integrator';
import { verifyStagingAdvance } from './staging-advance';
import { resolveAnnouncementWatermark, runIntegratorTick as runIntegratorTickUnderTest } from './integrator-tick';
import { hiveEffectFixture } from './hive-effect-authority.fixture';
const testDeviceSigners = new Map<string, (bytes: Buffer) => Promise<Buffer>>();

interface KeyPair {
  pubBase64: string;
  sign: (bytes: Buffer) => Promise<Buffer>;
}

function makeDevice(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  const pubBase64 = spki.subarray(spki.length - 32).toString('base64');
  const der = (privateKey as KeyObject).export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const device = {
    pubBase64,
    sign: async (bytes: Buffer) => {
      const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
      return nodeSign(null, bytes, key);
    },
  };
  testDeviceSigners.set(pubBase64, device.sign);
  return device;
}

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

/** A minimal fake `postgres.Sql` for the ratify-queue leg (`listRatifiedStates` /
 *  `queueIntegrationRequest`): no rows ever ratified, every insert/delete is a
 *  no-op. Needs `.array` too — `listRatifiedStates` calls `sql.array(...)` to
 *  build its `UNNEST` clause. */
function fakeSql(): never {
  const fn = (async (strings: TemplateStringsArray) => {
    return strings.join('?').includes('SELECT') ? [] : [];
  }) as unknown as { (): Promise<unknown[]>; array: (a: unknown[]) => unknown[] };
  fn.array = (a: unknown[]) => a;
  return fn as never;
}

describe('pot-git integrator-tick (real bare repo, faked trust + swarm seams)', () => {
  let root: string;
  let repo: string;
  const integrator = makeDevice();
  const devA = makeDevice();
  const devB = makeDevice();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'integ-tick-it-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensurePotGitRepo('hive-i', 'repo-1');
  });
  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('no-ops (skipped: not-integrator) when we do not hold the lease', async () => {
    const out = await runIntegratorTick({
      potHomeSlug: 'hive-i',
      workspaceId: 'ws-1',
      repoKey: 'repo-1',
      memberDevicePubkeysBase64: [devA.pubBase64],
      integratorDevicePubkeyBase64: integrator.pubBase64,
      epoch: 1,
      priorSeq: 0,
      sign: integrator.sign,
      resolveTier: () => 'steer',
      deps: { isIntegrator: async () => false },
    });
    expect(out.ran).toBe(false);
    expect(out.skipped).toBe('not-integrator');
    expect(out.announcement).toBeNull();
  });

  it('P-513 integrates only a scoped snapshot matching the durable accepted floor and current heads', async () => {
    const scopedRepo = await ensurePotGitRepo('hive-i', 'scoped-admission');
    const scope = { hive_id: hiveEffectFixture().hiveId, repo_key: 'scoped-admission' };
    const own = makeSignedProtocolContext(scope.hive_id, scope.repo_key, `sg2-4-${'a'.repeat(40)}`);
    const peer = makeSignedProtocolContext(scope.hive_id, scope.repo_key, `sg2-3-${'b'.repeat(40)}`);
    const sha = await commit(scopedRepo, { 'accepted.txt': 'one' });
    await writeNamespaceRef(scopedRepo, devA.pubBase64, WORK_REF, sha);
    const signed = await buildSigrefs(scopedRepo, devA.pubBase64, devA.sign, { nowMs: 1, context: peer });
    const oid = (await readNamespaceRef(scopedRepo, devA.pubBase64, SIGREFS_REF))!;
    const invoke = (
      acceptedSnapshots: Record<string, SignedSnapshotFloor>,
      runGit = defaultRunGit,
    ) => runIntegratorTick({
      potHomeSlug: 'hive-i', workspaceId: 'ws-1', repoKey: 'scoped-admission',
      memberDevicePubkeysBase64: [devA.pubBase64], integratorDevicePubkeyBase64: integrator.pubBase64,
      epoch: 1, priorSeq: 0, context: own, acceptedSnapshots, sign: integrator.sign, resolveTier: () => 'steer',
      deps: { isIntegrator: async () => true, sql: fakeSql(), runGit },
    });
    const missingFloorGitCalls: string[][] = [];
    const missing = await invoke({}, async (args, cwd) => {
      missingFloorGitCalls.push([...args]);
      return defaultRunGit(args, cwd);
    });
    expect(missing.gated?.integrated).toBe(0);
    expect(missing.announcement).toBeNull();
    expect(
      missingFloorGitCalls.some((args) => args.some((arg) => arg.includes(SIGREFS_REF))),
      'a device with no accepted floor must not trigger any sigrefs Git read',
    ).toBe(false);
    const floor = { ...peer, version: signed.version, sigrefs_oid: oid };
    const wrongOid = await invoke({ [devA.pubBase64]: { ...floor, sigrefs_oid: 'c'.repeat(40) } });
    expect(wrongOid.gated?.integrated).toBe(0);
    const accepted = await invoke({ [devA.pubBase64]: floor });
    expect(accepted.errors).toEqual([]);
    expect(accepted.gated?.integrated).toBe(1);
    expect(accepted.announcement).toMatchObject({ v: 3, ...own, staging_sha: sha });
    const unsigned = await commit(scopedRepo, { 'unsigned.txt': 'two' }, sha);
    await writeNamespaceRef(scopedRepo, devA.pubBase64, WORK_REF, unsigned);
    const tampered = await invoke({ [devA.pubBase64]: floor });
    expect(tampered.gated?.integrated).toBe(0);
    expect(await readStaging(scopedRepo, integrator.pubBase64)).toBe(sha);
  });

  it('as the lease holder: integrates steer-tier heads and signs a valid staging-advance', async () => {
    const base = await commit(repo, { 'a.txt': 'a1' });
    await writeNamespaceRef(repo, devA.pubBase64, WORK_REF, base);

    const out = await runIntegratorTick({
      potHomeSlug: 'hive-i',
      workspaceId: 'ws-1',
      repoKey: 'repo-1',
      memberDevicePubkeysBase64: [devA.pubBase64],
      integratorDevicePubkeyBase64: integrator.pubBase64,
      epoch: 1,
      priorSeq: 0,
      sign: integrator.sign,
      resolveTier: () => 'steer',
      deps: { isIntegrator: async () => true, sql: fakeSql() },
    });

    expect(out.ran).toBe(true);
    expect(out.integration?.advanced).toBe(true);
    expect(out.integration?.staging).toBe(base);
    expect(out.gated).toEqual({ integrated: 1, queued: 0, errors: 0 });
    expect(await readStaging(repo, integrator.pubBase64)).toBe(base);

    expect(out.announcement).not.toBeNull();
    const ann = out.announcement!;
    expect(ann.epoch).toBe(1);
    expect(ann.seq).toBe(1); // priorSeq (0) + 1
    expect(ann.staging_sha).toBe(base);
    expect(ann.device_pubkey).toBe(integrator.pubBase64);
    expect(verifyStagingAdvance(ann)).toBe(true);
  });

  it('re-running with no new work is a no-op and produces no announcement', async () => {
    const out = await runIntegratorTick({
      potHomeSlug: 'hive-i',
      workspaceId: 'ws-1',
      repoKey: 'repo-1',
      memberDevicePubkeysBase64: [devA.pubBase64],
      integratorDevicePubkeyBase64: integrator.pubBase64,
      epoch: 1,
      priorSeq: 1,
      sign: integrator.sign,
      resolveTier: () => 'steer',
      deps: { isIntegrator: async () => true, sql: fakeSql() },
    });
    expect(out.gated).toEqual({ integrated: 1, queued: 0, errors: 0 });
    expect(out.integration?.advanced).toBe(false);
    expect(out.announcement).toBeNull();
  });

  it('below-steer-tier heads QUEUE instead of integrating (never silently merged)', async () => {
    const head = await commit(repo, { 'below.txt': 'x' });
    await writeNamespaceRef(repo, devB.pubBase64, WORK_REF, head);

    const out = await runIntegratorTick({
      potHomeSlug: 'hive-i',
      workspaceId: 'ws-1',
      repoKey: 'repo-1',
      memberDevicePubkeysBase64: [devA.pubBase64, devB.pubBase64],
      integratorDevicePubkeyBase64: integrator.pubBase64,
      epoch: 1,
      priorSeq: 1,
      sign: integrator.sign,
      // devA stays steer-tier (already contained in staging — a no-op re-admit);
      // devB is below-steer, so ONLY its head queues instead of integrating.
      resolveTier: (dev) => (dev === devB.pubBase64 ? 'message' : 'steer'),
      deps: { isIntegrator: async () => true, sql: fakeSql() },
    });

    expect(out.gated).toEqual({ integrated: 1, queued: 1, errors: 0 });
    expect(out.integration?.advanced).toBe(false);
    expect(out.announcement).toBeNull();
  });

  it('a namespace with only a branch-named ref (pre-WORK_REF-alias publisher) still gates via the default-branch fallback', async () => {
    // Live publishers write the checked-out branch ref; only post-alias code
    // also writes WORK_REF. The gate must not silently skip such a member.
    const devC = makeDevice();
    const defaultRef = (await defaultRunGit(['symbolic-ref', '-q', 'HEAD'], repo)).stdout.trim();
    expect(defaultRef).toMatch(/^refs\/heads\//);
    const head = await commit(repo, { 'legacy.txt': 'y' });
    await writeNamespaceRef(repo, devC.pubBase64, defaultRef, head);

    const out = await runIntegratorTick({
      potHomeSlug: 'hive-i',
      workspaceId: 'ws-1',
      repoKey: 'repo-1',
      memberDevicePubkeysBase64: [devC.pubBase64],
      integratorDevicePubkeyBase64: integrator.pubBase64,
      epoch: 1,
      priorSeq: 1,
      sign: integrator.sign,
      resolveTier: () => 'message',
      deps: { isIntegrator: async () => true, sql: fakeSql() },
    });

    // Seen (fallback read) and queued as below-steer — not invisible.
    expect(out.gated).toEqual({ integrated: 0, queued: 1, errors: 0 });
  });

  describe('integrator-is-the-author (lastAnnouncedStagingSha watermark)', () => {
    // Regression (hello-world-3-pot canary, 2026-07-18): when the integrator
    // machine's checked-out branch IS `staging`, own-head-publish (G-2a)
    // pre-advances ns/<integrator>/refs/heads/staging — the very ref
    // integrateMemberHeads uses as base+output — so `advanced` never trips and
    // NO announcement fires, even with the member head 8 commits past the last
    // announced canonical. The watermark input is what makes this case announce.
    const solo = makeDevice();

    it('advanced:false but behind the announced watermark → still announces', async () => {
      const repo2 = await ensurePotGitRepo('hive-i', 'repo-2');
      const head = await commit(repo2, { 's.txt': 'v1' });
      // Simulate own-head-publish: BOTH the work alias and the integrator's
      // own staging ref already sit at the new head before the tick runs.
      await writeNamespaceRef(repo2, solo.pubBase64, WORK_REF, head);
      await writeNamespaceRef(repo2, solo.pubBase64, 'refs/heads/staging', head);

      const out = await runIntegratorTick({
        potHomeSlug: 'hive-i',
        workspaceId: 'ws-1',
        repoKey: 'repo-2',
        memberDevicePubkeysBase64: [solo.pubBase64],
        integratorDevicePubkeyBase64: solo.pubBase64,
        epoch: 1,
        priorSeq: 0,
        lastAnnouncedStagingSha: null, // never announced anything
        sign: solo.sign,
        resolveTier: () => 'steer',
        deps: { isIntegrator: async () => true, sql: fakeSql() },
      });
      expect(out.integration?.advanced).toBe(false); // the ref did not move this pass
      expect(out.integration?.staging).toBe(head);
      expect(out.announcement).not.toBeNull(); // …but the advance was never announced
      expect(out.announcement!.staging_sha).toBe(head);
      expect(verifyStagingAdvance(out.announcement!)).toBe(true);
    });

    it('watermark caught up → no announcement (no per-tick re-announce loop)', async () => {
      const repo2 = await ensurePotGitRepo('hive-i', 'repo-2');
      const head = await readStaging(repo2, solo.pubBase64);
      const out = await runIntegratorTick({
        potHomeSlug: 'hive-i',
        workspaceId: 'ws-1',
        repoKey: 'repo-2',
        memberDevicePubkeysBase64: [solo.pubBase64],
        integratorDevicePubkeyBase64: solo.pubBase64,
        epoch: 1,
        priorSeq: 1,
        lastAnnouncedStagingSha: head, // acceptance already recorded this staging
        sign: solo.sign,
        resolveTier: () => 'steer',
        deps: { isIntegrator: async () => true, sql: fakeSql() },
      });
      expect(out.integration?.advanced).toBe(false);
      expect(out.announcement).toBeNull();
    });

    // WI-10003781 (P-505 run 26): the bridge leg runs AFTER the integrator leg and
    // is the only writer of worktree_bridge.stagingSha, so a second integrator
    // pass inside that window saw the PREVIOUS staging and signed the same sha
    // again under seq+1 (2d936ad7f978 announced as seq 54 AND seq 55).
    it('a second pass while the bridge watermark still lags does NOT re-announce the same staging', async () => {
      const repo3 = await ensurePotGitRepo('hive-i', 'repo-3');
      const head = await commit(repo3, { 's.txt': 'v1' });
      await writeNamespaceRef(repo3, solo.pubBase64, WORK_REF, head);
      await writeNamespaceRef(repo3, solo.pubBase64, 'refs/heads/staging', head);
      const term = { epoch: 1, authorityDevice: solo.pubBase64, storeGeneration: 'sg-test' };
      const staleBridgeWatermark: string | null = null; // the bridge has not accepted anything yet
      const tick = (priorSeq: number, lastAnnouncedStagingSha: string | null) =>
        runIntegratorTick({
          potHomeSlug: 'hive-i',
          workspaceId: 'ws-1',
          repoKey: 'repo-3',
          memberDevicePubkeysBase64: [solo.pubBase64],
          integratorDevicePubkeyBase64: solo.pubBase64,
          epoch: term.epoch,
          priorSeq,
          lastAnnouncedStagingSha,
          sign: solo.sign,
          resolveTier: () => 'steer',
          deps: { isIntegrator: async () => true, sql: fakeSql() },
        });

      const first = await tick(0, resolveAnnouncementWatermark(null, term, staleBridgeWatermark));
      expect(first.announcement?.staging_sha).toBe(head);
      // What runIntegratorLeg persists into metadata.integrator after emitting.
      const persisted = { ...term, seq: first.announcement!.seq, stagingSha: first.announcement!.staging_sha };

      const second = await tick(persisted.seq, resolveAnnouncementWatermark(persisted, term, staleBridgeWatermark));
      expect(second.integration?.staging).toBe(head);
      expect(second.announcement).toBeNull();

      // Control: the bridge watermark alone (the pre-fix input) re-announces.
      const legacy = await tick(persisted.seq, staleBridgeWatermark);
      expect(legacy.announcement?.staging_sha).toBe(head);
      expect(legacy.announcement?.seq).toBe(persisted.seq + 1);
    });
  });
});

/** Legacy integration scenarios still prepare real signed member snapshots;
 * the focused P513 case passes its own floors, including deliberately bad ones. */
async function runIntegratorTick(input: Parameters<typeof runIntegratorTickUnderTest>[0]) {
  const owner = hiveEffectFixture(input.repoKey);
  const context = input.context ?? owner.context;
  const acceptedSnapshots: Record<string, SignedSnapshotFloor> = input.acceptedSnapshots ? { ...input.acceptedSnapshots } : {};
  if (input.acceptedSnapshots === undefined) {
    const repo = input.deps?.repoPath ?? await ensurePotGitRepo(input.potHomeSlug, input.repoKey);
    for (const device of input.memberDevicePubkeysBase64) {
      const sign = testDeviceSigners.get(device);
      if (!sign) throw new Error('test signer missing');
      const signed = await buildSigrefs(repo, device, sign, { nowMs: 1, context });
      const oid = (await readNamespaceRef(repo, device, SIGREFS_REF))!;
      acceptedSnapshots[device] = { ...context, version: signed.version, sigrefs_oid: oid };
    }
  }
  return runIntegratorTickUnderTest({ ...input, context, acceptedSnapshots, authority: owner.authority });
}
