import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { deriveRecipeAuthority } from '../../recipe-authority-derive';

// This exact source is persisted with recipes:revise, then read back for equality.
const script = readFileSync(new URL('./fixtures/check-git-sync-progress-after-timeout-wake.recipe.txt', import.meta.url), 'utf8');
const subject = { installSlug: 'target', resource: 'git-sync:target' };
const unrelated = { installSlug: 'other', name: 'overwatch-wake', health: { last_error: 'x'.repeat(9000) } };
const target = {
  installSlug: 'target', name: 'git-sync', active: true, paused: null,
  health: {
    last_status: 'error', head_sha: 'local-head', last_synced_at: 123,
    last_content_errors: ['target/file [detector]'], last_content_error_count: 8169,
    last_content_errors_omitted: 8168, last_content_errors_artifact: 'git-sync/content-errors/full.json',
  },
};

function run(source = script, inputs: Record<string, unknown> = subject, routineRows = [unrelated, target]) {
  const routines = vi.fn(async (args: { installSlug?: string; name?: string; limit?: number }) => {
    const matches = routineRows.filter(r => (!args.installSlug || r.installSlug === args.installSlug) && (!args.name || r.name === args.name));
    return { count: matches.length, routines: matches.slice(0, args.limit ?? matches.length) };
  });
  const locks = vi.fn(async (_args: unknown) => ({
    resources: [{ resource: subject.resource }],
    holders: [{ resource: 'git-sync:other', owner: 'foreign', mode: 'shared', status: 'held' },
      { resource: subject.resource, owner: 'correct-holder', mode: 'shared', status: 'held' }],
    draining: false, registryCount: { truncatedByLimit: false },
  }));
  const context = vm.createContext({ inputs, tools: { routines: { list: routines }, locks: { list: locks } } });
  return { result: vm.runInContext(`(async () => { ${source}\n })()`, context) as Promise<Record<string, any>>, routines, locks };
}

describe('saved git-sync progress recipe', () => {
  it('permits invocation-filtered discovery while dynamic lock mutations still require scope proof', async () => {
    expect(await deriveRecipeAuthority(script)).toMatchObject({ unresolved: false, bound: false });
    for (const verb of ['acquire', 'release', 'acquireResource', 'releaseResource']) {
      expect(await deriveRecipeAuthority(`await tools.locks.${verb}({ resource: inputs.resource });`))
        .toMatchObject({ unresolved: true, unresolvedCause: { kind: 'dynamic-scope-args' } });
    }
  });

  it('reproduces legacy loss behind a large unrelated routine, while scoped structured evidence keeps the target', async () => {
    const legacy = run('const [routines,locks]=await Promise.all([tools.routines.list({}),tools.locks.list({})]); return {routines:JSON.stringify(routines).slice(0,7000),locks:JSON.stringify(locks).slice(0,7000)};');
    const old = await legacy.result;
    expect(typeof old.routines).toBe('string');
    expect(old.routines).not.toContain('local-head');
    expect(() => JSON.parse(old.routines)).toThrow();
    const current = run();
    const actual = await current.result;
    expect(current.routines).toHaveBeenCalledWith({ installSlug: 'target', name: 'git-sync', limit: 1 });
    expect(current.locks).toHaveBeenCalledWith({ resource: 'git-sync:target' });
    expect(actual.routine).toMatchObject({ found: true, totalMatches: 1, scopeComplete: true,
      localCommit: { headSha: 'local-head' }, remotePublication: 'not-measured',
      contentErrors: { total: 8169, omitted: 8168, artifact: 'git-sync/content-errors/full.json' } });
    expect(actual.lock.holders).toEqual([{ owner: 'correct-holder', mode: 'shared', status: 'held', expiresAt: null }]);
    expect(JSON.stringify(actual)).not.toContain('overwatch-wake');
  });

  it.each([{}, { installSlug: 'target' }, { installSlug: 'target', resource: 'git-sync:other' },
    { installSlug: '', resource: 'git-sync:' }])('rejects missing or mismatched invocation scope before reading: %j', async inputs => {
    const current = run(script, inputs);
    await expect(current.result).rejects.toThrow('Explicit installSlug');
    expect(current.routines).not.toHaveBeenCalled();
    expect(current.locks).not.toHaveBeenCalled();
  });

  it('preserves unmeasured fields instead of inventing zero counts or successful publication', async () => {
    const current = run(script, subject, [{ ...target, health: {} } as typeof target]);
    expect((await current.result).routine).toMatchObject({ contentErrors: { total: null, omitted: null, artifact: null },
      localCommit: { headSha: null, lastSyncedAt: null }, remotePublication: 'not-measured' });
  });

  it('reports an absent requested routine without substituting an unrelated row', async () => {
    const actual = await run(script, subject, [unrelated]).result;
    expect(actual.routine).toMatchObject({ found: false, totalMatches: 0, returnedMatches: 0 });
  });
});
