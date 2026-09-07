import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';

vi.mock('../harness-ops/proxy', () => ({ registerHarnessOpProxies: vi.fn() }));
vi.mock('./registry-sets', () => ({ blueprintRegistrySets: () => ({}) }));
import { projectBlueprintToPg } from './project-to-pg';

describe('P-006 existing blueprint content-hash projection', () => {
  it('projects a different content identity for prompt-only edits and returns the replayable specification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'projection-package-'));
    try {
      const sourcePath = join(dir, 'blueprint.yaml');
      mkdirSync(join(dir, 'prompts'));
      writeFileSync(sourcePath, 'id: fixture\nworkItem: { kind: feature }\nspine: { edges: { DONE: { to: done } } }\n');
      writeFileSync(join(dir, 'prompts', 'worker.md'), 'first');
      const loaded = loadBlueprintFromFile(sourcePath);
      const sql = vi.fn(async () => []);
      const input = { workspaceId: 'workspace-a', harnessSlug: 'harness-a', sourcePath, blueprint: loaded.blueprint, contentHash: loaded.contentHash };
      const a = await projectBlueprintToPg(sql as never, input);
      writeFileSync(join(dir, 'prompts', 'worker.md'), 'second');
      const b = await projectBlueprintToPg(sql as never, input);
      expect(a.contentHash).not.toBe(b.contentHash);
      expect(a.contentHash).toBe(a.specification?.specificationRevision);
      expect(b.contentHash).toBe(b.specification?.specificationRevision);
      expect(a.specification?.configuration).toEqual(b.specification?.configuration);
      expect(sql.mock.calls[0]).toContain(a.contentHash);
      expect(sql.mock.calls[1]).toContain(b.contentHash);
      rmSync(dir, { recursive: true, force: true });
      const replay = await projectBlueprintToPg(sql as never, { ...input, specification: a.specification });
      expect(replay.contentHash).toBe(a.contentHash);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses missing source content before updating the cache', async () => {
    const sql = vi.fn(async () => []);
    await expect(projectBlueprintToPg(sql as never, { workspaceId: 'w', harnessSlug: 'h',
      blueprint: {} as never, sourcePath: '/missing-p006/blueprint.yaml' })).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
  });
});
