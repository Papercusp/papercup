import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  handler: (request: Request, context: { params: Record<string, string> }) => Promise<Response>;
};

const route = routeDefinition as unknown as RouteDefinition;

beforeEach(() => {
  resolveHarnessRepoRoot.mockReset().mockResolvedValue('/repos/demo');
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
});
