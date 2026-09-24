import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { replayAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { compileLaunchSpecificationArtifact, provisionLaunchIdentityResources } from '../role-launch-spec';

const memory = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; text: string; scope: string; metadata: Record<string, unknown> }>,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../memory/hive-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/hive-scope')>()),
  resolvePotSlugsForHarnesses: vi.fn(async () => ['sales']),
}));
vi.mock('../memory/backend', () => ({
  getMemoryBackend: () => ({
    available: async () => ({ ok: true }),
    list: async ({ scope }: { scope: string }) => memory.rows.filter((row) => row.scope === scope),
    search: async () => [],
    remember: async (text: string, options: { scope: string; metadata: Record<string, unknown> }) => {
      const id = `memory-${memory.rows.length + 1}`;
      memory.rows.push({ id, text, scope: options.scope, metadata: options.metadata });
      return { ids: [id] };
    },
    forget: async (id: string) => {
      memory.rows = memory.rows.filter((row) => row.id !== id);
    },
  }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

describe('selected identity knowledge at launch', () => {
  it('installs exact pinned content in the existing memory pool and refuses a changed pack without review', async () => {
    const root = mkdtempSync(join(tmpdir(), 'selected-knowledge-launch-'));
    const identityId = 'knowledge-domain';
    const packId = 'selected-mail-facts';
    const identityDir = join(root, '.papercusp', 'blueprints', identityId);
    const packDir = join(root, 'home', 'knowledge-packs', packId);
    memory.rows = [];
    try {
      mkdirSync(identityDir, { recursive: true });
      mkdirSync(packDir, { recursive: true });
      vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
      writeFileSync(join(identityDir, 'blueprint.yaml'), stringifyYaml({
        id: identityId, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
        knowledge: { pack: packId },
      }));
      writeFileSync(join(packDir, 'manifest.yaml'),
        `id: ${packId}\ntitle: Selected facts\ndescription: Selected launch knowledge.\nversion: 1.0.0\n`);
      const factFile = join(packDir, 'mail.md');
      writeFileSync(factFile, '---\nid: mail\ntitle: Mail rule\nkind: reference\napplies_to: [any]\n---\n\nUse the selected mail rule.\n');

      const compile = () => compileLaunchSpecificationArtifact({
        promptText: 'Mail worker.', cwd: root, workspaceId: 'workspace-a',
        harnessSlug: 'harness-a', role: 'worker', stack: [`domain:${identityId}`],
        state: { schemaVersion: 1 },
      });
      const launch = await compile();
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'package', packageKind: 'knowledge-pack', ref: packId,
      }));
      expect((await compile()).specificationRevision).toBe(launch.specificationRevision);
      const replayed = replayAgentSpecification(JSON.parse(JSON.stringify(launch.specificationArtifact)));
      expect(replayed.specificationRevision).toBe(launch.specificationRevision);
      expect(replayed.inputs).toContainEqual(expect.objectContaining({
        kind: 'package', packageKind: 'knowledge-pack', ref: packId,
        value: expect.objectContaining({ items: [expect.objectContaining({
          id: 'mail', text: 'Use the selected mail rule.',
        })] }),
      }));
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'setting', ref: 'bundle-scope',
        value: expect.objectContaining({ memoryTarget: { kind: 'hive', slug: 'sales' },
          knowledgeSelection: { shapes: [], domains: [] } }),
      }));
      await provisionLaunchIdentityResources(launch, {} as never);
      expect(memory.rows).toHaveLength(1);
      expect(memory.rows[0]).toMatchObject({
        scope: 'hive:sales', text: 'Mail rule — Use the selected mail rule.',
        metadata: { workspace_id: 'workspace-a', source: 'pack', pack_id: packId,
          pack_version: '1.0.0', pack_item_id: 'mail' },
      });
      await provisionLaunchIdentityResources(launch, {} as never);
      expect(memory.rows).toHaveLength(1);

      writeFileSync(factFile, '---\nid: mail\ntitle: Mail rule\nkind: reference\napplies_to: [any]\n---\n\nChanged mail rule.\n');
      const changed = await compile();
      expect(changed.specificationRevision).not.toBe(launch.specificationRevision);
      expect(replayAgentSpecification(JSON.parse(JSON.stringify(launch.specificationArtifact))))
        .toEqual(replayed);
      await expect(provisionLaunchIdentityResources(changed, {} as never))
        .rejects.toThrow(/knowledge pack conflicts with scoped memory/);
      expect(memory.rows).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      memory.rows = [];
      rmSync(root, { recursive: true, force: true });
    }
  });
});
