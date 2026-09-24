import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadBlueprintFromFile,
  parseBlueprintSourceDocument,
  replayAgentSpecification,
  resolveBlueprint,
  specificationPrompt,
  pinPackageInput,
  type ResolvedPackageInput,
} from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getRecipe } from '../code-recipes-store';
import {
  blueprintPackageProvisioners,
  compileBlueprintWithPackages,
  provisionBlueprintPackages,
} from './compile-packages';

// The production resolver reads actual installed directories, then the compiler's
// serialized artifact drives the production provisioner against a migrated,
// isolated PostgreSQL database. No compiler, resolver or store writer is mocked.
let db: OrgTestDb;
const roots: string[] = [];
beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
afterAll(async () => { await db?.cleanup(); });
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const reference = ({ packageKind, ref, revision, contentHash }: ResolvedPackageInput) => ({
  packageKind,
  ref,
  revision,
  contentHash,
});

describe('compileBlueprintWithPackages production composition (integration)', () => {
  it('resolves an abstract identity resource through the existing recipe provisioner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'identity-resource-integration-'));
    roots.push(root);
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    const recipeId = 'identity-pinned-recipe';
    const recipeDir = join(root, 'home', 'recipes', recipeId);
    mkdirSync(recipeDir, { recursive: true });
    writeFileSync(join(recipeDir, 'recipe.json'), JSON.stringify({
      id: recipeId, title: 'Identity recipe', script: 'return "identity resource"',
    }));
    writeFileSync(join(recipeDir, 'listing.json'), JSON.stringify({ version: '1.0.0' }));
    const identity = {
      id: 'integration-resource-identity', extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
      bundles: [{ kind: 'recipe', ref: recipeId, version: '1.0.0' }],
    };
    const artifact = await compileBlueprintWithPackages(identity, {
      workspaceId: 'integration-workspace', harnessSlug: 'integration-harness',
    });
    expect(artifact.inputs).toContainEqual(expect.objectContaining({
      kind: 'package', packageKind: 'recipe', ref: recipeId,
    }));
    await provisionBlueprintPackages(artifact, blueprintPackageProvisioners(db.adminSql));
    expect(await getRecipe(db.adminSql, recipeId)).toMatchObject({
      script: 'return "identity resource"', authorRole: 'blueprint-bundle',
    });
    expect(artifact.configuration).not.toHaveProperty('spine');
    expect(artifact.configuration).not.toHaveProperty('workItem');
  });

  it('compiles a complete transitive package closure and replays the exact prompt bytes', async () => {
    const leaf = pinPackageInput({
      packageKind: 'recipe',
      ref: 'leaf',
      revision: '1.0.0',
      files: [{ path: 'recipe.json', bytes: '{"script":"return 1"}' }],
      value: { id: 'leaf', script: 'return 1' },
    });
    const root = pinPackageInput({
      packageKind: 'rubric',
      ref: 'root',
      revision: '1.0.0',
      files: [{ path: 'rubric.json', bytes: '{"criteria":["closure"]}' }],
      value: { id: 'root', criteria: ['closure'] },
      dependencies: [reference(leaf)],
    });
    const loaded = resolveBlueprint({
      id: 'integration-closure',
      bundles: [{ kind: 'rubric', ref: 'root', version: '1.0.0' }],
      workItem: { kind: 'feature' },
      spine: { edges: { DONE: { to: 'done' } } },
    });

    const artifact = await compileBlueprintWithPackages(loaded, {
      workspaceId: 'integration-workspace',
      harnessSlug: 'integration-harness',
      input: { prompt: { text: 'Compose this pinned stack.' } },
      resolvePackage: async ({ kind, ref }) => {
        if (kind === 'rubric' && ref === 'root') return root;
        if (kind === 'recipe' && ref === 'leaf') return leaf;
        return null;
      },
    });

    expect(artifact.inputs.filter((entry) => entry.kind === 'package').map((entry) => `${entry.packageKind}:${entry.ref}`).sort())
      .toEqual(['blueprint:integration-closure', 'recipe:leaf', 'rubric:root']);
    expect(artifact.inputs).toContainEqual(expect.objectContaining({
      kind: 'setting',
      ref: 'bundle-scope',
      value: { workspaceId: 'integration-workspace', harnessSlug: 'integration-harness' },
    }));
    expect(specificationPrompt(replayAgentSpecification(JSON.parse(JSON.stringify(artifact)))))
      .toBe(specificationPrompt(artifact));
  });

  it('resolves real installed content, persists its pinned recipe and replays after its source disappears', async () => {
    const root = mkdtempSync(join(tmpdir(), 'blueprint-closure-integration-'));
    roots.push(root);
    const put = (relative: string, bytes: string) => {
      const file = join(root, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      return file;
    };
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    vi.stubEnv('PAPERCUSP_RECIPES_DIR', join(root, 'bundled-recipes'));
    const recipeId = 'integration-pinned-recipe';
    const originalScript = 'return "original pinned bytes"';
    const manifest = { id: recipeId, title: 'Integration recipe', script: originalScript };
    put(`bundled-recipes/${recipeId}/recipe.json`, JSON.stringify({ ...manifest, script: 'return "shadowed"' }));
    const installed = put(`home/recipes/${recipeId}/recipe.json`, JSON.stringify(manifest));
    put(`home/recipes/${recipeId}/listing.json`, JSON.stringify({ version: '1.0.0' }));
    put(`home/recipes/${recipeId}/extra.md`, 'Pin this file, not only the recipe manifest.\n');
    const sourceDocument = {
      id: 'integration-local-blueprint',
      bundles: [{ kind: 'recipe', ref: recipeId, version: '1.0.0' }],
      workItem: { kind: 'feature' },
      spine: { edges: { DONE: { to: 'done' } } },
    };
    const sourcePath = put('blueprint/blueprint.yaml', JSON.stringify(sourceDocument));
    const promptPath = put('blueprint/prompts/worker.md', 'Original worker prompt.\n');
    const loaded = loadBlueprintFromFile(sourcePath);
    expect(parseBlueprintSourceDocument(sourceDocument).kind).toBe('blueprint');
    expect(parseBlueprintSourceDocument({ id: 'domain-only', slots: [{ slot: 'domain' }] }).kind).toBe('identity');
    const compile = () => compileBlueprintWithPackages(loaded, {
      workspaceId: 'integration-workspace',
      harnessSlug: 'integration-harness',
      input: {
        prompt: { text: readFileSync(promptPath, 'utf8') },
        addressedDocuments: [{ ref: 'guide', revision: 1, body: 'Pinned addressed guidance.' }],
      },
    });
    const artifact = await compile();
    const recipe = artifact.inputs.find(
      (entry): entry is ResolvedPackageInput => entry.kind === 'package' && entry.packageKind === 'recipe',
    )!;
    expect(recipe.value).toMatchObject({ script: originalScript });
    expect(recipe.files.map((file) => file.path)).toEqual(['extra.md', 'listing.json', 'recipe.json']);
    const expectedPrompt = 'Original worker prompt.\n\n## Addressed guidance — for this session’s stack\n\n'
      + '> These sections are pinned to the addressed-document revisions in the effective agent specification.\n\n'
      + 'Pinned addressed guidance.\n';
    expect(specificationPrompt(artifact)).toBe(expectedPrompt);
    const serialized = JSON.stringify(artifact);
    const provisioners = blueprintPackageProvisioners(db.adminSql);
    await provisionBlueprintPackages(JSON.parse(serialized), provisioners);
    expect(await getRecipe(db.adminSql, recipeId)).toMatchObject({
      script: originalScript,
      createdBy: `blueprint-package:${recipe.contentHash}`,
      authorRole: 'blueprint-bundle',
    });

    writeFileSync(installed, JSON.stringify({ ...manifest, script: 'return "changed source"' }));
    writeFileSync(promptPath, 'Changed prompt bytes.\n');
    const changed = await compile();
    expect(changed.specificationRevision).not.toBe(artifact.specificationRevision);
    await expect(provisionBlueprintPackages(changed, provisioners)).rejects.toThrow(/explicit migration is required/);
    expect((await getRecipe(db.adminSql, recipeId))?.script).toBe(originalScript);

    const corrupt = JSON.parse(serialized);
    corrupt.inputs.find((entry: { kind: string; ref: string }) => entry.kind === 'package' && entry.ref === recipeId)
      .files.find((file: { path: string }) => file.path === 'extra.md').bytes = 'tampered';
    await expect(provisionBlueprintPackages(corrupt, provisioners)).rejects.toThrow(/package-hash-mismatch/);

    rmSync(root, { recursive: true, force: true });
    const replayed = replayAgentSpecification(JSON.parse(serialized));
    expect(replayed).toEqual(artifact);
    expect(specificationPrompt(replayed)).toBe(expectedPrompt);
    await provisionBlueprintPackages(replayed, provisioners);
    expect((await getRecipe(db.adminSql, recipeId))?.script).toBe(originalScript);
  });

  it('rejects a resolver that substitutes a package at the production adapter boundary', async () => {
    const loaded = resolveBlueprint({
      id: 'integration-substitution',
      bundles: [{ kind: 'recipe', ref: 'wanted', version: '1.0.0' }],
      workItem: { kind: 'feature' },
      spine: { edges: { DONE: { to: 'done' } } },
    });
    const wrong = pinPackageInput({
      packageKind: 'recipe',
      ref: 'different',
      revision: '1.0.0',
      files: [{ path: 'recipe.json', bytes: '{}' }],
      value: { id: 'different' },
    });

    await expect(compileBlueprintWithPackages(loaded, {
      workspaceId: 'integration-workspace',
      harnessSlug: 'integration-harness',
      resolvePackage: async () => wrong,
    })).rejects.toThrow(/different package/);
  });
});
