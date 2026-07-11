import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensurePotGitRepo, writeNamespaceRef } from './storage';
import { WORK_REF, readStaging } from './integrator';
import { runIntegratorTick } from './integrator-tick';
import { runWorktreeBridgeTick } from './worktree-bridge-tick';
import { listIntegrationRequests } from './integration-requests';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, '../../../../../libs/papercusp/libs/db/sql/441-hive-integration-requests.sql');
const MIGRATION_554 = resolve(HERE, '../../../../../libs/papercusp/libs/db/sql/554-cup-lexicon-db-rename-phase1.sql');
function stripMeta(sql: string): string {
  return sql.split('\n').filter((l) => { const t = l.trim(); if (t.startsWith('\\')) return false; if (/^(begin|commit);$/i.test(t)) return false; return true; }).join('\n');
}
function keypair() { const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer(); return { pubkeyBase64, sign: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) }; }
async function git(args: string[], cwd: string): Promise<string> { const r = await defaultRunGit(args, cwd); expect(r.code, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0); return r.stdout.trim(); }
async function initWorktree(dir: string): Promise<void> { await mkdir(dir, { recursive: true }); await git(['init', '-q', '-b', 'main'], dir); await git(['config', 'user.name', 't'], dir); await git(['config', 'user.email', 't@t'], dir); }
async function importFromSrc(repoPath: string, srcPath: string, branch: string): Promise<void> { await git(['fetch', '-q', srcPath, `+refs/heads/${branch}:refs/bridge-import/${branch}`], repoPath); }

describe('LEGD REPRO — mirrors hive-git-drill.sh LEG D exact sequence (no git rm --cached, plain checkout main no -f)', () => {
  let db: FreshPgDb; let root: string; let repo: string; let src: string;
  const integrator = keypair(); const memberSteer = keypair(); const memberBelow = keypair();

  beforeAll(async () => {
    db = await createFreshPgDb('legdrepro');
    await db.sql.unsafe(stripMeta(readFileSync(MIGRATION, 'utf8')));
    await db.sql.unsafe(`ALTER TABLE harness_shared.hive_integration_requests ADD COLUMN IF NOT EXISTS pot_slug text`);
    await db.sql.unsafe(`UPDATE harness_shared.hive_integration_requests SET pot_slug = hive_slug WHERE pot_slug IS NULL`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.hive_integration_requests ALTER COLUMN pot_slug SET NOT NULL`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.hive_integration_requests DROP CONSTRAINT hive_integration_requests_pkey`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.hive_integration_requests ADD CONSTRAINT hive_integration_requests_pkey PRIMARY KEY (workspace_id, pot_slug, repo_key, device_pubkey, head_sha)`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.hive_integration_requests DROP COLUMN IF EXISTS hive_slug`);
    await db.sql.unsafe(stripMeta(readFileSync(MIGRATION_554, 'utf8')));
    root = await mkdtemp(join(tmpdir(), 'legdrepro-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensurePotGitRepo('hive-legdrepro', 'repo-legdrepro-' + process.pid);
    src = join(root, 'src');
    await initWorktree(src);
  }, 120_000);

  afterAll(async () => { delete process.env.PAPERCUSP_HIVE_GIT_ROOT; await db.cleanup(); await rm(root, { recursive: true, force: true }); });

  it('reproduces the drill sequence', async () => {
    await writeFile(join(src, 'f.txt'), 'steer-v1\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S1'], src);
    const steerSha = await git(['rev-parse', 'HEAD'], src);
    await importFromSrc(repo, src, 'main');
    await writeNamespaceRef(repo, memberSteer.pubkeyBase64, WORK_REF, steerSha);

    // EXACT drill sequence (no git rm --cached, no -f on final checkout)
    await git(['checkout', '-q', '--orphan', 'below'], src);
    await writeFile(join(src, 'below.txt'), 'below-v1\n');
    await git(['add', 'below.txt'], src);
    await git(['commit', '-q', '-m', 'below'], src);
    const belowSha = await git(['rev-parse', 'HEAD'], src);
    await importFromSrc(repo, src, 'below');
    await writeNamespaceRef(repo, memberBelow.pubkeyBase64, WORK_REF, belowSha);
    await git(['checkout', '-q', 'main'], src);

    const out = await runIntegratorTick({
      potHomeSlug: 'hive-legdrepro', workspaceId: 'ws-legdrepro', repoKey: 'repo-legdrepro-' + process.pid,
      memberDevicePubkeysBase64: [memberSteer.pubkeyBase64, memberBelow.pubkeyBase64],
      integratorDevicePubkeyBase64: integrator.pubkeyBase64,
      epoch: 1, priorSeq: 0, sign: integrator.sign,
      resolveTier: (dev) => (dev === memberSteer.pubkeyBase64 ? 'steer' : 'message'),
      deps: { isIntegrator: async () => true, sql: db.sql },
    });

    console.log('REPRO OUT:', JSON.stringify(out, null, 2));
    console.log('REPRO stagingIsSteerSha:', (await readStaging(repo, integrator.pubkeyBase64)) === steerSha);
  });
});
