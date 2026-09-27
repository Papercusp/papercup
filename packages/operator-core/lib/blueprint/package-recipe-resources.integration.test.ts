import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinPackageInput } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getRecipe, upsertRecipe } from '../code-recipes-store';
import { releasePackageResource } from './package-resource-receipts';
import { packageRecipeDriver, planRecipePackageResource, prepareRecipePackageResource } from './package-recipe-resources';

let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); }, 180_000);
afterAll(async () => { await db?.cleanup(); });

const value = (id: string, script = 'return { ready: true };') => ({
  id, title: 'Portable recipe', description: 'Exact package recipe', script,
  toolsUsed: ['status:read'], tags: ['portable'],
});
const pin = (id: string, script?: string) => pinPackageInput({
  packageKind: 'recipe', ref: id, revision: '1.0.0', files: [], value: value(id, script),
});

describe('recipe package resource ownership (real PG)', () => {
  it('shares one package-created row and removes it only after the final dependent', async () => {
    const input = { pin: pin('package-owned-recipe'), workspaceId: 'recipe-resource', dependentId: 'wearer-a' };
    const planned = planRecipePackageResource(input.pin, input.workspaceId);
    const one = await prepareRecipePackageResource(db.adminSql, input);
    const two = await prepareRecipePackageResource(db.adminSql, { ...input, dependentId: 'wearer-b' });
    expect(one.external_refs).toEqual(two.external_refs);
    expect(one.external_refs).toEqual([expect.objectContaining({ id: input.pin.ref,
      fingerprint: planned.address.installedHash })]);
    const driver = packageRecipeDriver(db.adminSql, planned.address, planned.value);
    expect(await releasePackageResource(db.adminSql, planned.address, input.dependentId, driver))
      .toMatchObject({ phase: 'ready' });
    expect(await getRecipe(db.adminSql, input.pin.ref)).not.toBeNull();
    expect(await releasePackageResource(db.adminSql, planned.address, 'wearer-b', driver))
      .toMatchObject({ phase: 'deleted' });
    expect(await getRecipe(db.adminSql, input.pin.ref)).toBeNull();
  });

  it('depends on an exact organic row without taking deletion ownership', async () => {
    const selected = pin('organic-recipe');
    await upsertRecipe(db.adminSql, { ...value(selected.ref), potSlug: 'organic-pot',
      authorRole: 'worker', createdBy: 'organic-owner', createOnly: true });
    const receipt = await prepareRecipePackageResource(db.adminSql, {
      pin: selected, workspaceId: 'recipe-organic', dependentId: 'wearer',
    });
    expect(receipt.external_refs).toEqual([expect.objectContaining({ id: selected.ref, owned: false })]);
    const planned = planRecipePackageResource(selected, 'recipe-organic');
    const released = await releasePackageResource(db.adminSql, planned.address, 'wearer',
      packageRecipeDriver(db.adminSql, planned.address, planned.value));
    expect(released).toMatchObject({ phase: 'detached',
      external_refs: [expect.objectContaining({ id: selected.ref, owned: false, disposition: 'unowned' })] });
    expect(await getRecipe(db.adminSql, selected.ref)).toMatchObject({ createdBy: 'organic-owner' });
  });

  it('preserves a package-created row after a user edit and refuses a conflicting pin', async () => {
    const original = pin('edited-recipe');
    await prepareRecipePackageResource(db.adminSql, {
      pin: original, workspaceId: 'recipe-edited', dependentId: 'wearer',
    });
    const row = await getRecipe(db.adminSql, original.ref);
    await upsertRecipe(db.adminSql, { id: row!.id, title: row!.title, description: row!.description,
      script: 'return { edited: true };', toolsUsed: row!.toolsUsed, tags: row!.tags,
      bindingSchema: row!.bindingSchema, capabilityManifest: row!.capabilityManifest,
      potSlug: row!.potSlug, authorRole: 'worker' });
    const planned = planRecipePackageResource(original, 'recipe-edited');
    expect(await releasePackageResource(db.adminSql, planned.address, 'wearer',
      packageRecipeDriver(db.adminSql, planned.address, planned.value))).toMatchObject({ phase: 'detached' });
    expect(await getRecipe(db.adminSql, original.ref)).toMatchObject({ script: 'return { edited: true };' });
    await expect(prepareRecipePackageResource(db.adminSql, {
      pin: pin(original.ref, 'return { another: true };'), workspaceId: 'recipe-edited', dependentId: 'later',
    })).rejects.toThrow(/package-pin-conflict/);
  });

  it('rejects a tampered package snapshot before writing a receipt or recipe', async () => {
    const exact = pin('tampered-recipe');
    const tampered = { ...exact, value: value(exact.ref, 'return { tampered: true };') };
    await expect(prepareRecipePackageResource(db.adminSql, {
      pin: tampered, workspaceId: 'recipe-tampered', dependentId: 'wearer',
    })).rejects.toThrow(/package-hash-mismatch/);
    expect(await getRecipe(db.adminSql, exact.ref)).toBeNull();
  });
});
