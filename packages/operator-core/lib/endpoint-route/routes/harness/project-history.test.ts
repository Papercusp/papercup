import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveHarnessRepoRoot = vi.fn();
const sqlUnsafe = vi.fn();
const execFileMock = vi.fn();

vi.mock('../../../harness/docs/harness-repo', () => ({
  resolveHarnessRepoRoot: (...args: unknown[]) => resolveHarnessRepoRoot(...args),
}));

vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));

// PARTIAL mock: other modules in this route's graph import `generated` from the same
// package, so replacing it wholesale fails collection rather than the assertion.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getOrgPg: () => ({ sql: { unsafe: (...args: unknown[]) => sqlUnsafe(...args) } }),
}));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import routeDefinition, { resolvePageWindow } from './project-history';
import { PROJECT_HISTORY_MAX_PAGE_SIZE, PROJECT_HISTORY_PAGE_SIZE } from './project-history-source';

type RouteDefinition = {
  path: string;
  auth: string;
  timeoutSec: number;
  handler: (request: Request, context: { params: Record<string, string> }) => Promise<Response>;
};

const route = routeDefinition as unknown as RouteDefinition;

const PLAN_MARKDOWN = [
  '---',
  'slug: demo-plan',
  'title: Demo plan',
  'status: shipped',
  '---',
  '',
  // NOT `## Now` — the parser consumes that heading as the state/next block and
  // never reads items out of it, which makes a fixture placed there silently empty.
  '## Items',
  '',
  '- **P-001** `done` Ship the thing ← WI-1234 completed',
  '',
].join('\n');

/** Route the fixture by which relation the SQL names, so a mis-scoped read is visible. */
function respondToQuery(text: string): Record<string, unknown>[] {
  if (text.includes('count(*)')) return [{ total: 7 }];
  if (text.includes('harness_plans')) {
    return [{ plan_slug: 'demo-plan', content: PLAN_MARKDOWN, updated_at: '2026-09-01T00:00:00.000Z' }];
  }
  if (text.includes('work_items')) {
    return [{
      feature_id: 'WI-1234',
      item_kind: 'bug',
      title: 'Fix the thing',
      status: 'done',
      closed_ts: '2026-09-01T00:00:00.000Z',
      authority: 'committed',
      payload: { _completionEvidence: { summary: 'fixed and verified' } },
      source_plan_slug: 'demo-plan',
    }];
  }
  throw new Error(`unexpected query: ${text}`);
}

// The route asks the filesystem whether the resolved root is a git checkout, so the
// fixture must be a REAL directory rather than a synthetic path string.
let repoRoot: string;
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'project-history-route-'));
  tempRoots.push(repoRoot);
  await mkdir(join(repoRoot, '.git'));
  resolveHarnessRepoRoot.mockReset().mockResolvedValue(repoRoot);
  sqlUnsafe.mockReset().mockImplementation(async (text: string) => respondToQuery(text));
  execFileMock.mockReset().mockImplementation((
    _command: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => callback(null, ''));
});

describe('GET /harness/:slug/project-history', () => {
  it('registers a loopback-only route', () => {
    expect(route.path).toBe('/harness/:slug/project-history');
    expect(route.auth).toBe('loopback');
    expect(route.timeoutSec).toBe(60);
  });

  it('rejects an invalid slug before resolving a repository', async () => {
    const response = await route.handler(
      new Request('http://127.0.0.1/api/harness/not%20valid/project-history'),
      { params: { slug: 'not valid' } },
    );

    expect(response.status).toBe(400);
    expect(resolveHarnessRepoRoot).not.toHaveBeenCalled();
  });

  it('maps an unknown project to 404', async () => {
    resolveHarnessRepoRoot.mockResolvedValue(null);
    const response = await route.handler(
      new Request('http://127.0.0.1/api/harness/missing/project-history'),
      { params: { slug: 'missing' } },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'unknown project: missing' });
  });

  it('serves a bounded page assembled straight from Postgres', async () => {
    const response = await route.handler(
      new Request('http://127.0.0.1/api/harness/demo/project-history'),
      { params: { slug: 'demo' } },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      schemaVersion: number;
      plans: Array<{ slug: string; completedItems: Array<{ id: string; completionSummary: string | null }> }>;
      page: { count: number; total: number; offset: number; limit: number; hasMore: boolean };
    };
    expect(body.schemaVersion).toBe(2);
    expect(body.plans.map((plan) => plan.slug)).toEqual(['demo-plan']);
    // The whole point of reading PG directly: the work item's real completion
    // evidence rides along, rather than the plan-marker stub.
    expect(body.plans[0]?.completedItems[0]).toMatchObject({
      id: 'WI-1234',
      completionSummary: 'fixed and verified',
    });
    expect(body.page).toEqual({
      count: 1,
      total: 7,
      offset: 0,
      limit: PROJECT_HISTORY_PAGE_SIZE,
      hasMore: true,
    });
  });

  it('passes the caller window into the plan read and reports the last page', async () => {
    const response = await route.handler(
      new Request('http://127.0.0.1/api/harness/demo/project-history?limit=3&offset=6'),
      { params: { slug: 'demo' } },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { page: { offset: number; limit: number; hasMore: boolean } };
    expect(body.page).toMatchObject({ offset: 6, limit: 3, hasMore: false });
    const planQuery = sqlUnsafe.mock.calls.find(([text]) => String(text).includes('harness_plans')
      && String(text).includes('LIMIT'));
    expect(planQuery?.[1]).toEqual(['ws-test', 'demo', 3, 6]);
  });

  it('clamps a limit that would serve the whole archive', () => {
    expect(resolvePageWindow(new URLSearchParams('limit=100000')).limit).toBe(PROJECT_HISTORY_MAX_PAGE_SIZE);
    expect(resolvePageWindow(new URLSearchParams('limit=0&offset=-5')))
      .toEqual({ limit: PROJECT_HISTORY_PAGE_SIZE, offset: 0 });
    expect(resolvePageWindow(new URLSearchParams('limit=abc'))).toEqual({
      limit: PROJECT_HISTORY_PAGE_SIZE,
      offset: 0,
    });
  });

  it('returns 503 when the read fails', async () => {
    sqlUnsafe.mockRejectedValue(new Error('connection closed'));
    const response = await route.handler(
      new Request('http://127.0.0.1/api/harness/read-failure/project-history'),
      { params: { slug: 'read-failure' } },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'connection closed' });
  });

  it('degrades a non-git project to a coded 422 instead of an opaque 503', async () => {
    await rm(join(repoRoot, '.git'), { recursive: true, force: true });

    const response = await route.handler(
      new Request('http://127.0.0.1/api/harness/non-git-pot/project-history'),
      { params: { slug: 'non-git-pot' } },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'non-git-pot is not a git repository, so it has no commit history to report.',
      code: 'not-a-git-repository',
    });
    // The structural check must short-circuit: a project that cannot answer is never
    // worth a database read for.
    expect(sqlUnsafe).not.toHaveBeenCalled();
  });

  it('treats a worktree/submodule .git FILE as a real repository', async () => {
    await rm(join(repoRoot, '.git'), { recursive: true, force: true });
    await writeFile(join(repoRoot, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt', 'utf8');

    const response = await route.handler(
      new Request('http://127.0.0.1/api/harness/worktree-pot/project-history'),
      { params: { slug: 'worktree-pot' } },
    );

    expect(response.status).toBe(200);
    expect(sqlUnsafe).toHaveBeenCalled();
  });

  it('strips ANSI colour from a failure before it reaches the client', async () => {
    const coloured = '\x1b[31mfatal: git rev-parse --is-inside-work-tree failed (128)\x1b[0m';
    // Positive control: assert the fixture really carries the escape, so a
    // double-backslash typo cannot make this test silently vacuous.
    expect(coloured).toContain('\x1b');
    sqlUnsafe.mockRejectedValue(new Error(coloured));

    const response = await route.handler(
      new Request('http://127.0.0.1/api/harness/coloured-failure/project-history'),
      { params: { slug: 'coloured-failure' } },
    );

    expect(response.status).toBe(503);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('fatal: git rev-parse --is-inside-work-tree failed (128)');
    expect(body.error).not.toContain('\x1b');
  });
});
