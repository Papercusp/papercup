/**
 * POST /api/admin/testing/run — start a detached test run.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-014/P-015.
 *
 * Body shape:
 *   { runner: TestRunner }
 *
 * Spawns the appropriate child process per runner.kind, returns the
 * runId. The SPA polls GET /api/admin/testing/run/:runId for status +
 * rolling output. SSE upgrade is a follow-up; polling matches the
 * existing /api/admin/testing/test-runs pattern.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { startRun, type SpawnRequest } from '../../../testing-run-store';

type TestRunner =
  | { kind: 'vitest'; filePath: string }
  | { kind: 'vitest-multi'; filePaths: string[]; label?: string }
  | { kind: 'playwright'; filePath: string }
  | { kind: 'cargo'; crate: string; test?: string }
  | { kind: 'node'; cmd: string; args?: string[]; label?: string }
  | { kind: 'shell'; cmd: string; args?: string[]; label?: string };

function toSpawn(runner: TestRunner): SpawnRequest | { error: string } {
  switch (runner.kind) {
    case 'vitest':
      if (!runner.filePath) return { error: 'vitest requires filePath' };
      // No explicit --reporter flag: vitest CLI's --reporter REPLACES the
      // config-side reporter list, which would drop the admin reporter that
      // writes per-file rows to test_runs (P-014). The merged config already
      // includes `default` via @papercusp/test-config.
      return {
        kind: 'vitest',
        label: `vitest ${runner.filePath}`,
        filePath: runner.filePath,
        command: 'npx',
        args: ['vitest', 'run', runner.filePath],
      };
    case 'vitest-multi':
      if (!Array.isArray(runner.filePaths) || runner.filePaths.length === 0) {
        return { error: 'vitest-multi requires non-empty filePaths' };
      }
      return {
        kind: 'vitest',
        label: runner.label ?? `vitest ${runner.filePaths.length} files`,
        command: 'npx',
        args: ['vitest', 'run', ...runner.filePaths],
      };
    case 'playwright':
      if (!runner.filePath) return { error: 'playwright requires filePath' };
      return {
        kind: 'playwright',
        label: `playwright ${runner.filePath}`,
        filePath: runner.filePath,
        command: 'npx',
        args: ['playwright', 'test', runner.filePath],
      };
    case 'cargo':
      if (!runner.crate) return { error: 'cargo requires crate' };
      return {
        kind: 'cargo',
        label: runner.test ? `cargo ${runner.crate}::${runner.test}` : `cargo ${runner.crate}`,
        command: 'cargo',
        args: [
          'test',
          '-p', runner.crate,
          ...(runner.test ? [runner.test] : []),
          '--message-format=json',
        ],
      };
    case 'node':
      if (!runner.cmd) return { error: 'node requires cmd' };
      return {
        kind: 'node',
        label: runner.label ?? `node ${runner.cmd}`,
        command: runner.cmd,
        args: runner.args ?? [],
      };
    case 'shell':
      if (!runner.cmd) return { error: 'shell requires cmd' };
      return {
        kind: 'shell',
        label: runner.label ?? `shell ${runner.cmd}`,
        command: runner.cmd,
        args: runner.args ?? [],
      };
    default: {
      const _exhaustive: never = runner;
      void _exhaustive;
      return { error: 'unknown runner kind' };
    }
  }
}

export default defineTool({
  method: 'POST',
  path: '/admin/testing/run',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    const body = await req.json().catch(() => null) as { runner?: TestRunner } | null;
    const runner = body?.runner;
    if (!runner || typeof runner !== 'object' || !('kind' in runner)) {
      return Response.json(
        { error: 'body must be { runner: { kind, ... } }' },
        { status: 400 },
      );
    }
    const spawnReq = toSpawn(runner as TestRunner);
    if ('error' in spawnReq) {
      return Response.json(spawnReq, { status: 400 });
    }
    const snapshot = startRun(spawnReq);
    return Response.json({ runId: snapshot.runId, snapshot });
  },
});
