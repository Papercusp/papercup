import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { _CURATED_FOR_TESTS } from './design-adapter-react-tailwind/registry';

const require_ = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ECOSYSTEM = 'react-tailwind';

type PluginEntry = {
  id: string;
  ecosystems?: Record<string, { sourcePointer?: { path?: string }; importHint?: string }>;
};

const plugin = require_(
  '../../../libs/papercusp/plugins/design-phase/index.cjs',
) as {
  tools: {
    search_registry: (input: { ecosystem?: string; query?: string }) => Promise<{
      content: Array<{ text: string }>;
    }>;
  };
  _internal: {
    listMemos: (status?: string) => Promise<Array<{ slug: string; source: string }>>;
  };
};

const pluginManifest = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'libs/papercusp/plugins/design-phase/papercusp.json'), 'utf8'),
) as {
  description: string;
  tools: Array<{ name: string; description?: string }>;
};

/** The plugin returns its FULL list for an empty query (searchRegistryEntries). */
async function allPluginEntries(): Promise<PluginEntry[]> {
  const response = await plugin.tools.search_registry({ ecosystem: ECOSYSTEM, query: '' });
  return (JSON.parse(response.content[0].text) as { results: PluginEntry[] }).results;
}

async function search(query: string) {
  const response = await plugin.tools.search_registry({
    ecosystem: 'react-tailwind',
    query,
  });
  return JSON.parse(response.content[0].text) as {
    ecosystem: string;
    results: Array<{ id: string }>;
  };
}

describe('design-phase plugin registry search', () => {
  it('matches recognized terms in a product-level multi-word query', async () => {
    const result = await search('Seller dock controls');

    expect(result.results.map((entry) => entry.id)).toEqual([
      'control.select',
      'control.checkbox',
    ]);
  });

  it('keeps recognized query terms conjunctive', async () => {
    const result = await search('primary button');

    expect(result.results.map((entry) => entry.id)).toEqual(['action.primary']);
  });

  it('returns no results when no query term is in the registry vocabulary', async () => {
    const result = await search('Seller dock');

    expect(result.results).toEqual([]);
  });
});

describe('design-phase memo projection (EI-21339929518770631)', () => {
  it('reads memos from the canonical operator-docs source tree', async () => {
    const memos = await plugin._internal.listMemos('any');
    const sources = memos.map((memo) => memo.source.replaceAll('\\', '/'));

    expect(memos.length).toBeGreaterThan(0);
    expect(memos.some((memo) => memo.slug === 'design-phase-plan')).toBe(true);
    expect(sources.every((source) => source.includes('/apps/operator-docs/src/content/docs/design/'))).toBe(true);
    expect(sources.some((source) => source.includes('/apps/operator/content/'))).toBe(false);
  });

  it('describes the canonical projection path in the plugin manifest', () => {
    const listMemos = pluginManifest.tools.find((tool) => tool.name === 'list_memos');

    expect(pluginManifest.description).toContain(
      'apps/operator-docs/src/content/docs/design/design-phase-plan.mdx',
    );
    expect(listMemos?.description).toContain('apps/operator-docs/src/content/docs/design/*.mdx');
    expect(listMemos?.description).not.toContain('apps/operator/content/internal-docs');
  });
});

/**
 * EI-21213360212584785. The plugin ships its OWN copy of the component registry
 * (`REGISTRY_REACT_TAILWIND`, whose comment calls itself a "mirror of
 * apps/operator/lib/design-adapter-react-tailwind"). It is a hand-maintained second
 * copy of a truth the code owns, so it drifted: the canonical registry moved to
 * `apps/operator/app/harness/*` on 2026-06-18, and the plugin was left pointing every
 * component at `libs/papercusp/apps/web/app/harness/*.tsx` — a directory that does not
 * exist — behind `import … from '@papercusp/ui'`, a package that is not in the tree and
 * is not a dependency of apps/operator (its real one is @papercusp/ui-primitives, which
 * exports no Banner). A designer following search_registry got a dead path and an
 * uninstallable import.
 *
 * The suite above could not see it: it only asserts which ids a QUERY matches, never
 * what those entries point AT. These two guards close that, on the two axes that can
 * rot independently:
 *   1. against the FILESYSTEM — a pointer must name a file that exists. This one cannot
 *      drift with the canonical registry because reality is its reference.
 *   2. against the CANONICAL registry — where both define an id, they must agree.
 * The plugin deliberately mirrors only a SUBSET of canonical, so parity is asserted on
 * the intersection; guard 1 still covers any entry the plugin adds later.
 */
describe('design-phase plugin registry pointers (EI-21213360212584785)', () => {
  it('every sourcePointer names a file that exists in the tree', async () => {
    const entries = await allPluginEntries();
    // Non-vacuity: an empty registry would satisfy every assertion below.
    expect(entries.length).toBeGreaterThan(0);

    const checked = entries.map((entry) => {
      const path = entry.ecosystems?.[ECOSYSTEM]?.sourcePointer?.path;
      return { id: entry.id, path, exists: !!path && existsSync(resolve(REPO_ROOT, path)) };
    });
    // Positive control on the instrument itself: REPO_ROOT must really be the repo, or
    // existsSync would report false for everything and this suite would "pass" by
    // failing loudly for the wrong reason.
    expect(existsSync(resolve(REPO_ROOT, 'package.json'))).toBe(true);
    expect(checked.filter((c) => !c.exists)).toEqual([]);
  });

  it('agrees with the canonical registry on every id they both define', async () => {
    const entries = await allPluginEntries();
    const canonical = new Map(_CURATED_FOR_TESTS.map((e) => [e.id, e]));

    const shared = entries.filter((e) => canonical.has(e.id));
    // Non-vacuity: if the ids ever stop overlapping, this guard silently checks nothing.
    expect(shared.length).toBeGreaterThan(0);

    const divergent = shared.flatMap((entry) => {
      const mine = entry.ecosystems?.[ECOSYSTEM];
      const theirs = canonical.get(entry.id)!.ecosystems[ECOSYSTEM];
      const same =
        mine?.sourcePointer?.path === theirs?.sourcePointer?.path &&
        mine?.importHint === theirs?.importHint;
      return same
        ? []
        : [{ id: entry.id, plugin: mine?.sourcePointer?.path, canonical: theirs?.sourcePointer?.path }];
    });
    expect(divergent).toEqual([]);
  });
});
