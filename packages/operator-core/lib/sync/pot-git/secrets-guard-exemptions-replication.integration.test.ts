/**
 * secrets-guard-exemptions-replication — the TWO-PEER guard test for WI-10002785.
 *
 * THE BUG: a publish-guard secrets waiver lived only in the host-local
 * `harness_shared.secrets_guard_path_exemptions` table, so a false positive the pot
 * OWNER adjudicated on one machine re-refused on every joined peer that folded the same
 * history. Observed on the P-203 Mac VM, 2026-09-23: "publish guard refused
 * refs/heads/staging: refusing to publish — 34 secret(s)", every one waived on the tower.
 *
 * THE FIX: owner waivers ride the owner-SIGNED pot policy (`policy.secretsGuard`), and
 * the loader is the union of the host table and every verified pot-policy waiver.
 *
 * THIS TEST: two real PG databases, one per peer. Peer A (the owner) signs a waiver
 * through the production share path (`shareSecretsGuardPathExemptions` →
 * `mutateHivePolicyIfChanged` → `authorHivePolicy`). A's stored pot_policy row goes
 * through the production CDC value mapper (`outboxRowToLocalWriteOp`, the exact
 * reshaping the substrate drain applies), and peer B applies it through the production
 * verify-on-apply projection (`buildHivePolicyProjection`). B's loader then feeds B's
 * real `checkPublishGuard` over a real git range. What stands in for the network is only
 * the hyperbee transport, which is table-agnostic and covered by the federation suites.
 *
 *   • CONTROL: before replication, B refuses the range (the bug, reproduced).
 *   • FIX:     after replication, B admits it; B's own table is still empty.
 *   • RE-ARM:  the owner unsigns → B refuses again.
 *   • TEETH:   a waiver policy signed by a NON-owner key is dropped at B's apply, so B
 *              still refuses; and a member Swarm cannot sign one (`not_owner_swarm`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { hiveKeychainId } from '../../identity/hive-keypair';
import { insertHiveIfAbsent } from '../../hive-store';
import { getHivePolicy, upsertHivePolicyRow } from '../../hive-policy-store';
import { canonicalizeHivePolicy, hivePolicySignedBytes, withSecretsGuardExemptions } from '../../hive-policy-schema';
import type { AuthorHivePolicySeams } from '../../hive-policy-author';
import { buildHivePolicyProjection, type HivePolicyRow } from '../hyperbee/projections/hive-policy';
import { outboxRowToLocalWriteOp } from '../hyperbee/feature-issue-op-keys';
import { applyPot557RenameAndFixups } from '../hyperbee/__tests__/_hive-substrate-rig';
import { ensurePotGitRepo } from './storage';
import { checkPublishGuard } from './publish-guard';
import {
  loadSecretsGuardPathExemptions,
  listSecretsGuardPathExemptions,
  shareSecretsGuardPathExemptions,
  unshareSecretsGuardPathExemptions,
} from './secrets-guard-exemptions';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../../libs/papercusp/libs/db/sql');
const WS = 'ws-waiver-repl';
const HOME = 'alpha';
const WAIVED = 'libs/fixtures/pem.test.ts';

// The columns the policy store + projection touch (no triggers: the capture trigger is a
// generic to_jsonb(row), which is what reading the row back below reproduces).
const POT_POLICY_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.pot_policy (
    workspace_id text NOT NULL, harness_slug text NOT NULL,
    policy_json text NOT NULL, owner_pubkey text NOT NULL, signature text NOT NULL,
    policy_version integer NOT NULL DEFAULT 1, author_pubkey text,
    origin text NOT NULL DEFAULT 'local', fed_ts bigint, fed_hlc text,
    created_at bigint NOT NULL, updated_at bigint NOT NULL DEFAULT 0,
    CONSTRAINT hive_policy_pkey PRIMARY KEY (workspace_id, harness_slug)
  );
  CREATE TABLE IF NOT EXISTS harness_shared.secrets_guard_path_exemptions (
    workspace_id TEXT NOT NULL, path TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, path)
  );
`;

const ownerKp = generateEd25519KeypairDer();
let peerA: FreshPgDb;
let peerB: FreshPgDb;
let gitRoot: string;
let repo: string;
let base: string;
let withFinding: string;
let hlcCounter = 1000;

async function provisionPeer(name: string): Promise<FreshPgDb> {
  const db = await createFreshPgDb(name);
  await db.sql.unsafe(readFileSync(join(SQL_DIR, '184-hives-table.sql'), 'utf8'));
  await applyPot557RenameAndFixups(db.sql);
  await db.sql.unsafe(POT_POLICY_DDL);
  // Both peers know the pot identity (the owner minted it; the member joined it) — the
  // projection's verify trust anchor.
  await insertHiveIfAbsent(
    { workspaceId: WS, homeSlug: HOME, pubkeyBase64: ownerKp.pubkeyBase64, keychainId: hiveKeychainId(WS, HOME) },
    db.sql,
  );
  return db;
}

/** The owner's author seams, bound to peer A's database and the owner key. */
function ownerSeams(): { author: AuthorHivePolicySeams } {
  return {
    author: {
      resolveWorkspaceId: async (ws) => ws,
      readCurrent: (ws, slug) => getHivePolicy(ws, slug, peerA.sql),
      sign: async (_ws, _slug, bytes) => signWithPrivateKeyDer(ownerKp.privateKeyDer, bytes),
      loadOwnerPubkey: async () => ownerKp.pubkeyBase64,
      write: (input) => upsertHivePolicyRow(input, peerA.sql),
    },
  };
}

/** Replicate A's current pot_policy row to B: the production CDC mapper, then B's
 *  production verify-on-apply projection. Returns false when there is nothing to send. */
async function replicateAtoB(row?: Record<string, unknown>): Promise<void> {
  const source =
    row ??
    ((await peerA.sql`SELECT * FROM harness_shared.pot_policy WHERE workspace_id = ${WS} AND harness_slug = ${HOME}`)[0] as
      | Record<string, unknown>
      | undefined);
  if (!source) throw new Error('peer A has no pot_policy row to replicate');
  const op = outboxRowToLocalWriteOp({ table_name: 'pot_policy', op: 'put', key: HOME, ts: 1700, row: { ...source, origin: 'local' } });
  if (op.type !== 'put') throw new Error('expected a put op');
  hlcCounter += 1000;
  const projection = buildHivePolicyProjection({ workspaceId: WS, harnessSlug: HOME, sql: peerB.sql });
  await projection.writeToPg!(op.value as HivePolicyRow, {
    authorPubkey: 'peer-a-log',
    origin: 'remote',
    ts: hlcCounter,
    fedHlc: `${String(hlcCounter).padStart(15, '0')}:00000`,
  });
}

async function guardOnB() {
  return checkPublishGuard({
    repoPath: repo,
    fromOid: base,
    toOid: withFinding,
    workspaceId: WS,
    loadPathExemptions: (ws) => loadSecretsGuardPathExemptions(ws, peerB.sql),
  });
}

async function commit(files: Record<string, string>, parent?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'waiver-commit-'));
  try {
    const env = { ...process.env, GIT_AUTHOR_DATE: '1700000000', GIT_COMMITTER_DATE: '1700000000', GIT_INDEX_FILE: join(dir, 'index') };
    for (const [name, content] of Object.entries(files)) {
      const f = join(dir, 'blob');
      await writeFile(f, content, 'utf8');
      const sha = execFileSync('git', ['hash-object', '-w', f], { cwd: repo, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${sha},${name}`], { cwd: repo, env });
    }
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim();
    const args = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'waiver-replication'];
    if (parent) args.push('-p', parent);
    return execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

beforeAll(async () => {
  [peerA, peerB] = await Promise.all([provisionPeer('waiver-peer-a'), provisionPeer('waiver-peer-b')]);
  gitRoot = await mkdtemp(join(tmpdir(), 'waiver-repl-git-'));
  process.env.PAPERCUSP_HIVE_GIT_ROOT = gitRoot;
  repo = await ensurePotGitRepo('waiver-repl', 'repo-1');
  base = await commit({ 'README.md': 'clean' });
  // A credential-shaped fixture at the waived path — the only finding in the range.
  const fakeKey = ['AKIA', 'QRSTUVWXYZABCDEF'].join('');
  withFinding = await commit({ 'README.md': 'clean', [WAIVED]: `const k = 'AWS_ACCESS_KEY_ID=${fakeKey}';\n` }, base);
}, 120_000);

afterAll(async () => {
  delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
  await rm(gitRoot, { recursive: true, force: true }).catch(() => {});
  await Promise.all([peerA?.cleanup(), peerB?.cleanup()]);
});

describe('WI-10002785 — an owner-adjudicated secrets waiver reaches a joined peer', () => {
  it('CONTROL: before replication the peer re-refuses the owner-waived finding (the bug)', async () => {
    const res = await guardOnB();
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('secrets');
    expect(res.secretFindings.map((f) => f.path)).toEqual([WAIVED]);
  });

  it('FIX: the owner signs the waiver, it replicates, and the peer admits the range', async () => {
    const shared = await shareSecretsGuardPathExemptions(
      { workspaceId: WS, potHomeSlug: HOME, entries: [{ path: WAIVED, reason: 'test PEM fixture, not a live key' }] },
      ownerSeams(),
    );
    expect(shared.outcome).toBe('signed');

    await replicateAtoB();

    // B's OWN table is untouched — the waiver arrived through the signed policy.
    expect((await listSecretsGuardPathExemptions(WS, peerB.sql)).map((e) => [e.source, e.path, e.potHomeSlug])).toEqual([
      ['pot-policy', WAIVED, HOME],
    ]);
    const res = await guardOnB();
    expect(res.ok).toBe(true);
    expect(res.exemptedFindings.map((f) => f.path)).toEqual([WAIVED]);
  });

  it('idempotent: re-sharing the same waiver re-signs nothing', async () => {
    const again = await shareSecretsGuardPathExemptions(
      { workspaceId: WS, potHomeSlug: HOME, entries: [{ path: WAIVED, reason: 'test PEM fixture, not a live key' }] },
      ownerSeams(),
    );
    expect(again.outcome).toBe('unchanged');
  });

  it('RE-ARM: the owner unsigns the waiver and the peer refuses again', async () => {
    const unshared = await unshareSecretsGuardPathExemptions(
      { workspaceId: WS, potHomeSlug: HOME, paths: [WAIVED] },
      ownerSeams(),
    );
    expect(unshared.outcome).toBe('signed');
    await replicateAtoB();
    expect(await loadSecretsGuardPathExemptions(WS, peerB.sql)).toEqual(new Set());
    const res = await guardOnB();
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('secrets');
  });

  it('TEETH: a waiver policy signed by a non-owner key is dropped at apply, so the peer still refuses', async () => {
    const attacker = generateEd25519KeypairDer();
    const policyJson = canonicalizeHivePolicy(withSecretsGuardExemptions({}, [{ path: WAIVED, reason: 'forged' }]));
    const bytes = hivePolicySignedBytes({ workspaceId: WS, potHomeSlug: HOME, policyVersion: 99, canonicalPolicyJson: policyJson });
    await replicateAtoB({
      workspace_id: WS,
      harness_slug: HOME,
      policy_json: policyJson,
      owner_pubkey: attacker.pubkeyBase64,
      signature: signWithPrivateKeyDer(attacker.privateKeyDer, bytes).toString('base64'),
      policy_version: 99,
    });
    expect(await loadSecretsGuardPathExemptions(WS, peerB.sql)).toEqual(new Set());
    expect((await guardOnB()).refusalCode).toBe('secrets');
  });

  it('TEETH: a member Swarm (no pot key) cannot sign a replicated waiver', async () => {
    const member = await shareSecretsGuardPathExemptions(
      { workspaceId: WS, potHomeSlug: HOME, entries: [{ path: 'packages/', reason: 'member widening' }] },
      {
        author: {
          resolveWorkspaceId: async (ws) => ws,
          readCurrent: (ws, slug) => getHivePolicy(ws, slug, peerB.sql),
          loadOwnerPubkey: async () => null,
          write: (input) => upsertHivePolicyRow(input, peerB.sql),
        },
      },
    );
    expect(member.outcome).toBe('not_owner_swarm');
  });
});
