import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { Sql } from 'postgres';
import { layerContentHash } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { compileLaunchSpecificationArtifact, provisionLaunchIdentityResources } from '../role-launch-spec';
import recipeGetTool from '../agent-tools/recipes/get';
import recipeRunTool from '../agent-tools/recipes/run';
import { getIdentitySource } from './source';

const pg = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: pg.sql }),
}));

describe('selected identity recipe reaches its existing consumer', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    pg.sql = db.adminSql;
  }, 120_000);
  afterAll(async () => {
    pg.sql = null;
    await db?.cleanup();
  });

  it('pins an installed abstract identity recipe at launch and exposes it through recipes:get', async () => {
    const root = mkdtempSync(join(tmpdir(), 'selected-resource-launch-'));
    const identityId = 'installed-resource-domain';
    const recipeId = 'selected-launch-recipe';
    const identityDir = join(root, 'home', 'blueprints', identityId);
    const recipeDir = join(root, 'home', 'recipes', recipeId);
    try {
      mkdirSync(identityDir, { recursive: true });
      mkdirSync(recipeDir, { recursive: true });
      vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
      const identity = {
        id: identityId, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
        bundles: [{ kind: 'recipe', ref: recipeId, version: '1.0.0' }],
      };
      writeFileSync(join(identityDir, 'blueprint.yaml'), stringifyYaml({
        ...identity, attestation: { contentHash: layerContentHash(identity), signedBy: 'approved-publisher' },
      }));
      writeFileSync(join(recipeDir, 'recipe.json'), JSON.stringify({
        id: recipeId, title: 'Selected launch recipe', script: 'return "from selected identity"',
      }));
      writeFileSync(join(recipeDir, 'listing.json'), JSON.stringify({ version: '1.0.0' }));

      const selected = await getIdentitySource(identityId);
      expect(selected.ok, JSON.stringify(selected)).toBe(true);

      const launch = await compileLaunchSpecificationArtifact({
        promptText: 'Inspect the selected recipe before use.',
        cwd: root, workspaceId: 'identity-resource-ws', harnessSlug: 'identity-resource-harness',
        role: 'worker', stack: [`domain:${identityId}`], state: { schemaVersion: 1 },
      });
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'package', packageKind: 'recipe', ref: recipeId,
      }));
      expect(launch.resourceArtifacts).toHaveLength(1);
      await provisionLaunchIdentityResources(launch, db.adminSql);

      const read = await recipeGetTool.handler({ id: recipeId }, {} as never);
      const body = (read as { data: { results: Array<Record<string, unknown>> } }).data;
      expect(body.results[0]).toMatchObject({
        ok: true, id: recipeId,
        recipe: { script: 'return "from selected identity"', authorRole: 'blueprint-bundle' },
      });

      const run = await recipeRunTool.handler({ id: recipeId }, {
        role: 'worker', workspaceId: 'identity-resource-ws',
        harnessSlug: 'identity-resource-harness', isSuperuser: false,
        log: () => {},
      } as never);
      const runBody = (run as { data: {
        results: Array<{ ok: boolean; id: string; result?: { summary?: unknown } }>;
      } }).data;
      expect(runBody.results[0]).toMatchObject({
        ok: true, id: recipeId, result: { summary: 'from selected identity' },
      });
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
