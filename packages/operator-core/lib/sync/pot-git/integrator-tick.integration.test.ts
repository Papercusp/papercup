/**
 * integrator-tick.integration.test.ts — P-203 runtime driver against a REAL
 * temp bare repo (git on PATH, no network, no PG — `resolveTier`/`sql` are
 * faked so the trust-gate leg never touches Postgres).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/integrator-tick.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign, createPrivateKey, type KeyObject } from 'node:crypto';
import { defaultRunGit, ensurePotGitRepo, writeNamespaceRef } from './storage';
import { WORK_REF, readStaging } from './integrator';
import { verifyStagingAdvance } from './staging-advance';
import { runIntegratorTick } from './integrator-tick';

interface KeyPair {
  pubBase64: string;
  sign: (bytes: Buffer) => Promise<Buffer>;
}

function makeDevice(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  const pubBase64 = spki.subarray(spki.length - 32).toString('base64');
  const der = (privateKey as KeyObject).export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return {
    pubBase64,
    sign: async (bytes: Buffer) => {
      const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
      return nodeSign(null, bytes, key);
    },
  };
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

describe('hive-git integrator-tick (real bare repo, faked trust + swarm seams)', () => {
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
});
