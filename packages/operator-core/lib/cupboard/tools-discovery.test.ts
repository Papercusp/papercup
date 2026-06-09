/**
 * Tools-discovery projection tests (tool-distribution-granularity P-006).
 *
 * Built over the PURE assembler (`assemblePackCatalog`) so the test doubles as
 * a contract check between pack-catalog's derived view and the discovery
 * payload the marketplace Tools section renders:
 *
 *   - every known tool appears exactly once, resolved through the ladder
 *     (installed unit ▸ builtin ▸ cupboard listing);
 *   - an installed unit shadows the Cupboard listing claiming the same tool;
 *   - installable entries carry the providing listing (id + kind) so the UI
 *     can offer the install action;
 *   - q/status filters narrow without breaking counts.
 */
import { describe, it, expect } from 'vitest';
import { assemblePackCatalog, type PackCatalogInputs } from './pack-catalog';
import {
  buildToolsDiscovery,
  buildToolProvenance,
  resolveToolEntries,
  type ToolMetaIndex,
} from './tools-discovery';

function makeInputs(over: Partial<PackCatalogInputs> = {}): PackCatalogInputs {
  return {
    installed: [
      {
        name: '@papercupai/repomix',
        version: '1.2.0',
        description: 'Repo packer',
        kind: 'plugin',
        tools: [{ name: 'pack' }],
      },
    ],
    projectedTools: [
      { pluginName: 'agent-mcp', mcpName: 'coord:send' },
      { pluginName: '@papercupai/repomix', mcpName: 'repomix.pack' },
    ],
    legacyCatalogNames: ['plans:get'],
    cupboardUnits: [
      {
        name: 'markdown-tools',
        kind: 'pack',
        listingId: 'lst-1',
        providesTools: ['md.render', 'md.lint'],
        description: 'Markdown helpers',
      },
      {
        name: 'slack-notify',
        kind: 'plugin',
        listingId: 'lst-2',
        providesTools: ['slack.send'],
      },
    ],
    cupboardReachable: true,
    ...over,
  };
}

describe('buildToolsDiscovery', () => {
  it('lists every known tool once, sorted, with resolved providers', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()));
    const names = payload.tools.map((t) => t.tool);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining(['plans:get', 'coord:send', 'repomix.pack', 'md.render', 'md.lint', 'slack.send']),
    );
    expect(payload.counts).toEqual({ available: 3, installable: 3 });
    expect(payload.cupboardReachable).toBe(true);
  });

  it('builtin tools resolve available with no unit', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()));
    const coord = payload.tools.find((t) => t.tool === 'coord:send');
    expect(coord).toMatchObject({ status: 'available', provider: { kind: 'builtin' } });
    expect(coord?.unit).toBeUndefined();
    const plans = payload.tools.find((t) => t.tool === 'plans:get');
    expect(plans?.provider.kind).toBe('builtin');
  });

  it('an installed plugin tool resolves available with its unit descriptor', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()));
    const repomix = payload.tools.find((t) => t.tool === 'repomix.pack');
    expect(repomix).toMatchObject({
      status: 'available',
      provider: { kind: 'plugin', name: '@papercupai/repomix' },
      unit: { source: 'installed', kind: 'plugin', version: '1.2.0' },
    });
  });

  it('a Cupboard-only tool resolves installable, carrying the providing listing', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()));
    const md = payload.tools.find((t) => t.tool === 'md.render');
    expect(md).toMatchObject({
      status: 'installable',
      provider: { kind: 'pack', name: 'markdown-tools', listingId: 'lst-1' },
      unit: { source: 'cupboard', kind: 'pack', listingId: 'lst-1', description: 'Markdown helpers' },
    });
    const slack = payload.tools.find((t) => t.tool === 'slack.send');
    expect(slack?.provider).toMatchObject({ kind: 'plugin', name: 'slack-notify', listingId: 'lst-2' });
  });

  it('an installed unit shadows a Cupboard listing claiming the same tool', () => {
    const inputs = makeInputs({
      cupboardUnits: [
        { name: 'repomix-listing', kind: 'plugin', listingId: 'lst-9', providesTools: ['repomix.pack'] },
      ],
    });
    const payload = buildToolsDiscovery(assemblePackCatalog(inputs));
    const repomix = payload.tools.find((t) => t.tool === 'repomix.pack');
    expect(repomix?.status).toBe('available');
    expect(repomix?.provider.name).toBe('@papercupai/repomix');
  });

  it('q filter matches tool name OR providing unit name, case-insensitively', () => {
    const cat = assemblePackCatalog(makeInputs());
    const byTool = buildToolsDiscovery(cat, { q: 'MD.' });
    expect(byTool.tools.map((t) => t.tool)).toEqual(['md.lint', 'md.render']);
    const byUnit = buildToolsDiscovery(cat, { q: 'slack-notify' });
    expect(byUnit.tools.map((t) => t.tool)).toEqual(['slack.send']);
  });

  it('status filter narrows to one resolution status and counts follow', () => {
    const cat = assemblePackCatalog(makeInputs());
    const installable = buildToolsDiscovery(cat, { status: 'installable' });
    expect(installable.tools.every((t) => t.status === 'installable')).toBe(true);
    expect(installable.counts).toEqual({ available: 0, installable: 3 });
  });

  it('propagates cupboardReachable=false for the degraded banner', () => {
    const cat = assemblePackCatalog(makeInputs({ cupboardUnits: [], cupboardReachable: false }));
    expect(buildToolsDiscovery(cat).cupboardReachable).toBe(false);
  });
});

describe('buildToolsDiscovery — categories (P-007 facets)', () => {
  it('faceted by namespace, busiest first then alphabetical', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()));
    // md.render + md.lint → md(2); the rest one each.
    expect(payload.categories[0]).toEqual({ name: 'md', count: 2 });
    const names = payload.categories.map((c) => c.name);
    expect(names).toEqual(['md', 'coord', 'plans', 'repomix', 'slack']);
  });

  it('a category filter narrows the tools but the facets stay over the full search set', () => {
    const cat = assemblePackCatalog(makeInputs());
    const payload = buildToolsDiscovery(cat, { category: 'md' });
    expect(payload.tools.map((t) => t.tool)).toEqual(['md.lint', 'md.render']);
    expect(payload.counts).toEqual({ available: 0, installable: 2 });
    // facets are computed pre-narrow → still every category, so the UI can switch.
    expect(payload.categories.map((c) => c.name)).toContain('coord');
  });

  it('every entry carries its category', () => {
    const entries = resolveToolEntries(assemblePackCatalog(makeInputs()));
    expect(entries.find((e) => e.tool === 'coord:send')?.category).toBe('coord');
    expect(entries.find((e) => e.tool === 'md.render')?.category).toBe('md');
  });
});

describe('buildToolsDiscovery — capability search over descriptions (P-005)', () => {
  const meta: ToolMetaIndex = new Map([
    ['coord:send', { description: 'send a message to a peer', capability: 'coord:write' }],
    ['repomix.pack', { description: 'pack a repo into one document', capability: null }],
  ]);

  it('enriches built-in entries with description + capability from the meta index', () => {
    const entries = resolveToolEntries(assemblePackCatalog(makeInputs()), meta);
    const coord = entries.find((e) => e.tool === 'coord:send');
    expect(coord?.description).toBe('send a message to a peer');
    expect(coord?.capability).toBe('coord:write');
  });

  it('finds a tool by a capability word only present in its description', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()), { q: 'message' }, meta);
    expect(payload.tools.map((t) => t.tool)).toEqual(['coord:send']);
  });

  it('a Cupboard-only tool falls back to its unit description when meta is absent', () => {
    const entries = resolveToolEntries(assemblePackCatalog(makeInputs()), meta);
    const md = entries.find((e) => e.tool === 'md.render');
    expect(md?.description).toBe('Markdown helpers'); // from the markdown-tools unit
  });
});

describe('buildToolProvenance — "what provides X" (P-006)', () => {
  it('resolves an exact tool name to its providing unit + install action', () => {
    const payload = buildToolProvenance(assemblePackCatalog(makeInputs()), { tool: 'md.render' });
    expect(payload.resolved?.tool).toBe('md.render');
    expect(payload.resolved).toMatchObject({
      status: 'installable',
      provider: { kind: 'pack', name: 'markdown-tools', listingId: 'lst-1' },
    });
    expect(payload.matches[0]?.tool).toBe('md.render'); // exact resolution leads
  });

  it('answers a capability phrase with ranked candidate providers', () => {
    const payload = buildToolProvenance(assemblePackCatalog(makeInputs()), { q: 'markdown' });
    expect(payload.resolved).toBeNull();
    expect(payload.matches.map((m) => m.tool)).toEqual(expect.arrayContaining(['md.render', 'md.lint']));
  });

  it('an unknown tool name resolves to null (no fabricated resolution)', () => {
    // a name with no token overlap → null resolved + no capability matches
    const payload = buildToolProvenance(assemblePackCatalog(makeInputs()), { tool: 'zzz.qqq' });
    expect(payload.resolved).toBeNull();
    expect(payload.matches).toEqual([]);
  });
});
