/**
 * tui_panes-handler.test.ts — the plugins:tui_panes TOOL HANDLER
 * (revive-plugin-system-2026-06-04 D-002). The pure resolver collectTuiPanes is
 * covered by tui_panes.test.ts; this file covers the handler glue around it:
 *
 *   - the grants-cache build loop: only plugins that contribute a tui-pane entry
 *     trigger a getGrantsForPluginInHarness lookup;
 *   - the per-plugin coercion `rows.length === 0 ? undefined : rows` (empty grant
 *     set → undefined → manifest-only two-tier fallback);
 *   - the catch → undefined branch when getGrantsForPluginInHarness throws
 *     (PG outage must NOT crash the tool — it degrades to manifest-only);
 *   - the JSON envelope `{ content: [{ type:'text', text: JSON.stringify({ panes }) }] }`.
 *
 * getPluginHost + getGrantsForPluginInHarness are mocked, so no PG and no live host.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plugins/tui_panes-handler.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

function parsePanes(result: { content: Array<{ type: string; text: string }> }): {
  panes: Array<Record<string, unknown>>;
} {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return JSON.parse(result.content[0].text);
}

// A loaded-plugin shape the handler reads: it iterates host.loaded and inspects
// plugin.ui for a tui-pane entry, plugin.name + plugin.version for the grants key.
function lp(opts: {
  name: string;
  version?: string;
  capabilities?: string[];
  ui?: Array<Record<string, unknown>>;
  path?: string;
}) {
  return {
    plugin: {
      name: opts.name,
      version: opts.version ?? '0.1.0',
      capabilities: opts.capabilities ?? [],
      ui: opts.ui,
    },
    path: opts.path ?? `/plugins/${opts.name}`,
  };
}

const TUI_CAPABLE = {
  name: 'demo',
  capabilities: ['ui:tui-pane', 'compute:exec:sh'],
  ui: [{ type: 'tui-pane', slug: 'logs', label: 'Logs', command: ['sh', 'render.sh'] }],
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../plugin-host-runtime');
  vi.doUnmock('../../plugin-grants');
});

async function loadHandler(opts: {
  loaded: ReturnType<typeof lp>[];
  grants: ReturnType<typeof vi.fn>;
}) {
  vi.doMock('../../plugin-host-runtime', () => ({
    getPluginHost: vi.fn(async () => ({ loaded: opts.loaded })),
  }));
  vi.doMock('../../plugin-grants', () => ({
    getGrantsForPluginInHarness: opts.grants,
  }));
  const { default: tool } = await import('./tui_panes');
  return tool;
}

describe('plugins:tui_panes handler — grants cache coercion', () => {
  it('empty grant rows ([]) coerce to undefined → manifest-only fallback surfaces the pane', async () => {
    const grants = vi.fn(async () => [] as string[]); // no per-(plugin,harness) grants
    const tool = await loadHandler({ loaded: [lp(TUI_CAPABLE)], grants });

    const result = await tool.handler({ harness: 'sheets' }, MAKE_CTX());
    const { panes } = parsePanes(result as never);

    // rows.length===0 → grantsCache holds undefined → collectTuiPanes uses the
    // manifest-only (two-tier) path, and the manifest IS fully capable here.
    expect(panes).toEqual([
      { pluginName: 'demo', slug: 'logs', label: 'Logs', command: ['sh', 'render.sh'], cwd: '/plugins/demo' },
    ]);
    // Lookup is keyed by the plugin's pinned version + the requested harness.
    expect(grants).toHaveBeenCalledWith('demo', '0.1.0', 'sheets');
  });

  it('a populated grant set that is MISSING the exec cap excludes the pane (tier-2 enforced)', async () => {
    // granted ui:tui-pane but NOT compute:exec:sh → the granted set gates it out
    const grants = vi.fn(async () => ['ui:tui-pane']);
    const tool = await loadHandler({ loaded: [lp(TUI_CAPABLE)], grants });

    const { panes } = parsePanes((await tool.handler({ harness: 'sheets' }, MAKE_CTX())) as never);
    expect(panes).toEqual([]);
  });

  it('a complete granted set surfaces the pane', async () => {
    const grants = vi.fn(async () => ['ui:tui-pane', 'compute:exec:sh']);
    const tool = await loadHandler({ loaded: [lp(TUI_CAPABLE)], grants });

    const { panes } = parsePanes((await tool.handler({ harness: 'sheets' }, MAKE_CTX())) as never);
    expect(panes.map((p) => p.slug)).toEqual(['logs']);
  });

  it('catch → undefined: a throwing getGrantsForPluginInHarness (PG outage) degrades to manifest-only, no crash', async () => {
    const grants = vi.fn(async () => {
      throw new Error('ECONNREFUSED — plugin_capability_grants unreadable');
    });
    const tool = await loadHandler({ loaded: [lp(TUI_CAPABLE)], grants });

    // Must NOT reject; the catch sets the cache entry to undefined → manifest-only.
    const { panes } = parsePanes((await tool.handler({ harness: 'sheets' }, MAKE_CTX())) as never);
    expect(panes.map((p) => p.slug)).toEqual(['logs']);
    expect(grants).toHaveBeenCalledTimes(1);
  });
});

describe('plugins:tui_panes handler — grants lookup gating', () => {
  it('does NOT query grants for a plugin with no tui-pane UI entry', async () => {
    const grants = vi.fn(async () => []);
    const loaded = [
      lp({ name: 'no-ui' }), // ui undefined → skipped
      lp({ name: 'react-only', ui: [{ type: 'react', slug: 'r', label: 'R' }] }), // no tui-pane → skipped
      lp(TUI_CAPABLE), // the only one that should be looked up
    ];
    const tool = await loadHandler({ loaded, grants });

    await tool.handler({ harness: 'sheets' }, MAKE_CTX());
    expect(grants).toHaveBeenCalledTimes(1);
    expect(grants).toHaveBeenCalledWith('demo', '0.1.0', 'sheets');
  });

  it('returns an empty panes envelope when no plugins are loaded', async () => {
    const grants = vi.fn(async () => []);
    const tool = await loadHandler({ loaded: [], grants });

    const result = await tool.handler({ harness: 'sheets' }, MAKE_CTX());
    const { panes } = parsePanes(result as never);
    expect(panes).toEqual([]);
    expect(grants).not.toHaveBeenCalled();
  });

  it('collects panes across multiple tui-capable plugins, each with its own grant lookup', async () => {
    const grants = vi.fn(async () => []); // empty → manifest-only for each
    const loaded = [
      lp({
        name: 'a',
        capabilities: ['ui:tui-pane', 'compute:exec:sh'],
        ui: [{ type: 'tui-pane', slug: 'a1', label: 'A1', command: ['sh'] }],
      }),
      lp({
        name: 'b',
        capabilities: [], // not capable → excluded by collectTuiPanes, but still grant-queried
        ui: [{ type: 'tui-pane', slug: 'b1', label: 'B1', command: ['sh'] }],
      }),
      lp({
        name: 'c',
        capabilities: ['ui:tui-pane', 'compute:exec:less'],
        ui: [{ type: 'tui-pane', slug: 'c1', label: 'C1', command: ['less', 'README'] }],
      }),
    ];
    const tool = await loadHandler({ loaded, grants });

    const { panes } = parsePanes((await tool.handler({ harness: 'sheets' }, MAKE_CTX())) as never);
    expect(panes.map((p) => `${p.pluginName}:${p.slug}`)).toEqual(['a:a1', 'c:c1']);
    // All three contribute a tui-pane entry, so all three are grant-queried.
    expect(grants).toHaveBeenCalledTimes(3);
  });
});
