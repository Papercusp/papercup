/**
 * pack-catalog — pure assembly of the live pack catalog
 * (tool-distribution-granularity-2026-06-05 P-002/D-006). The IO wrapper
 * (`derivePackCatalog`) is a thin delegate; everything decision-bearing is in
 * `assemblePackCatalog` + the helpers, covered here with injected snapshots.
 */
import { describe, expect, it } from 'vitest';
import { resolveToolProvider } from '@papercusp/blueprint-distribution';
import {
  assemblePackCatalog,
  depHostSetsFromCatalog,
  manifestToolNames,
  parseProvidesTools,
  shortUnitName,
  type PackCatalogInputs,
} from '../pack-catalog';

const INPUTS = (over: Partial<PackCatalogInputs> = {}): PackCatalogInputs => ({
  installed: [],
  projectedTools: [],
  legacyCatalogNames: [],
  cupboardUnits: [],
  cupboardReachable: true,
  ...over,
});

describe('shortUnitName / manifestToolNames', () => {
  it('drops the npm scope prefix', () => {
    expect(shortUnitName('@papercupai/repomix')).toBe('repomix');
    expect(shortUnitName('repomix')).toBe('repomix');
  });

  it('derives manifest tool names with the loader convention + mcp override', () => {
    expect(
      manifestToolNames({
        name: '@papercupai/git-tools',
        tools: [
          { name: 'blame' },
          { name: 'churn', expose: { mcp: { name: 'custom.churn' } } },
          null,
          { notName: true } as never,
        ],
      }),
    ).toEqual(['git-tools.blame', 'custom.churn']);
  });
});

describe('parseProvidesTools', () => {
  it('accepts an array, a JSON string, and rejects junk', () => {
    expect(parseProvidesTools(['a.b', 'c.d'])).toEqual(['a.b', 'c.d']);
    expect(parseProvidesTools('["a.b","c.d"]')).toEqual(['a.b', 'c.d']);
    expect(parseProvidesTools('not json')).toEqual([]);
    expect(parseProvidesTools(null)).toEqual([]);
    expect(parseProvidesTools(42)).toEqual([]);
    expect(parseProvidesTools(['ok', 7, '', null])).toEqual(['ok']);
  });
});

describe('assemblePackCatalog', () => {
  it('splits projected tools into built-ins (agent-mcp) and per-unit groups', () => {
    const cat = assemblePackCatalog(
      INPUTS({
        legacyCatalogNames: ['plans:list'],
        projectedTools: [
          { pluginName: 'agent-mcp', mcpName: 'coord:send' },
          { pluginName: 'repomix', mcpName: 'repomix.pack' },
        ],
        installed: [{ name: 'repomix', version: '1.0.0' }],
      }),
    );
    expect(cat.builtinTools).toEqual(new Set(['plans:list', 'coord:send']));
    expect(cat.view.installedToolIndex.get('repomix.pack')?.name).toBe('repomix');
    expect(resolveToolProvider('coord:send', cat.view)).toMatchObject({ status: 'available', provider: { kind: 'builtin' } });
  });

  it('prefers live-registered tool names over manifest declarations, falls back to manifest', () => {
    const cat = assemblePackCatalog(
      INPUTS({
        installed: [
          { name: 'loaded-plugin', tools: [{ name: 'stale' }] },
          { name: 'unloaded-pack', kind: 'pack', tools: [{ name: 'scan' }] },
        ],
        projectedTools: [{ pluginName: 'loaded-plugin', mcpName: 'loaded-plugin.fresh' }],
      }),
    );
    expect(cat.view.byName.get('loaded-plugin')?.tools).toEqual(['loaded-plugin.fresh']);
    expect(cat.view.byName.get('unloaded-pack')?.tools).toEqual(['unloaded-pack.scan']);
  });

  it('marks kind=pack manifests runtime-less; everything else runtime-bearing', () => {
    const cat = assemblePackCatalog(
      INPUTS({
        installed: [
          { name: 'a-pack', kind: 'pack' },
          { name: 'a-plugin' },
        ],
      }),
    );
    expect(cat.view.byName.get('a-pack')).toMatchObject({ kind: 'pack', hasRuntime: false });
    expect(cat.view.byName.get('a-plugin')).toMatchObject({ kind: 'plugin', hasRuntime: true });
  });

  it('attributes live-registered units with no manifest on disk', () => {
    const cat = assemblePackCatalog(
      INPUTS({ projectedTools: [{ pluginName: 'dev-only', mcpName: 'dev-only.x' }] }),
    );
    expect(cat.view.byName.get('dev-only')).toMatchObject({ source: 'installed', kind: 'plugin' });
  });

  it('cupboard units resolve installable; installed copies shadow their listings', () => {
    const cat = assemblePackCatalog(
      INPUTS({
        installed: [{ name: 'repomix' }],
        projectedTools: [{ pluginName: 'repomix', mcpName: 'repomix.pack' }],
        cupboardUnits: [
          { name: 'repomix', kind: 'plugin', listingId: 'l-r', providesTools: ['repomix.pack'] },
          { name: 'firecrawl', kind: 'plugin', listingId: 'l-f', providesTools: ['firecrawl.scrape'] },
        ],
      }),
    );
    expect(resolveToolProvider('repomix.pack', cat.view)).toMatchObject({ status: 'available' });
    expect(resolveToolProvider('firecrawl.scrape', cat.view)).toMatchObject({
      status: 'installable',
      provider: { name: 'firecrawl', listingId: 'l-f' },
    });
  });
});

describe('depHostSetsFromCatalog', () => {
  it('projects the catalog into the dep-validator host sets', () => {
    const cat = assemblePackCatalog(
      INPUTS({
        legacyCatalogNames: ['plans:list'],
        installed: [
          { name: 'repomix' },
          { name: 'git-tools', kind: 'pack', tools: [{ name: 'blame' }] },
        ],
        projectedTools: [{ pluginName: 'repomix', mcpName: 'repomix.pack' }],
        cupboardUnits: [
          { name: 'firecrawl', kind: 'plugin', listingId: 'l-f', providesTools: ['firecrawl.scrape'] },
          { name: 'audit-pack', kind: 'pack', listingId: 'l-a', providesTools: ['audit-pack.scan'] },
        ],
      }),
    );
    const sets = depHostSetsFromCatalog(cat);
    expect(sets.availableTools).toEqual(new Set(['plans:list', 'repomix.pack', 'git-tools.blame']));
    expect(sets.installedPlugins).toEqual(new Set(['repomix']));
    expect(sets.installedPacks).toEqual(new Set(['git-tools']));
    expect(sets.cupboardPlugins).toEqual(new Set(['firecrawl']));
    expect(sets.cupboardPacks).toEqual(new Set(['audit-pack']));
    expect(sets.installableToolProviders?.get('firecrawl.scrape')).toEqual({ kind: 'plugin', name: 'firecrawl' });
    expect(sets.installableToolProviders?.get('audit-pack.scan')).toEqual({ kind: 'pack', name: 'audit-pack' });
  });

  it('P-012↔P-013: threads the workspace registered datatype names into availableDatatypes', () => {
    const cat = assemblePackCatalog(INPUTS({ legacyCatalogNames: ['plans:list'] }));
    // Default ⇒ empty (no datatype registered): byte-identical for pure-validation callers.
    expect(depHostSetsFromCatalog(cat).availableDatatypes).toEqual(new Set());
    // DB-aware callers pass the registry's names so a blueprint's dependencies.datatypes resolve.
    expect(depHostSetsFromCatalog(cat, ['bet', 'forecast']).availableDatatypes).toEqual(new Set(['bet', 'forecast']));
  });
});
