/**
 * deploy.test.ts — the MCP envelope contracts for the two read-ish deploy tools
 * (cloud-deployment-layer-2026-06-06). The deps are mocked (their own suites
 * cover the orchestration); this pins the {ok:…} envelope each tool emits:
 *
 *   Gap 10:
 *   - harness:migrate-config-json — migratedCount counts ONLY the migrated rows,
 *     results carries only the migrated set, and a thrown sweep → {ok:false,error}.
 *   - deploy:status — unknown slug → {ok:false}; a resolved harness → its
 *     deployment config + frame handle (defaults to local / null).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const migrateAllConfigJson = vi.fn();
const loadHarnessRegistry = vi.fn();

vi.mock('../../deployment/instance-config', () => ({
  migrateAllConfigJson: (...a: unknown[]) => migrateAllConfigJson(...a),
}));
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: (...a: unknown[]) => loadHarnessRegistry(...a),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));

import { migrateConfigJsonTool, deployStatusTool } from './deploy';

type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };

async function call(tool: unknown, args: Record<string, unknown>) {
  const res = await (tool as Tool).handler(args, {});
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  migrateAllConfigJson.mockReset();
  loadHarnessRegistry.mockReset();
});

describe('harness:migrate-config-json envelope (Gap 10)', () => {
  it('migratedCount + results count ONLY the migrated rows (skips no-ops)', async () => {
    migrateAllConfigJson.mockResolvedValue([
      { slug: 'a', migrated: true, fields: ['phase'] },
      { slug: 'b', migrated: false, fields: [] }, // already migrated / file-less
      { slug: 'c', migrated: true, fields: ['dept', 'configOverrides'] },
    ]);
    const out = await call(migrateConfigJsonTool, { workspace: 'ws-x' });
    expect(out).toMatchObject({
      ok: true,
      workspace: 'ws-x',
      scanned: 3,
      migratedCount: 2,
    });
    expect(out.results).toEqual([
      { slug: 'a', migrated: true, fields: ['phase'] },
      { slug: 'c', migrated: true, fields: ['dept', 'configOverrides'] },
    ]);
    expect(migrateAllConfigJson).toHaveBeenCalledWith('ws-x');
  });

  it('defaults the workspace to the active one', async () => {
    migrateAllConfigJson.mockResolvedValue([]);
    const out = await call(migrateConfigJsonTool, {});
    expect(out).toMatchObject({ ok: true, workspace: 'ws-active', scanned: 0, migratedCount: 0, results: [] });
    expect(migrateAllConfigJson).toHaveBeenCalledWith('ws-active');
  });

  it('reports {ok:false,error} when the sweep throws (no unhandled rejection)', async () => {
    migrateAllConfigJson.mockRejectedValue(new Error('registry unreachable'));
    const out = await call(migrateConfigJsonTool, {});
    expect(out).toMatchObject({ ok: false, error: 'registry unreachable' });
  });
});

describe('deploy:status envelope (Gap 10)', () => {
  it('fails for an unknown harness slug', async () => {
    loadHarnessRegistry.mockResolvedValue({ projects: [{ slug: 'other', path: '/o' }] });
    const out = await call(deployStatusTool, { slug: 'ghost' });
    expect(out).toMatchObject({ ok: false });
    expect(String(out.error)).toContain('ghost');
    expect(loadHarnessRegistry).toHaveBeenCalledWith('ws-active');
  });

  it('defaults an undeployed harness to local + null frame', async () => {
    loadHarnessRegistry.mockResolvedValue({ projects: [{ slug: 'web', path: '/w' }] });
    const out = await call(deployStatusTool, { slug: 'web' });
    expect(out).toMatchObject({
      ok: true,
      slug: 'web',
      deployment: { target: 'local' },
      frame: null,
    });
  });

  it('projects the resolved deployment config + frame handle', async () => {
    loadHarnessRegistry.mockResolvedValue({
      projects: [
        {
          slug: 'web',
          path: '/w',
          deployment: { target: 'latitude', desktop: true },
          deploymentFrame: { id: 'f1', host: '1.2.3.4', region: 'nyc' },
        },
      ],
    });
    const out = await call(deployStatusTool, { slug: 'web', workspace: 'ws-x' });
    expect(out).toMatchObject({
      ok: true,
      slug: 'web',
      deployment: { target: 'latitude', desktop: true },
      frame: { id: 'f1', host: '1.2.3.4', region: 'nyc' },
    });
    expect(loadHarnessRegistry).toHaveBeenCalledWith('ws-x');
  });
});
