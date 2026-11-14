/** Current-source background entry acceptance, invoked only by the maintained isolated runtime. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrgPg, _resetForTests as resetOrgPg } from '@papercusp/db-org';
import { configureLocks, getTxPool, _resetForTests as resetLocks } from '../lib/agent-tools/locks/su-lock-store';
import { requestOnlyHost } from '../lib/background-workers';
import { saveHarnessRegistry, loadHarnessRegistry } from '../lib/harness-registry';
import { fireGitSyncNow } from '../lib/harness/git-sync/git-sync-action';
import { readGitSyncCandidate, type RunGit } from '../lib/harness/git-sync/run-git-sync';
import { isCliEntry } from '../lib/util/cli-entry';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const argument = (name: string) => {
    const value = process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
    assert.ok(value, 'Missing ' + name);
    return value;
  };
  const evidenceDir = argument('evidence-dir');
  const planned = JSON.parse(readFileSync(argument('source-receipt'), 'utf8'));
  const root = resolve(import.meta.dirname, '../../..');
  assert.equal(planned.repoRoot, root);
  const measureSources = () => planned.files.map((file: { path: string; sha256: string; gitSha256: string | null }) => {
    assert.equal(digest(readFileSync(join(root, file.path))), file.sha256, 'current child source changed: ' + file.path);
    return { ...file };
  });
  const before = measureSources();
  const entry = fileURLToPath(import.meta.resolve('../lib/harness/git-sync/git-sync-action.ts'));
  assert.equal(entry, join(root, 'packages/operator-core/lib/harness/git-sync/git-sync-action.ts'));
  assert.equal((await import('../lib/harness/git-sync/git-sync-action')).fireGitSyncNow, fireGitSyncNow);
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
  assert.equal(requestOnlyHost(), false);
  assert.equal(process.env.PAPERCUSP_SID, undefined);
  const privateUrl = process.env.HARNESS_ADMIN_DATABASE_URL!;
  const target = new URL(privateUrl);
  assert.ok(process.env.HOME?.startsWith(resolve(tmpdir(), '..')));
  assert.equal(process.env.PAPERCUSP_HOME, join(process.env.HOME!, '.papercusp'));
  const repo = mkdtempSync(join(tmpdir(), 'metadata-background-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, String(result.stderr || result.stdout));
    return result.stdout.trim();
  };
  const runGit: RunGit = async (args, cwd, options) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ...options?.env } });
    return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  try {
    configureLocks({ getAdminBaseUrl: () => privateUrl });
    const { sql } = getOrgPg();
    const [database] = await sql`SELECT current_database() AS database, inet_server_port() AS port`;
    assert.equal(database.database, decodeURIComponent(target.pathname.slice(1)));
    assert.equal(database.port, Number(target.port));
    git('init', '-b', 'main');
    git('config', 'user.name', 'background metadata acceptance');
    git('config', 'user.email', 'test@papercusp.local');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, 'target'));
    mkdirSync(join(repo, 'packages/one'), { recursive: true });
    const manifest = { name: 'background-metadata-entry', version: '1.0.0', workspaces: ['packages/*'],
      dependencies: { target: 'file:./target' } };
    writeFileSync(join(repo, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(repo, 'target/package.json'), '{"name":"target","version":"1.0.0"}');
    writeFileSync(join(repo, 'packages/one/package.json'), '{"name":"one","version":"1.0.0"}');
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version,
      lockfileVersion: 3, packages: { '': manifest } }));
    writeFileSync(join(repo, '.npmrc'), 'legacy-peer-deps=false\n');
    writeFileSync(join(repo, 'caller.txt'), 'original caller source\n');
    git('add', '-A'); git('commit', '-m', 'selected private metadata fixture');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'caller.txt'), 'unrelated pre-staged caller source\n');
    git('add', '--', 'caller.txt');
    writeFileSync(join(repo, 'package-lock.json'), '{"pending":"caller bytes"}\n');
    const callerState = () => ({ index: readFileSync(join(repo, '.git/index')).toString('base64'),
      lock: readFileSync(join(repo, 'package-lock.json')).toString('base64'),
      source: readFileSync(join(repo, 'caller.txt')).toString('base64') });
    const original = callerState();
    const slug = 'metadata-background-entry';
    await saveHarnessRegistry({ projects: [{ slug, path: repo }] }, workspace);
    assert.equal((await loadHarnessRegistry(workspace)).projects.find(p => p.slug === slug)?.path, repo);
    await sql`INSERT INTO harness_shared.routines
      (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template,
        concurrency, catchup, active, next_fire_at, metadata)
      VALUES ('metadata-background-entry', ${workspace}, ${slug}, 'git-sync', 'cron', '{}'::jsonb,
        'system:git-sync', NULL, 'skip', 'skip-old', false, now(),
        ${sql.json({ preserved: 'unrelated routine metadata' })}::jsonb)`;
    const request = { requestId: 'background-entry', generation: 1, base,
      expectedPendingLockSha256: digest(readFileSync(join(repo, 'package-lock.json'))), publishedLibrarySelections: [] };
    // Exercise the real reader before the expensive repair. A missing capture
    // must be the one admission case; unreadable or conflicting custody is not.
    assert.deepEqual(await readGitSyncCandidate(runGit, repo, request), {
      ok: false, error: 'source-custody-refused:candidate-not-captured',
    });
    console.info('METADATA_BACKGROUND_ENTRY start');
    const first = await fireGitSyncNow(slug, workspace, repo, request);
    assert.ok(first.status === 'synced', JSON.stringify(first));
    assert.equal(first.committedCount, 1);
    assert.equal(first.metadataRepair?.publication, 'committed');
    assert.equal(first.metadataRepair?.remoteEgressConfirmed, false);
    assert.equal(first.metadataRepair?.routineMetadataRecorded, true);
    // The real lease acquisition owns creation of its separate locks database.
    // Read it only afterwards, then independently prove it used the private cluster.
    const [lockDatabase] = await getTxPool()`SELECT inet_server_port() AS port`;
    assert.equal(lockDatabase.port, database.port);
    assert.ok(first.metadataRepair?.sourceFingerprint.schemaVersion === 2);
    assert.deepEqual(first.metadataRepair.sourceFingerprint.publishedLibrarySelections, []);
    const commit = first.metadataRepair!.commit;
    assert.equal(git('rev-parse', 'HEAD'), commit);
    assert.equal(git('rev-parse', 'HEAD^'), base);
    assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', base, commit), 'package-lock.json');
    const generated = JSON.parse(git('show', 'HEAD:package-lock.json'));
    assert.equal(generated.packages.target.version, '1.0.0');
    assert.deepEqual(generated.packages['node_modules/target'], { resolved: 'target', link: true });
    assert.deepEqual(callerState(), original);
    const captured = await readGitSyncCandidate(runGit, repo, request);
    assert.equal(captured.ok, true);
    const replay = await fireGitSyncNow(slug, workspace, repo, request);
    assert.ok(replay.status === 'synced', JSON.stringify(replay));
    assert.equal(replay.committedCount, 0);
    assert.equal(replay.metadataRepair?.publication, 'already-published');
    assert.equal(replay.metadataRepair?.commit, commit);
    assert.deepEqual(await readGitSyncCandidate(runGit, repo, request), captured);
    const [routine] = await sql`SELECT metadata FROM harness_shared.routines
      WHERE workspace_id = ${workspace} AND install_slug = ${slug} AND name = 'git-sync'`;
    assert.equal(routine.metadata.head_sha, commit);
    assert.equal(routine.metadata.last_status, 'synced');
    assert.equal(routine.metadata.preserved, 'unrelated routine metadata');
    const stale = await fireGitSyncNow(slug, workspace, repo, { ...request, expectedPendingLockSha256: 'f'.repeat(64) });
    assert.equal(stale.status, 'error', JSON.stringify(stale));
    assert.ok('errors' in stale && stale.errors.some(error => error.message.includes('generated-lock-request-pending-mismatch')));
    assert.equal(git('rev-parse', 'HEAD'), commit);
    assert.deepEqual(callerState(), original);
    assert.deepEqual(await readGitSyncCandidate(runGit, repo, request), captured);
    assert.deepEqual(readdirSync(join(repo, '.git')).filter(name => name.startsWith('papercusp-')), []);
    const leases = await getTxPool()`SELECT owner FROM agent_resource_locks
      WHERE coordination_domain = ${workspace} AND resource = ${'git-sync:' + slug}`;
    assert.equal(leases.length, 0);
    writeFileSync(join(evidenceDir, 'background-entry-source.json'), JSON.stringify({ entry, before, after: measureSources() }), { flag: 'wx' });
    writeFileSync(join(evidenceDir, 'background-entry-proof.json'), JSON.stringify({
      backgroundWorkers: true, privateDatabase: true, database: { ...database, workspace },
      first, replay, stale, routine, callerStatePreserved: true, releasedLeaseCount: leases.length,
    }), { flag: 'wx' });
    console.info('METADATA_BACKGROUND_ENTRY passed');
  } finally {
    try { await resetLocks(); }
    finally {
      try { await resetOrgPg(); }
      finally {
        rmSync(repo, { recursive: true, force: true });
        writeFileSync(join(evidenceDir, 'background-entry-cleanup.json'), JSON.stringify({
          repositoryRemoved: !existsSync(repo), poolsClosed: true,
        }), { flag: 'wx' });
      }
    }
  }
}

if (isCliEntry(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
