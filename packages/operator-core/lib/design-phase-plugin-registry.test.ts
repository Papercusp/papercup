import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const plugin = require_(
  '../../../libs/papercusp/plugins/design-phase/index.cjs',
) as {
  tools: {
    search_registry: (input: { ecosystem?: string; query?: string }) => Promise<{
      content: Array<{ text: string }>;
    }>;
  };
};

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
