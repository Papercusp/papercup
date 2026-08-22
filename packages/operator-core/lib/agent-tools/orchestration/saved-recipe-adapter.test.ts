import { describe, expect, it, vi } from 'vitest';
import type { InnerCall } from '../_compound-dispatch';
import { createSavedRecipeAdapter, type SavedRecipeAuthority } from './saved-recipe-adapter';

const metadata: SavedRecipeAuthority = {
  version: 1,
  revision: 'a'.repeat(64),
  refs: {
    workspaces: [],
    fleets: [],
    plans: [],
    harnesses: ['papercusp'],
    items: [],
    resources: [],
  },
  requiresContext: true,
  runnable: true,
};

const proof: SavedRecipeAuthority = {
  version: 1,
  revision: 'a'.repeat(64),
  context: { harness: 'papercusp' },
};

const recipe = {
  id: 'triage-stale-work-items',
  title: 'Triage stale work items',
  script: 'return { ok: true };',
  authority: metadata,
};

const getEnvelope = {
  ok: true,
  results: [{ ok: true, id: recipe.id, recipe }],
  counts: { requested: 1, succeeded: 1, failed: 0 },
};

describe('saved-recipe adapter', () => {
  it('delegates search losslessly so the exact recipes:search continuation survives', async () => {
    const searchEnvelope = {
      ok: true,
      query: 'triage stale work',
      recipes: [{ id: recipe.id, runArgs: { id: recipe.id, authority: proof } }],
    };
    const call = vi.fn<InnerCall>().mockResolvedValue(searchEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.search({
      query: 'triage stale work',
      limit: 3,
      context: { harness: 'papercusp' },
    });

    expect(result).toBe(searchEnvelope);
    expect(call).toHaveBeenCalledWith('recipes:search', {
      query: 'triage stale work',
      limit: 3,
      context: { harness: 'papercusp' },
    });
  });

  it('inspects through recipes:get and returns its exact current authority metadata', async () => {
    const call = vi.fn<InnerCall>().mockResolvedValue(getEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.inspect({ id: recipe.id });

    expect(result).toMatchObject({
      ok: true,
      continuation: { id: recipe.id, revision: 'a'.repeat(64) },
    });
    expect(result.ok && result.continuation.authority).toBe(metadata);
    expect(call).toHaveBeenCalledWith('recipes:get', { id: recipe.id });
  });

  it('replays through recipes:run with the caller-supplied search proof unchanged', async () => {
    const runEnvelope = {
      ok: true,
      results: [{ ok: true, id: recipe.id, result: { summary: { triaged: 4 } } }],
      counts: { requested: 1, succeeded: 1, failed: 0 },
    };
    const call = vi.fn<InnerCall>().mockResolvedValueOnce(getEnvelope).mockResolvedValueOnce(runEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.run({
      recipe: { id: recipe.id, revision: 'a'.repeat(64), authority: proof },
      timeoutSec: 20,
      dryRun: true,
    });

    expect(result).toBe(runEnvelope);
    expect(call).toHaveBeenNthCalledWith(1, 'recipes:get', { id: recipe.id });
    expect(call).toHaveBeenNthCalledWith(2, 'recipes:run', {
      id: recipe.id,
      authority: proof,
      timeoutSec: 20,
      dryRun: true,
    });
    const runArgs = call.mock.calls[1]?.[1] as { authority: unknown };
    expect(runArgs.authority).toBe(proof);
  });

  it('uses current recipes:get metadata when no search proof was supplied', async () => {
    const call = vi
      .fn<InnerCall>()
      .mockResolvedValueOnce(getEnvelope)
      .mockResolvedValueOnce({ ok: true, results: [], counts: {} });
    const adapter = createSavedRecipeAdapter(call);

    await adapter.run({ recipe: { id: recipe.id } });

    const runArgs = call.mock.calls[1]?.[1] as { authority: unknown };
    expect(runArgs.authority).toBe(metadata);
  });

  it('fails a stale revision before recipes:run can dispatch', async () => {
    const call = vi.fn<InnerCall>().mockResolvedValue(getEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.run({
      recipe: { id: recipe.id, revision: 'b'.repeat(64), authority: proof },
    });

    expect(result).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'recipe_authority_stale', path: 'recipe.revision' },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('fails a stale authority proof before recipes:run can dispatch', async () => {
    const staleProof: SavedRecipeAuthority = {
      version: 1,
      revision: 'b'.repeat(64),
      context: { harness: 'papercusp' },
    };
    const call = vi.fn<InnerCall>().mockResolvedValue(getEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.run({ recipe: { id: recipe.id, authority: staleProof } });

    expect(result).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'recipe_authority_stale', path: 'recipe.authority.revision' },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('fails non-empty legacy bindings closed without source substitution or a second store', async () => {
    const call = vi.fn<InnerCall>().mockResolvedValue(getEnvelope);
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.run({
      recipe: { id: recipe.id },
      bindings: { values: { ageDays: 30 } },
    });

    expect(result).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'binding_invalid', path: 'bindings' },
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('recipes:get', { id: recipe.id });
  });

  it('maps a missing saved recipe to the public preflight failure shape', async () => {
    const call = vi.fn<InnerCall>().mockResolvedValue({
      ok: true,
      results: [{ ok: false, id: 'gone', error: 'not_found' }],
      counts: { requested: 1, succeeded: 0, failed: 1 },
    });
    const adapter = createSavedRecipeAdapter(call);

    const result = await adapter.inspect({ id: 'gone' });

    expect(result).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'recipe_not_found', path: 'recipe.id' },
    });
  });
});
