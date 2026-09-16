import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveHarnessRepoRoot = vi.fn();
const resolveCliBin = vi.fn();
const resolvePtool = vi.fn();
const runProjectHistoryGenerate = vi.fn();

vi.mock('../../../harness/docs/harness-repo', () => ({
  resolveHarnessRepoRoot: (...args: unknown[]) => resolveHarnessRepoRoot(...args),
}));

vi.mock('../../../harness/routines/project-history-refresh-action', () => ({
  resolveCliBin: (...args: unknown[]) => resolveCliBin(...args),
  resolvePtool: (...args: unknown[]) => resolvePtool(...args),
  runProjectHistoryGenerate: (...args: unknown[]) => runProjectHistoryGenerate(...args),
}));

import routeDefinition, { generateHarnessProjectHistory } from './project-history';

type RouteDefinition = {
  path: string;
  auth: string;
  timeoutSec: number;
  handler: (request: Request, context: { params: Record<string, string> }) => Promise<Response>;
};

const route = routeDefinition as unknown as RouteDefinition;

// The route now asks the filesystem whether the resolved root is a git checkout,
// so the fixture must be a REAL directory rather than a synthetic path string.
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
  resolveCliBin.mockReset().mockReturnValue('/repo/libs/papercusp/packages/cli/bin/papercusp');
  resolvePtool.mockReset().mockReturnValue('/usr/local/bin/ptool');
  runProjectHistoryGenerate.mockReset().mockImplementation(async (
    _cliBin: string,
    config: { output: string; harness: string },
  ) => {
    await writeFile(config.output, JSON.stringify({ schemaVersion: 2, harness: config.harness }), 'utf8');
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  });
});

describe('GET /harness/:slug/project-history', () => {
  it('registers a loopback-only route', () => {
    expect(route.path).toBe('/harness/:slug/project-history');
    expect(route.auth).toBe('loopback');
    expect(route.timeoutSec).toBe(120);
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

  it('derives the integration root, preserves the workspace pin, and returns generated v2 JSON', async () => {
    const document = await generateHarnessProjectHistory('demo-provider', {
      PATH: '/usr/local/bin',
      PAPERCUSP_WORKSPACE_ID: 'ws-test',
    });

    expect(document).toEqual({ schemaVersion: 2, harness: 'demo-provider' });
    const runnerEnv = resolvePtool.mock.calls[0]?.[0] as NodeJS.ProcessEnv;
    const integrationRoot = runnerEnv.PAPERCUSP_INTEGRATION_ROOT;
    expect(integrationRoot).toEqual(expect.any(String));
    await expect(access(join(integrationRoot!, 'libs/papercusp/packages/cli/bin/papercusp'))).resolves.toBeUndefined();
    expect(resolveCliBin).toHaveBeenCalledWith(runnerEnv);
    expect(runProjectHistoryGenerate).toHaveBeenCalledWith(
      '/repo/libs/papercusp/packages/cli/bin/papercusp',
      expect.objectContaining({
        workspace: 'ws-test',
        harness: 'demo-provider',
        projectId: 'demo-provider',
        format: 'json',
      }),
      90_000,
      runnerEnv,
    );
  });

  it('returns 503 when generation fails', async () => {
    runProjectHistoryGenerate.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'generator failed',
      timedOut: false,
    });
    const response = await route.handler(
      new Request('http://127.0.0.1/api/harness/generation-failure/project-history'),
      { params: { slug: 'generation-failure' } },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'generator failed' });
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
    // The structural check must short-circuit: a project that cannot answer is
    // never worth spawning a 90s child generator for.
    expect(runProjectHistoryGenerate).not.toHaveBeenCalled();
  });

  it('treats a worktree/submodule .git FILE as a real repository', async () => {
    await rm(join(repoRoot, '.git'), { recursive: true, force: true });
    await writeFile(join(repoRoot, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt', 'utf8');

    const response = await route.handler(
      new Request('http://127.0.0.1/api/harness/worktree-pot/project-history'),
      { params: { slug: 'worktree-pot' } },
    );

    expect(response.status).toBe(200);
    expect(runProjectHistoryGenerate).toHaveBeenCalled();
  });

  it('strips ANSI colour from generator stderr before it reaches the client', async () => {
    const coloured = '\x1b[31mfatal: git rev-parse --is-inside-work-tree failed (128)\x1b[0m';
    // Positive control: assert the fixture really carries the escape, so a
    // double-backslash typo cannot make this test silently vacuous.
    expect(coloured).toContain('\x1b');
    runProjectHistoryGenerate.mockResolvedValue({
      code: 128,
      stdout: '',
      stderr: coloured,
      timedOut: false,
    });

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
