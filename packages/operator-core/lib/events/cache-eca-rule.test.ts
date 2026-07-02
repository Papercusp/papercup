/**
 * cache↔change-stream ECA rule (caching-layer-tag-eca-2026-06-22 P-004).
 *
 * Exercises the WHOLE in-process path with NO mocks on the dispatch/cache side:
 *   emitSystemEvent(<table>.changed) → registry match (wildcard '*.changed' key)
 *     → runReactions → fireReactionInProcess → built-in `cache.bumpTags`
 *     → the operator's (injected, in-memory) Cache.invalidateByTags.
 *
 * Only the FLAG backend is stubbed (no PostHog) — the rule reads a sync-cached
 * CACHE_TAG_ECA, forced ON here. The cache is the REAL `@papercusp/cache`,
 * injected via setOperatorCache so the assertions read the actual generation
 * bumps + a real `getOrSet` entry going stale.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { Cache, InMemoryGenerationStore } from '@papercusp/cache';

import { emitSystemEvent } from './engine';
import { _resetReactionsForTests, listReactionRules, reactionGraph } from './registry';
import { registerCacheTagEcaRule, _refreshCacheEcaForTests, CACHE_TAG_ECA_RULE_ID, tableNameFromChangedEvent, tagsForTableChange } from './cache-eca-rule';
import { installOperatorCache, resetOperatorCacheForTests } from '../cache/instance';
import { fireBuiltinReactionAction, isBuiltinReactionAction, CACHE_BUMP_TAGS_ACTION } from './builtin-actions';

/** Let the void-scheduled async reaction (sync mode → in-process) settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A spy-wrapped Cache so we can assert the exact (workspace, tags) bumpTags ran with. */
function makeSpyCache(): { cache: Cache; bumps: Array<{ workspaceId: string; tags: readonly string[] }> } {
  const cache = new Cache({ generationStore: new InMemoryGenerationStore() });
  const bumps: Array<{ workspaceId: string; tags: readonly string[] }> = [];
  const orig = cache.invalidateByTags.bind(cache);
  cache.invalidateByTags = (workspaceId: string, tags: readonly string[]): void => {
    bumps.push({ workspaceId, tags: [...tags] });
    orig(workspaceId, tags);
  };
  return { cache, bumps };
}

beforeEach(async () => {
  _resetReactionsForTests();
  resetOperatorCacheForTests();
  setFlagOverridesForTest({ 'papercusp-cache-tag-eca': true });
  await _refreshCacheEcaForTests();
  registerCacheTagEcaRule();
});

afterEach(() => {
  setFlagOverridesForTest(null);
  resetOperatorCacheForTests();
});

describe('tag scheme (pure)', () => {
  it('strips <schema>. and .changed → base table; derives [table, table:id]', () => {
    expect(tableNameFromChangedEvent('harness_shared.harness_plans.changed')).toBe('harness_plans');
    expect(tableNameFromChangedEvent('harness_plans.changed')).toBe('harness_plans');
    expect(tableNameFromChangedEvent('coord:handoff')).toBeNull();
    expect(tagsForTableChange('harness_plans', 'PL-7')).toEqual(['harness_plans', 'harness_plans:PL-7']);
    // No row PK ⇒ only the table-level tag (table-wide invalidation).
    expect(tagsForTableChange('harness_plans', undefined)).toEqual(['harness_plans']);
  });
});

describe('built-in cache.bumpTags action', () => {
  it('is a recognised built-in action (not a projected tool)', () => {
    expect(isBuiltinReactionAction(CACHE_BUMP_TAGS_ACTION)).toBe(true);
    expect(isBuiltinReactionAction('coord:handoff')).toBe(false);
  });

  it('invalidates the given tags on the operator cache for the workspace', async () => {
    const { cache, bumps } = makeSpyCache();
    installOperatorCache(cache);
    const r = await fireBuiltinReactionAction(CACHE_BUMP_TAGS_ACTION, { tags: ['harness_plans', 'harness_plans:PL-7'] }, 'w1');
    expect(r.ok).toBe(true);
    expect(bumps).toEqual([{ workspaceId: 'w1', tags: ['harness_plans', 'harness_plans:PL-7'] }]);
  });

  it('empty tags is a no-op (ok, no bump)', async () => {
    const { cache, bumps } = makeSpyCache();
    installOperatorCache(cache);
    expect((await fireBuiltinReactionAction(CACHE_BUMP_TAGS_ACTION, { tags: [] }, 'w1')).ok).toBe(true);
    expect(bumps).toHaveLength(0);
  });
});

describe('the rule is registered on the wildcard key', () => {
  it('appears in the registry + reactive graph on *.changed → cache.bumpTags', () => {
    const rule = listReactionRules().find((r) => r.id === CACHE_TAG_ECA_RULE_ID);
    expect(rule).toBeDefined();
    expect(rule?.fire).toBe(CACHE_BUMP_TAGS_ACTION);
    expect(reactionGraph()).toContainEqual({ on: '*.changed', ruleId: CACHE_TAG_ECA_RULE_ID, fire: CACHE_BUMP_TAGS_ACTION });
  });
});

describe('end-to-end: a <table>.changed event invalidates the affected cache tags', () => {
  it('dispatching <table>.changed invokes cache.bumpTags with the right (workspace, tags)', async () => {
    const { cache, bumps } = makeSpyCache();
    installOperatorCache(cache);

    emitSystemEvent({
      tool: 'harness_shared.harness_plans.changed',
      args: { workspace_id: 'w1', op: 'UPDATE', id: 'PL-7' },
      workspaceId: 'w1',
    });
    await flush();

    expect(bumps).toEqual([{ workspaceId: 'w1', tags: ['harness_plans', 'harness_plans:PL-7'] }]);
  });

  it('a getOrSet entry tagged <table>:<id> is STALE on the next read after the event (rebuilt)', async () => {
    const cache = new Cache({ generationStore: new InMemoryGenerationStore() });
    installOperatorCache(cache);

    let builds = 0;
    const factory = async (): Promise<string> => {
      builds++;
      return `value-${builds}`;
    };

    // Warm the cache: a row-scoped read tagged with the row tag.
    const first = await cache.getOrSet('w1', 'plan:PL-7', factory, { tags: ['harness_plans:PL-7'] });
    expect(first).toBe('value-1');
    expect(builds).toBe(1);
    // A second read before any change is a fresh hit — no rebuild.
    expect(await cache.getOrSet('w1', 'plan:PL-7', factory, { tags: ['harness_plans:PL-7'] })).toBe('value-1');
    expect(builds).toBe(1);

    // The change event flows through the reaction engine → cache.bumpTags.
    emitSystemEvent({
      tool: 'harness_shared.harness_plans.changed',
      args: { workspace_id: 'w1', op: 'UPDATE', id: 'PL-7' },
      workspaceId: 'w1',
    });
    await flush();

    // Next read sees the bumped generation → the entry is dead → rebuilds.
    const afterChange = await cache.getOrSet('w1', 'plan:PL-7', factory, { tags: ['harness_plans:PL-7'] });
    expect(afterChange).toBe('value-2');
    expect(builds).toBe(2);
  });

  it('a change to a DIFFERENT row does not stale this row’s entry (workspace-scoped, row-precise)', async () => {
    const cache = new Cache({ generationStore: new InMemoryGenerationStore() });
    installOperatorCache(cache);

    let builds = 0;
    const factory = async (): Promise<string> => `value-${++builds}`;
    await cache.getOrSet('w1', 'plan:PL-7', factory, { tags: ['harness_plans:PL-7'] });
    expect(builds).toBe(1);

    // A change to PL-8 bumps ['harness_plans', 'harness_plans:PL-8'] — the row tag differs,
    // but the TABLE-level tag is NOT one this entry carries, so it stays fresh.
    emitSystemEvent({
      tool: 'harness_shared.harness_plans.changed',
      args: { workspace_id: 'w1', op: 'UPDATE', id: 'PL-8' },
      workspaceId: 'w1',
    });
    await flush();

    expect(await cache.getOrSet('w1', 'plan:PL-7', factory, { tags: ['harness_plans:PL-7'] })).toBe('value-1');
    expect(builds).toBe(1);
  });

  it('a TABLE-tagged (list) entry IS staled by any row change (the table tag is always bumped)', async () => {
    const cache = new Cache({ generationStore: new InMemoryGenerationStore() });
    installOperatorCache(cache);

    let builds = 0;
    const factory = async (): Promise<string> => `list-${++builds}`;
    await cache.getOrSet('w1', 'plans:list', factory, { tags: ['harness_plans'] });
    expect(builds).toBe(1);

    emitSystemEvent({
      tool: 'harness_shared.harness_plans.changed',
      args: { workspace_id: 'w1', op: 'INSERT', id: 'PL-9' },
      workspaceId: 'w1',
    });
    await flush();

    expect(await cache.getOrSet('w1', 'plans:list', factory, { tags: ['harness_plans'] })).toBe('list-2');
    expect(builds).toBe(2);
  });

  it('OFF (flag) ⇒ no cache.bumpTags fires (rule no-ops)', async () => {
    setFlagOverridesForTest({ 'papercusp-cache-tag-eca': false });
    await _refreshCacheEcaForTests();

    const { cache, bumps } = makeSpyCache();
    installOperatorCache(cache);

    emitSystemEvent({
      tool: 'harness_shared.harness_plans.changed',
      args: { workspace_id: 'w1', op: 'UPDATE', id: 'PL-7' },
      workspaceId: 'w1',
    });
    await flush();

    expect(bumps).toHaveLength(0);
  });

  it('a non-table tool event never matches the wildcard rule', async () => {
    const { cache, bumps } = makeSpyCache();
    installOperatorCache(cache);

    // A regular tool event (not *.changed) must not match the '*.changed' rule.
    emitSystemEvent({ tool: 'coord:handoff', args: { summary: 'x' }, workspaceId: 'w1' });
    await flush();

    expect(bumps).toHaveLength(0);
  });
});
