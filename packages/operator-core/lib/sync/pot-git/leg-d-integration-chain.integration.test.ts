/**
 * leg-d-integration-chain.integration.test.ts — P-305 (Leg D integration,
 * p2p-git-live-activation-2026-07-09) end-to-end chain against REAL
 * Postgres + a REAL bare pot-git repo: the integrator (P-203) computes +
 * publishes canonical staging from real member namespace heads, a below-steer
 * head lands in the REAL `harness_shared.pot_integration_requests` queue
 * with a visible (queryable) receipt, and the resulting signed staging-advance
 * drives the worktree-bridge (P-204) on a SEPARATE worktree — standing in for
 * "the OTHER machine" (see worktree-bridge.integration.test.ts's own
 * "without openDuplex the bridge serves from the local mirror (integrator-
 * machine path)" precedent for treating a second worktree over the same
 * local mirror as a second machine-view) — proving it ff-advances, and that
 * a dirty/locked file in that worktree is NEVER touched (G-7b).
 *
 * This is the missing END-TO-END proof: integrator-tick.integration.test.ts
 * fakes Postgres for the gate leg and never calls the worktree bridge;
 * worktree-bridge.integration.test.ts hand-builds its own staging-advance
 * envelopes and never calls the integrator or touches Postgres;
 * integration-requests.integration.test.ts drives the gate/queue directly and
 * never touches the integrator tick or the worktree bridge. Chaining all
 * three against real infra is exactly Leg D's acceptance bar
 * (p2p-git-live-activation-2026-07-09 P-305).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/leg-d-integration-chain.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensurePotGitRepo, readNamespaceRef, writeNamespaceRef } from './storage';
import { WORK_REF, readStaging } from './integrator';
import { buildSigrefs, SIGREFS_REF } from './sigrefs';
import type { SignedSnapshotFloor } from './signed-context';
import { hiveEffectFixture } from './hive-effect-authority.fixture';
import { runIntegratorTick } from './integrator-tick';
import { runWorktreeBridgeTick } from './worktree-bridge-tick';
import { listIntegrationRequests } from './integration-requests';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, '../../../../../libs/papercusp/libs/db/sql/441-hive-integration-requests.sql');
const MIGRATION_554 = resolve(HERE, '../../../../../libs/papercusp/libs/db/sql/554-cup-lexicon-db-rename-phase1.sql');

/** Strip psql meta + txn wrappers so sql.unsafe() can apply the file (§0 rule),
 *  mirroring integration-requests.integration.test.ts. */
function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

function keypair() {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkeyBase64, sign: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) };
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await defaultRunGit(args, cwd);
  expect(r.code, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

async function initWorktree(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(['init', '-q', '-b', 'main'], dir);
  await git(['config', 'user.name', 't'], dir);
  await git(['config', 'user.email', 't@t'], dir);
}

/** A commit minted in `src` (a separate worktree/repo) only exists in src's
 *  own object database — writeNamespaceRef(repoPath, ...) update-refs
 *  against the pot-git bare repo, which has never seen those objects, so it
 *  fails with "nonexistent object" unless they're transferred first. Mirrors
 *  the real publishToPeer() helper in worktree-bridge.integration.test.ts. */
async function importFromSrc(repoPath: string, srcPath: string, branch: string): Promise<void> {
  await git(['fetch', '-q', srcPath, `+refs/heads/${branch}:refs/bridge-import/${branch}`], repoPath);
}

const WS = 'ws-legd';
const POT_SLUG = 'hive-legd';
const REPO_KEY = 'repo-legd';

describe('Leg D chain (P-305): integrator-tick → real PG queue receipt → worktree-bridge-tick on a second worktree', () => {
  let db: FreshPgDb;
  let root: string;
  let repo: string;
  let src: string; // scratch worktree that mints real-content commits for the "steer" member
  const integrator = keypair();
  const memberSteer = keypair();
  const memberBelowSteer = keypair();
  // The integrator tick is an owner-key-gated hive effect (hive-effect-authority.ts):
  // without an `authority` whose hive_id matches `context`, it skips as
  // 'not-integrator' and never announces — which stranded this chain (WI-10003543).
  const owner = hiveEffectFixture(REPO_KEY);
  /** Signed-snapshot floors for the members' CURRENT heads — what the
   *  ref-announcement receiver would have accepted. Rebuilt per tick because a
   *  new work head changes the signed sigrefs the tick re-verifies. */
  async function acceptedFloors(): Promise<Record<string, SignedSnapshotFloor>> {
    const floors: Record<string, SignedSnapshotFloor> = {};
    for (const member of [memberSteer, memberBelowSteer]) {
      const signed = await buildSigrefs(repo, member.pubkeyBase64, member.sign, { nowMs: Date.now(), context: owner.context });
      const oid = await readNamespaceRef(repo, member.pubkeyBase64, SIGREFS_REF);
      if (!oid) throw new Error(`sigrefs ref missing for ${member.pubkeyBase64.slice(0, 12)}`);
      floors[member.pubkeyBase64] = { ...owner.context, version: signed.version, sigrefs_oid: oid };
    }
    return floors;
  }

  beforeAll(async () => {
    db = await createFreshPgDb('legd');
    await db.sql.unsafe(stripMeta(readFileSync(MIGRATION, 'utf8')));
    // mig 506/523 pot-rename + mig 554 (Slice H Phase 1) table rename predate a
    // hand-applied 441 replay — align column shape + table name in-place. The PK swap
    // (hive_slug -> pot_slug) is load-bearing: the accessor's ON CONFLICT targets a
    // constraint over the pot_slug tuple; an ADD-COLUMN-only patch leaves the PK on
    // hive_slug and 554's RENAME CONSTRAINT just renames the still-hive_slug-keyed PK.
    // The column-drop is EQUALLY load-bearing: 523 doesn't just swap the PK, it DROPS
    // hive_slug entirely — without replaying that, hive_slug survives as a stale NOT
    // NULL column with no default, and the accessor's INSERT (which only supplies
    // pot_slug) fails every write with a not-null violation, even though the PK is
    // already correctly pot_slug-keyed (found via WI-3465 integration-test verification
    // 2026-07-10 — a gap in this fixture's 523 replay, NOT a live-DB bug: the real
    // migration 523 already dropped this column on every real schema).
    await db.sql.unsafe(`ALTER TABLE harness_shared.hive_integration_requests ADD COLUMN IF NOT EXISTS pot_slug text`);
    await db.sql.unsafe(`UPDATE harness_shared.hive_integration_requests SET pot_slug = hive_slug WHERE pot_slug IS NULL`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.hive_integration_requests ALTER COLUMN pot_slug SET NOT NULL`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.hive_integration_requests DROP CONSTRAINT hive_integration_requests_pkey`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.hive_integration_requests ADD CONSTRAINT hive_integration_requests_pkey PRIMARY KEY (workspace_id, pot_slug, repo_key, device_pubkey, head_sha)`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.hive_integration_requests DROP COLUMN IF EXISTS hive_slug`);
    await db.sql.unsafe(stripMeta(readFileSync(MIGRATION_554, 'utf8')));

    root = await mkdtemp(join(tmpdir(), 'legd-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensurePotGitRepo(POT_SLUG, REPO_KEY);

    src = join(root, 'src');
    await initWorktree(src);
  }, 120_000);

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await db?.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it('integrates the steer-tier head, queues the below-steer head in REAL Postgres with a visible receipt, and signs a staging-advance', async () => {
    await writeFile(join(src, 'f.txt'), 'steer-v1\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S1'], src);
    const steerSha = await git(['rev-parse', 'HEAD'], src);
    await importFromSrc(repo, src, 'main');
    await writeNamespaceRef(repo, memberSteer.pubkeyBase64, WORK_REF, steerSha);

    // The below-steer member publishes its OWN (unrelated) head — never merged.
    await git(['checkout', '-q', '--orphan', 'below'], src);
    await git(['rm', '-rq', '--cached', '.'], src).catch(() => '');
    await writeFile(join(src, 'below.txt'), 'below-v1\n');
    await git(['add', 'below.txt'], src);
    await git(['commit', '-q', '-m', 'below'], src);
    const belowSha = await git(['rev-parse', 'HEAD'], src);
    await importFromSrc(repo, src, 'below');
    await writeNamespaceRef(repo, memberBelowSteer.pubkeyBase64, WORK_REF, belowSha);
    // `git rm -rq --cached .` above unstaged f.txt but left it on disk, so it's
    // now untracked in the 'below' branch view; switching back to 'main' (which
    // tracks f.txt) refuses without -f even though content is identical — force
    // it, since this is a scratch worktree with nothing worth preserving here.
    await git(['checkout', '-q', '-f', 'main'], src);

    const out = await runIntegratorTick({
      potHomeSlug: POT_SLUG,
      workspaceId: WS,
      repoKey: REPO_KEY,
      memberDevicePubkeysBase64: [memberSteer.pubkeyBase64, memberBelowSteer.pubkeyBase64],
      integratorDevicePubkeyBase64: integrator.pubkeyBase64,
      epoch: 1,
      priorSeq: 0,
      context: owner.context,
      acceptedSnapshots: await acceptedFloors(),
      authority: owner.authority,
      sign: integrator.sign,
      resolveTier: (dev) => (dev === memberSteer.pubkeyBase64 ? 'steer' : 'message'),
      deps: { isIntegrator: async () => true, sql: db.sql },
    });

    expect(out.ran).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.gated).toEqual({ integrated: 1, queued: 1, errors: 0 });
    expect(out.integration?.advanced).toBe(true);
    expect(out.integration?.staging).toBe(steerSha); // only the steer head merged
    expect(await readStaging(repo, integrator.pubkeyBase64)).toBe(steerSha);
    expect(out.announcement).not.toBeNull();
    expect(out.announcement?.staging_sha).toBe(steerSha);

    // The VISIBLE RECEIPT: the below-steer head is queryable in real Postgres,
    // pending, reason below-steer-tier — never silently merged, never dropped.
    const queued = await listIntegrationRequests({ workspaceId: WS, potSlug: POT_SLUG, repoKey: REPO_KEY }, db.sql);
    expect(queued).toHaveLength(1);
    expect(queued[0].devicePubkey).toBe(memberBelowSteer.pubkeyBase64);
    expect(queued[0].headSha).toBe(belowSha);
    expect(queued[0].state).toBe('pending');
    expect(queued[0].reason).toBe('below-steer-tier');

    (globalThis as unknown as { __legd: { steerSha: string; announcement: unknown } }).__legd = {
      steerSha,
      announcement: out.announcement,
    };
  });

  it("the OTHER machine's worktree advances ff-only from the integrator's real announcement (no openDuplex — objects already local, same precedent as worktree-bridge.integration.test.ts)", async () => {
    const { steerSha, announcement } = (globalThis as unknown as {
      __legd: { steerSha: string; announcement: import('./staging-advance').SignedStagingAdvance };
    }).__legd;

    const otherMachineWt = join(root, 'other-machine-wt');
    await initWorktree(otherMachineWt);

    const tickOut = await runWorktreeBridgeTick({
      bareRepoPath: repo,
      worktreePath: otherMachineWt,
      pending: [announcement],
      prior: { epochSeq: null, stagingSha: null },
      accept: { expectedContext: owner.context, expectedDevice: integrator.pubkeyBase64 },
    });

    expect(tickOut.ran).toBe(true);
    expect(tickOut.errors).toEqual([]);
    expect(tickOut.stoppedOnFetchFailure).toBe(false);
    expect(tickOut.results).toHaveLength(1);
    expect(tickOut.results[0].bridge.outcome).toBe('accepted');
    if (tickOut.results[0].bridge.outcome === 'accepted') {
      expect(tickOut.results[0].bridge.advance.outcome).toBe('advanced');
    }
    expect(tickOut.watermark).toEqual({ epochSeq: { epoch: 1, seq: 1 }, stagingSha: steerSha });

    expect(await git(['rev-parse', 'HEAD'], otherMachineWt)).toBe(steerSha);
    expect(await readFile(join(otherMachineWt, 'f.txt'), 'utf8')).toBe('steer-v1\n');
  });

  it("a locked/dirty file on the OTHER machine's worktree is NEVER touched (G-7b) — the advance defers instead of clobbering it", async () => {
    // A second integrator pass: the steer member publishes a NEW head.
    await writeFile(join(src, 'f.txt'), 'steer-v2\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S2'], src);
    const steerSha2 = await git(['rev-parse', 'HEAD'], src);
    await importFromSrc(repo, src, 'main');
    await writeNamespaceRef(repo, memberSteer.pubkeyBase64, WORK_REF, steerSha2);

    const out2 = await runIntegratorTick({
      potHomeSlug: POT_SLUG,
      workspaceId: WS,
      repoKey: REPO_KEY,
      memberDevicePubkeysBase64: [memberSteer.pubkeyBase64, memberBelowSteer.pubkeyBase64],
      integratorDevicePubkeyBase64: integrator.pubkeyBase64,
      epoch: 1,
      priorSeq: 1,
      context: owner.context,
      acceptedSnapshots: await acceptedFloors(),
      authority: owner.authority,
      sign: integrator.sign,
      resolveTier: (dev) => (dev === memberSteer.pubkeyBase64 ? 'steer' : 'message'),
      deps: { isIntegrator: async () => true, sql: db.sql },
    });
    expect(out2.integration?.advanced).toBe(true);
    expect(out2.integration?.staging).toBe(steerSha2);
    expect(out2.announcement).not.toBeNull();

    // A THIRD worktree — a fresh "other machine" that already caught up to
    // steerSha (v1), then has a locally dirty (uncommitted) f.txt — exactly
    // the file the incoming advance would overwrite (a live file lock's
    // edit shows up as git-dirty; see worktree-advance.ts's G-7b contract).
    const lockedWt = join(root, 'other-machine-wt-locked');
    await initWorktree(lockedWt);
    const seed = await runWorktreeBridgeTick({
      bareRepoPath: repo,
      worktreePath: lockedWt,
      pending: [(globalThis as unknown as { __legd: { announcement: import('./staging-advance').SignedStagingAdvance } }).__legd.announcement],
      prior: { epochSeq: null, stagingSha: null },
      accept: { expectedContext: owner.context, expectedDevice: integrator.pubkeyBase64 },
    });
    expect(seed.ran).toBe(true);
    expect(seed.results[0]?.bridge.outcome).toBe('accepted');

    // Now dirty f.txt locally (simulating a live editor holding it) BEFORE
    // the second advance arrives.
    await writeFile(join(lockedWt, 'f.txt'), 'locally-edited, uncommitted\n');

    const advanceOut = await runWorktreeBridgeTick({
      bareRepoPath: repo,
      worktreePath: lockedWt,
      pending: [out2.announcement!],
      prior: seed.watermark,
      accept: { expectedContext: owner.context, expectedDevice: integrator.pubkeyBase64 },
    });

    expect(advanceOut.ran).toBe(true);
    expect(advanceOut.errors).toEqual([]);
    expect(advanceOut.results).toHaveLength(1);
    const bridged = advanceOut.results[0].bridge;
    expect(bridged.outcome).toBe('accepted'); // staging (mirror) still advances
    if (bridged.outcome === 'accepted') {
      expect(bridged.advance.outcome).toBe('deferred-dirty'); // the WORKTREE is deferred, never clobbered
      expect(bridged.advance.dirtyOverlap).toEqual(['f.txt']);
    }
    // The dirty file's content is untouched — never overwritten by the advance.
    expect(await readFile(join(lockedWt, 'f.txt'), 'utf8')).toBe('locally-edited, uncommitted\n');
    expect(await git(['rev-parse', 'HEAD'], lockedWt)).toBe(
      (globalThis as unknown as { __legd: { steerSha: string } }).__legd.steerSha,
    ); // still at v1 — never advanced past the dirty overlap
  });
});
