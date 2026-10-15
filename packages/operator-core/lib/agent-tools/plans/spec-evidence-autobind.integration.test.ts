import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ db: null as FreshPgDb | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(_workspaceId: string, fn: (tx: FreshPgDb['sql']) => Promise<T>) => fn(h.db!.sql),
}));

const { defaultAutobindDeps, decideAutobind, runKey } = await import('./spec-evidence-autobind');
const file = 'test/feature.test.ts';
const target = { workspaceId: 'ws', harnessSlug: 'app', planSlug: 'plan', specId: 'SPEC-1',
  specRevision: 1, workItemId: 'WI-1', barKey: 'R-1', testFile: file };
const sha = 'a'.repeat(40);

beforeAll(async () => {
  h.db = await createFreshPgDb('spec-evidence-autobind');
  await h.db.sql.unsafe(`CREATE TABLE harness_shared.test_runs (
    id bigint GENERATED ALWAYS AS IDENTITY, workspace_id text, harness_slug text,
    file_path text, status text, source text DEFAULT 'local', commit_sha text,
    worktree_dirty boolean, started_at timestamptz DEFAULT now(), finished_at timestamptz DEFAULT now())`);
}, 90_000);
afterAll(async () => { await h.db?.cleanup(); });
beforeEach(async () => { await h.db!.sql`TRUNCATE harness_shared.test_runs RESTART IDENTITY`; });

describe('autobind selects containing-commit proof from the real ledger', () => {
  it('keeps a clean pass when newer passes are dirty, unknown, commitless, or malformed', async () => {
    await h.db!.sql`
      INSERT INTO harness_shared.test_runs (workspace_id,harness_slug,file_path,status,commit_sha,worktree_dirty) VALUES
      ('ws','app',${file},'pass',${sha},false),
      ('ws','app',${file},'pass',${sha},true),
      ('ws','app',${file},'pass',${sha},NULL),
      ('ws','app',${file},'pass',NULL,false),
      ('ws','app',${file},'pass','abc',false),
      ('foreign','app',${file},'pass',${sha},false),
      ('ws','other',${file},'pass',${sha},false)`;
    const selected = (await defaultAutobindDeps().loadLatestRuns('ws', [target])).get(runKey('app', file));
    expect(selected).toMatchObject({ id: 1, status: 'pass', commitSha: sha, worktreeDirty: false });
    expect(decideAutobind(target, selected!, [])).toMatchObject({ kind: 'bind', run: { id: 1 } });
  });

  it('does not resurrect an old clean pass after a dirty failure or error', async () => {
    for (const status of ['fail', 'error']) {
      await h.db!.sql`TRUNCATE harness_shared.test_runs RESTART IDENTITY`;
      await h.db!.sql`
        INSERT INTO harness_shared.test_runs (workspace_id,harness_slug,file_path,status,commit_sha,worktree_dirty) VALUES
        ('ws','app',${file},'pass',${sha},false),
        ('ws','app',${file},${status},${sha},true),
        ('ws','app',${file},'pass',${sha},true)`;
      const selected = (await defaultAutobindDeps().loadLatestRuns('ws', [target])).get(runKey('app', file));
      expect(selected).toMatchObject({ id: 2, status, worktreeDirty: true });
      expect(decideAutobind(target, selected!, [{ id: 7, testRunId: 1, evidenceRef: file,
        observedAt: new Date().toISOString() }])).toMatchObject({ kind: 'retract', bindingIds: [7] });
    }
  });

  it('ignores mutation calibration, old runs and unqualified passes', async () => {
    await h.db!.sql`
      INSERT INTO harness_shared.test_runs (workspace_id,harness_slug,file_path,status,commit_sha,worktree_dirty,source,started_at) VALUES
      ('ws','app',${file},'pass',${sha},false,'mutation-probe',now()),
      ('ws','app',${file},'pass',${sha},false,'local',now()-interval '15 days'),
      ('ws','app',${file},'pass',${sha},true,'local',now())`;
    expect(await defaultAutobindDeps().loadLatestRuns('ws', [target])).toEqual(new Map());
  });
});
